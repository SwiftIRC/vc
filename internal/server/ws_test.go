package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/SwiftIRC/coyote/internal/signal"
)

var testLog = slog.New(slog.NewTextHandler(&strings.Builder{}, nil))

// syncBuffer is an io.Writer safe for the writePump goroutine to log into while
// the test goroutine reads what has been captured so far.
type syncBuffer struct {
	mu  sync.Mutex
	buf strings.Builder
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.String()
}

// capturingLogger returns a Debug-level logger and the buffer it writes to, so a
// test can assert on the close-reason lines writePump emits.
func capturingLogger() (*slog.Logger, *syncBuffer) {
	sb := &syncBuffer{}
	return slog.New(slog.NewTextHandler(sb, &slog.HandlerOptions{Level: slog.LevelDebug})), sb
}

// wsPair spins up a server whose handler passes the accepted wsClient to fn,
// and returns a dialed client-side conn.
func wsPair(t *testing.T, fn func(c *wsClient)) *websocket.Conn {
	return wsPairLog(t, testLog, fn)
}

// wsPairLog is wsPair with an explicit logger, so a test can capture the
// close-reason diagnostics the accepted client emits.
func wsPairLog(t *testing.T, log *slog.Logger, fn func(c *wsClient)) *websocket.Conn {
	t.Helper()
	var wg sync.WaitGroup
	gotClient := make(chan *wsClient, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		conn.SetReadLimit(readLimit)
		c := newWSClient(conn, log)
		wg.Add(1)
		go func() { defer wg.Done(); c.writePump() }()
		gotClient <- c
		fn(c)
	}))
	// Tear down the accepted client and join its writePump so no
	// per-connection goroutine outlives this test. Without the join there is
	// no happens-before edge from a lingering writePump's read of the tunable
	// package vars to a later test that mutates them, which the race detector
	// (correctly) flags.
	t.Cleanup(func() {
		select {
		case c := <-gotClient:
			c.Close()
		default:
		}
		wg.Wait()
		srv.Close()
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	dial, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { dial.Close(websocket.StatusNormalClosure, "") })
	return dial
}

