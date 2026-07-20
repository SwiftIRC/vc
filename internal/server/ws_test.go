package server

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/ryanwohara/webrtc-chat/internal/signal"
)

var testLog = slog.New(slog.NewTextHandler(&strings.Builder{}, nil))

// wsPair spins up a server whose handler passes the accepted wsClient to fn,
// and returns a dialed client-side conn.
func wsPair(t *testing.T, fn func(c *wsClient)) *websocket.Conn {
	t.Helper()
	var wg sync.WaitGroup
	gotClient := make(chan *wsClient, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		conn.SetReadLimit(16384)
		c := newWSClient(conn, testLog)
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
	oldPing, oldWrite := pingInterval, writeTimeout
	pingInterval, writeTimeout = 30*time.Millisecond, 100*time.Millisecond
	t.Cleanup(func() { pingInterval, writeTimeout = oldPing, oldWrite })

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
