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

const sendQueueCap = 64

var (
	pingInterval = 20 * time.Second
	writeTimeout = 5 * time.Second
	// pongTimeout bounds a keepalive ping's round trip. It is much larger than
	// writeTimeout because the pong travels the client's UPLINK, which a screenshare's
	// video upload can saturate for a few seconds — a tight timeout there would evict a
	// perfectly live sharer, forcing a reconnect (and, pre-op-persistence, dropping any
	// mid-call op). Only a genuinely dead peer stays silent past this.
	pongTimeout = 15 * time.Second
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
			if !c.writeFrame(data) {
				return
			}
		case <-ticker.C:
			pctx, cancel := context.WithTimeout(context.Background(), pongTimeout)
			err := c.conn.Ping(pctx)
			cancel()
			if err != nil {
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
// as Close cancels c.ctx.
func (c *wsClient) writeFrame(data []byte) bool {
	wctx, cancel := context.WithTimeout(context.Background(), writeTimeout)
	defer cancel()
	return c.conn.Write(wctx, websocket.MessageText, data) == nil
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
