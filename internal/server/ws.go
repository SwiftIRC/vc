// Package server binds rooms to HTTP/WebSocket transport.
package server

import (
	"context"
	"errors"
	"log/slog"
	"runtime/debug"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/ryanwohara/webrtc-chat/internal/signal"
)

// sendQueueCap bounds each connection's outbound frame backlog. Generous so a brief
// slow-read moment — a screenshare's video flooding a receiver's downlink, which shares
// the path with these control frames — doesn't overflow and evict a live peer.
const sendQueueCap = 128

// readLimit bounds a single inbound frame. It must comfortably exceed the largest
// signaling frame — an SDP offer/answer — because in an SFU a peer's SDP grows one
// m-line per forwarded track, so a group call with screenshares easily produces
// offers/answers of tens of KB. The old 16 KiB cap silently rejected those the moment
// a screenshare pushed a renegotiation over it: coder/websocket closed the socket with
// "message too big", the client reconnected as a fresh guest, and any ad-hoc/guest op
// was lost. 1 MiB fits hundreds of m-lines while still bounding a malicious frame.
const readLimit = 1 << 20

var (
	pingInterval = 20 * time.Second
	// writeTimeout and pongTimeout are deliberately generous (not the usual few seconds).
	// A screenshare saturates the sharer's UPLINK (delaying its keepalive pong) AND every
	// receiver's DOWNLINK (delaying the offer/answer/candidate frames the server writes
	// them) for the seconds it takes congestion control to settle. A tight deadline there
	// evicts a perfectly live peer, forcing a reconnect — which is what fired the join
	// chime and (before op-persistence) dropped mid-call op. Only a genuinely dead peer
	// stays silent this long, and the ping still evicts those.
	writeTimeout = 15 * time.Second
	pongTimeout  = 15 * time.Second
)

// drainTimeout bounds how long writePump keeps flushing already-queued frames
// after Close is requested, so a final frame is delivered without letting a
// dead peer stall shutdown.
var drainTimeout = 2 * time.Second

// wsClient adapts a websocket.Conn to room.Conn: a bounded, non-blocking
// send queue drained by writePump, with ping-based dead-peer eviction.
type wsClient struct {
	conn   *websocket.Conn
	log    *slog.Logger
	send   chan []byte
	ctx    context.Context
	cancel context.CancelFunc
	once   sync.Once
}

func newWSClient(conn *websocket.Conn, log *slog.Logger) *wsClient {
	ctx, cancel := context.WithCancel(context.Background())
	return &wsClient{
		conn: conn, log: log,
		send: make(chan []byte, sendQueueCap),
		ctx:  ctx, cancel: cancel,
	}
}

// Send encodes and enqueues. false = queue overflow (slow consumer); the
// caller (Room) responds by closing this client. Encoding failures are
// programming errors: logged, reported as delivered so the peer isn't
// punished for our bug.
func (c *wsClient) Send(v any) bool {
	data, err := signal.Encode(v)
	if err != nil {
		c.log.Error("encode", "err", err)
		return true
	}
	select {
	case c.send <- data:
		return true
	case <-c.ctx.Done():
		return true // already closing; not an overflow
	default:
		// Backlog is full: the peer is reading slower than we produce. Room
		// responds by closing this client, so this is an eviction of a peer that
		// was (as far as we know) still connected — the reconnect we are hunting.
		c.log.Warn("evicting live peer", "reason", "send queue overflow", "cap", cap(c.send))
		return false
	}
}

func (c *wsClient) Close() {
	c.once.Do(func() { c.cancel() })
}

// CloseAfter closes the client after d. time.AfterFunc schedules c.Close (which
// is idempotent), so the notification frame flushes during d and the socket is
// then torn down deterministically.
func (c *wsClient) CloseAfter(d time.Duration) {
	time.AfterFunc(d, c.Close)
}

func (c *wsClient) done() <-chan struct{} { return c.ctx.Done() }

func (c *wsClient) writePump() {
	defer recoverGuard(c.log, "writePump")
	defer func() {
		c.cancel()
		c.conn.Close(websocket.StatusNormalClosure, "bye")
	}()
	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()
	for {
		select {
		case data := <-c.send:
			if err := c.writeFrame(data); err != nil {
				c.logClose("frame write", err)
				return
			}
		case <-ticker.C:
			pctx, cancel := context.WithTimeout(context.Background(), pongTimeout)
			err := c.conn.Ping(pctx)
			cancel()
			if err != nil {
				c.logClose("keepalive ping", err)
				return
			}
		case <-c.ctx.Done():
			c.drain()
			return
		}
	}
}

// writeFrame writes one frame with a bounded deadline. It derives from a fresh
// background context (not c.ctx) so a frame already dequeued still flushes even
// as Close cancels c.ctx. Returns the write error (nil on success) so writePump
// can log WHY it is tearing the socket down — a deadline-exceeded error is a
// live peer we could not reach in time, not a peer that left.
func (c *wsClient) writeFrame(data []byte) error {
	wctx, cancel := context.WithTimeout(context.Background(), writeTimeout)
	defer cancel()
	return c.conn.Write(wctx, websocket.MessageText, data)
}

// logClose records why writePump is tearing this socket down. A ping or frame
// write that fails with a deadline-exceeded error evicted a peer that was still
// connected but could not keep the control channel flowing within the timeout —
// the screenshare-contention / read-loop-stall reconnect we are hunting — so it
// is logged at Warn to stand out in a capture. Any other error is an ordinary
// departure (the client closed its socket), logged at Debug to avoid noise.
func (c *wsClient) logClose(op string, err error) {
	if errors.Is(err, context.DeadlineExceeded) {
		c.log.Warn("evicting live peer", "reason", op+" timed out", "err", err)
		return
	}
	c.log.Debug("peer socket closed", "reason", op, "err", err)
}

// drain flushes frames already queued when Close was requested, bounded by
// drainTimeout, so a final kicked/banned/server-restarting frame reaches the
// client before the socket closes.
func (c *wsClient) drain() {
	deadline := time.Now().Add(drainTimeout)
	for {
		select {
		case data := <-c.send:
			wctx, cancel := context.WithDeadline(context.Background(), deadline)
			err := c.conn.Write(wctx, websocket.MessageText, data)
			cancel()
			if err != nil {
				return
			}
		default:
			return
		}
		if !time.Now().Before(deadline) {
			return
		}
	}
}

// withTimeout derives a read context bounded by both the client lifetime
// and d.
func (c *wsClient) withTimeout(d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(c.ctx, d)
}

// readNext blocks for one client frame and decodes it.
func (c *wsClient) readNext(ctx context.Context) (any, error) {
	typ, data, err := c.conn.Read(ctx)
	if err != nil {
		return nil, err
	}
	if typ != websocket.MessageText {
		return nil, errors.New("server: binary frame rejected")
	}
	return signal.Decode(data)
}

// recoverGuard is the per-goroutine panic barrier: one connection's bug
// must never take down the process.
func recoverGuard(log *slog.Logger, where string) {
	if v := recover(); v != nil {
		log.Error("panic recovered", "where", where, "panic", v, "stack", string(debug.Stack()))
	}
}