func TestSendDeliversTypedFrame(t *testing.T) {
	dial := wsPair(t, func(c *wsClient) {
		if !c.Send(signal.Joined{SelfID: "p1", Role: "op"}) {
			t.Error("Send returned false")
		}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, data, err := dial.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var env map[string]any
	json.Unmarshal(data, &env)
	if env["type"] != "joined" || env["selfId"] != "p1" {
		t.Errorf("frame = %s", data)
	}
}

// A screenshare renegotiation in a group call produces an SDP offer/answer well
// over the old 16 KiB read cap. The server must READ it, not close the socket —
// a rejected frame reconnected the client and dropped ad-hoc/guest op. Sends a
// ~65 KB frame (far above 16 KiB, far below readLimit) and asserts it arrives.
func TestLargeSignalFrameIsRead(t *testing.T) {
	got := make(chan any, 1)
	readErr := make(chan error, 1)
	dial := wsPair(t, func(c *wsClient) {
		v, err := c.readNext(context.Background())
		if err != nil {
			readErr <- err
			return
		}
		got <- v
	})
	bigSDP := strings.Repeat("a=x\r\n", 13000) // ~65 KB
	if len(bigSDP) < 16384 {
		t.Fatalf("test SDP must exceed the old 16 KiB cap, got %d", len(bigSDP))
	}
	frame, err := json.Marshal(map[string]any{"type": "offer", "sdp": bigSDP})
	if err != nil {
		t.Fatal(err)
	}
	if err := dial.Write(context.Background(), websocket.MessageText, frame); err != nil {
		t.Fatal(err)
	}
	select {
	case v := <-got:
		if off, ok := v.(*signal.Offer); !ok || off.SDP != bigSDP {
			t.Errorf("got %#v, want the offer intact", v)
		}
	case err := <-readErr:
		t.Fatalf("large SDP frame was rejected instead of read: %v", err)
	case <-time.After(3 * time.Second):
		t.Fatal("timeout waiting for the large frame")
	}
}

func TestReadNextDecodes(t *testing.T) {
	got := make(chan any, 1)
	dial := wsPair(t, func(c *wsClient) {
		v, err := c.readNext(context.Background())
		if err != nil {
			t.Error(err)
			return
		}
		got <- v
	})
	ctx := context.Background()
	dial.Write(ctx, websocket.MessageText, []byte(`{"type":"chat","text":"hi"}`))
	select {
	case v := <-got:
		if chat, ok := v.(*signal.Chat); !ok || chat.Text != "hi" {
			t.Errorf("got %#v", v)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout")
	}
}

func TestOverflowReturnsFalse(t *testing.T) {
	// No writePump: the queue can only fill.
	c := &wsClient{send: make(chan []byte, 2), log: testLog}
	c.ctx, c.cancel = context.WithCancel(context.Background())
	if !c.Send(signal.PeerLeft{ID: "a"}) || !c.Send(signal.PeerLeft{ID: "b"}) {
		t.Fatal("queue should accept up to cap")
	}
	if c.Send(signal.PeerLeft{ID: "c"}) {
		t.Error("Send should report overflow when queue is full")
	}
}

func TestPingEvictsDeadPeer(t *testing.T) {
	oldPing, oldPong := pingInterval, pongTimeout
	pingInterval, pongTimeout = 30*time.Millisecond, 100*time.Millisecond // ping uses pongTimeout
	t.Cleanup(func() { pingInterval, pongTimeout = oldPing, oldPong })

	closed := make(chan struct{})
	_ = wsPair(t, func(c *wsClient) {
		<-c.done()
		close(closed)
	})
	// Dial-side never reads → pongs never processed → ping times out.
	select {
	case <-closed:
	case <-time.After(3 * time.Second):
		t.Fatal("dead peer was not evicted")
	}
}

// A deadline-exceeded close (a live peer we could not reach in time — the
// screenshare-contention reconnect we are hunting) must be Warn-logged as an
// eviction; an ordinary socket close (the peer left) must NOT, or every leave
// would spam the diagnostic we are trying to read.
func TestLogCloseDistinguishesEvictionFromDeparture(t *testing.T) {
	log, buf := capturingLogger()
	c := &wsClient{log: log}
	// A deadline-exceeded error, wrapped exactly as coder/websocket wraps it.
	c.logClose("keepalive ping", fmt.Errorf("failed to wait for pong: %w", context.DeadlineExceeded))
	// An ordinary close (the peer went away).
	c.logClose("frame write", net.ErrClosed)
	s := buf.String()
	if strings.Count(s, "evicting live peer") != 1 {
		t.Errorf("want exactly one eviction warn (the deadline case only), log:\n%s", s)
	}
	if !strings.Contains(s, "level=WARN") {
		t.Errorf("eviction must be Warn-level, log:\n%s", s)
	}
	if !strings.Contains(s, "peer socket closed") {
		t.Errorf("a plain close must still be logged (at Debug), log:\n%s", s)
	}
}

// The ping-timeout eviction path in writePump must emit the eviction warn, so a
// real reconnect leaves a greppable trail in the server log.
func TestPingTimeoutLogsEviction(t *testing.T) {
	oldPing, oldPong := pingInterval, pongTimeout
	pingInterval, pongTimeout = 30*time.Millisecond, 100*time.Millisecond
	t.Cleanup(func() { pingInterval, pongTimeout = oldPing, oldPong })

	log, buf := capturingLogger()
	closed := make(chan struct{})
	_ = wsPairLog(t, log, func(c *wsClient) {
		<-c.done() // writePump logs then cancels the ctx, so the warn precedes this
		close(closed)
	})
	// Dial-side never reads → pongs never processed → ping times out.
	select {
	case <-closed:
	case <-time.After(3 * time.Second):
		t.Fatal("dead peer was not evicted")
	}
	if s := buf.String(); !strings.Contains(s, "evicting live peer") || !strings.Contains(s, "ping timed out") {
		t.Errorf("ping-timeout eviction was not logged, log:\n%s", s)
	}
}

// Demonstrates the read-loop-starvation failure mode directly: the client is
// genuinely alive and auto-ponging, yet the server still evicts it — purely
// because the server's own read loop is blocked and never processes the pong.
// This is why a screenshare renegotiation storm can drop a healthy peer, and why
// no bitrate cap fixes it: the fault is a stalled server read loop, not bandwidth.
func TestStalledServerReadLoopEvictsLivePeer(t *testing.T) {
	oldPing, oldPong := pingInterval, pongTimeout
	pingInterval, pongTimeout = 30*time.Millisecond, 150*time.Millisecond
	t.Cleanup(func() { pingInterval, pongTimeout = oldPing, oldPong })

	log, buf := capturingLogger()
	closed := make(chan struct{})
	dial := wsPairLog(t, log, func(c *wsClient) {
		// Simulate a serve loop stuck in a handler: never return to readNext, so
		// the server side cannot process the client's pongs.
		<-c.done()
		close(closed)
	})
	// The dial actively reads, so coder/websocket auto-responds to the server's
	// pings: the client is provably healthy. Only the server's stalled read loop
	// is at fault.
	go func() {
		for {
			if _, _, err := dial.Read(context.Background()); err != nil {
				return
			}
		}
	}()
	select {
	case <-closed:
	case <-time.After(3 * time.Second):
		t.Fatal("a live, ponging peer was not evicted despite a stalled server read loop")
	}
	if s := buf.String(); !strings.Contains(s, "evicting live peer") || !strings.Contains(s, "ping timed out") {
		t.Errorf("expected a ping-timeout eviction warn, log:\n%s", s)
	}
}

// Queue overflow (a peer reading slower than we produce) must log the eviction
// too — it is one of the three ways a screenshare burst can drop a live peer.
func TestOverflowLogsEviction(t *testing.T) {
	log, buf := capturingLogger()
	c := &wsClient{send: make(chan []byte, 1), log: log}
	c.ctx, c.cancel = context.WithCancel(context.Background())
	c.Send(signal.PeerLeft{ID: "a"}) // fills the queue
	if c.Send(signal.PeerLeft{ID: "b"}) {
		t.Fatal("second Send should overflow")
	}
	if s := buf.String(); !strings.Contains(s, "evicting live peer") || !strings.Contains(s, "send queue overflow") {
		t.Errorf("overflow eviction was not logged, log:\n%s", s)
	}
}

func TestCloseIsIdempotent(t *testing.T) {
	dial := wsPair(t, func(c *wsClient) {
		c.Close()
		c.Close() // must not panic
	})
	_ = dial
}

func TestRecoverGuard(t *testing.T) {
	func() {
		defer recoverGuard(testLog, "test")
		panic("boom")
	}() // must not crash the test binary
}

// A frame enqueued immediately before Close must still reach the client:
// this is what makes kicked/banned/server-restarting notices actually deliver.
func TestCloseFlushesQueuedFrame(t *testing.T) {
	dial := wsPair(t, func(c *wsClient) {
		c.Send(signal.Banned{By: "op"})
		c.Close()
	})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, data, err := dial.Read(ctx)
	if err != nil {
		t.Fatalf("expected banned frame before close, got read error: %v", err)
	}
	var env map[string]any
	json.Unmarshal(data, &env)
	if env["type"] != "banned" {
		t.Errorf("frame = %s, want type banned", data)
	}
}
