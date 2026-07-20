package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"github.com/ryanwohara/webrtc-chat/internal/config"
	"github.com/ryanwohara/webrtc-chat/internal/room"
	"github.com/ryanwohara/webrtc-chat/internal/sfu"
	"github.com/ryanwohara/webrtc-chat/internal/token"
)

const testSecret = "test-secret-0123456789abcdef"

func newTestHub(t *testing.T, secret string, adhoc bool) (*Hub, *httptest.Server) {
	t.Helper()
	cfg := config.Config{Secret: secret, AdhocRooms: adhoc}
	reg := room.NewRegistry(adhoc, time.Now)
	e, err := sfu.NewEngine(cfg) // UDPPortMin/Max 0 => any ephemeral port
	if err != nil {
		t.Fatal(err)
	}
	mediaSFU := sfu.NewSFU(e, testLog)
	h := NewHub(cfg, reg, testLog, time.Now, mediaSFU)
	srv := httptest.NewServer(h.Routes())
	// Close the server, then join every connection's writePump. Client dials
	// register their own Close cleanups (which run first, LIFO), so the
	// server-side reads unblock and the writePumps exit; joining them here
	// gives the race detector a happens-before edge to their reads of the
	// ws.go tunables that TestPingEvictsDeadPeer later mutates.
	t.Cleanup(func() {
		srv.Close()
		h.conns.Wait()
	})
	return h, srv
}

func dialRoom(t *testing.T, srv *httptest.Server, slug string) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/ws/"+slug, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close(websocket.StatusNormalClosure, "") })
	return conn
}

func send(t *testing.T, c *websocket.Conn, v map[string]any) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := wsjson.Write(ctx, c, v); err != nil {
		t.Fatal(err)
	}
}

// recv reads frames until one matches wantType (skipping others), failing
// after a short deadline.
func recv(t *testing.T, c *websocket.Conn, wantType string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		ctx, cancel := context.WithDeadline(context.Background(), deadline)
		var m map[string]any
		err := wsjson.Read(ctx, c, &m)
		cancel()
		if err != nil {
			t.Fatalf("waiting for %q: %v", wantType, err)
		}
		if m["type"] == wantType {
			return m
		}
	}
	t.Fatalf("no %q frame before deadline", wantType)
	return nil
}

func opToken(t *testing.T, slug string, flags int) string {
	t.Helper()
	tok, err := token.Sign(token.Claims{
		Channel: "#" + slug, Room: slug, Account: "Ryan", Nick: "Ryan", Role: "op",
		Flags: flags, IssuedAt: time.Now().Unix(), ExpiresAt: time.Now().Add(10 * time.Minute).Unix(),
	}, []byte(testSecret))
	if err != nil {
		t.Fatal(err)
	}
	return tok
}

func TestGuestJoinAndRoster(t *testing.T) {
	_, srv := newTestHub(t, "", true)
	a := dialRoom(t, srv, "lobby")
	send(t, a, map[string]any{"type": "join", "name": "alice"})
	ja := recv(t, a, "joined")
	if ja["role"] != "op" { // ad-hoc first joiner
		t.Errorf("first joiner role = %v", ja["role"])
	}
	b := dialRoom(t, srv, "lobby")
	send(t, b, map[string]any{"type": "join", "name": "bob"})
	jb := recv(t, b, "joined")
	if jb["role"] != "guest" {
		t.Errorf("guest role = %v", jb["role"])
	}
	peers := jb["peers"].([]any)
	if len(peers) != 1 || peers[0].(map[string]any)["name"] != "alice" {
		t.Errorf("roster = %v", peers)
	}
	pj := recv(t, a, "peer-joined")
	if pj["name"] != "bob" {
		t.Errorf("peer-joined = %v", pj)
	}
	b.Close(websocket.StatusNormalClosure, "")
	pl := recv(t, a, "peer-left")
	if pl["id"] != jb["selfId"] {
		t.Errorf("peer-left id = %v, want %v", pl["id"], jb["selfId"])
	}
}

func TestWrongPassword(t *testing.T) {
	h, srv := newTestHub(t, "", true)
	rm, _ := h.reg.Resolve("locked", nil)
	op := &room.Participant{ID: "op1", Name: "op", Role: room.RoleUser, Conn: nopConn{}}
	rm.Join(op, "")
	rm.SetLock("op1", "sesame")

	c := dialRoom(t, srv, "locked")
	send(t, c, map[string]any{"type": "join", "name": "eve", "password": "wrong"})
	e := recv(t, c, "error")
	if e["code"] != "bad-password" {
		t.Errorf("code = %v", e["code"])
	}
}

func TestTokenJoinProvisionsAndGrantsOp(t *testing.T) {
	_, srv := newTestHub(t, testSecret, false) // channel-rooms-only
	c := dialRoom(t, srv, "swift")
	send(t, c, map[string]any{"type": "join", "token": opToken(t, "swift", 0)})
	j := recv(t, c, "joined")
	if j["role"] != "op" {
		t.Errorf("tokened op role = %v", j["role"])
	}
}

func TestUnprovisionedRejected(t *testing.T) {
	_, srv := newTestHub(t, testSecret, false)
	c := dialRoom(t, srv, "ghost")
	send(t, c, map[string]any{"type": "join", "name": "eve"})
	if e := recv(t, c, "error"); e["code"] != "not-provisioned" {
		t.Errorf("code = %v", e["code"])
	}
}

func TestIdentifiedOnlyRejectsGuest(t *testing.T) {
	_, srv := newTestHub(t, testSecret, false)
	c := dialRoom(t, srv, "swift")
	send(t, c, map[string]any{"type": "join", "token": opToken(t, "swift", token.FlagIdentifiedOnly)})
	recv(t, c, "joined")
	g := dialRoom(t, srv, "swift")
	send(t, g, map[string]any{"type": "join", "name": "rando"})
	if e := recv(t, g, "error"); e["code"] != "identified-only" {
		t.Errorf("code = %v", e["code"])
	}
}

func TestBadAndExpiredTokens(t *testing.T) {
	_, srv := newTestHub(t, testSecret, false)
	c := dialRoom(t, srv, "swift")
	send(t, c, map[string]any{"type": "join", "token": "garbage.token"})
	if e := recv(t, c, "error"); e["code"] != "token-invalid" {
		t.Errorf("code = %v", e["code"])
	}
	expired, _ := token.Sign(token.Claims{Room: "swift", Nick: "x", Role: "op",
		IssuedAt: 1, ExpiresAt: 2}, []byte(testSecret))
	c2 := dialRoom(t, srv, "swift")
	send(t, c2, map[string]any{"type": "join", "token": expired})
	if e := recv(t, c2, "error"); e["code"] != "token-expired" {
		t.Errorf("code = %v", e["code"])
	}
}

func TestJoinTimeout(t *testing.T) {
	old := joinTimeout
	joinTimeout = 100 * time.Millisecond
	t.Cleanup(func() { joinTimeout = old })
	_, srv := newTestHub(t, "", true)
	c := dialRoom(t, srv, "lobby")
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if _, _, err := c.Read(ctx); err == nil {
		t.Error("socket should close when no join arrives")
	}
}

func TestClientIPTrustProxy(t *testing.T) {
	mk := func(xff, remote string) *http.Request {
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = remote
		if xff != "" {
			r.Header.Set("X-Forwarded-For", xff)
		}
		return r
	}
	// trusted: rightmost hop wins (proxy appends real peer)
	if got := clientIP(mk("1.2.3.4, 10.0.0.9", "127.0.0.1:5000"), true); got != "10.0.0.9" {
		t.Errorf("trusted rightmost = %q, want 10.0.0.9", got)
	}
	// untrusted: XFF ignored, RemoteAddr host used
	if got := clientIP(mk("1.2.3.4", "10.0.0.9:5000"), false); got != "10.0.0.9" {
		t.Errorf("untrusted = %q, want 10.0.0.9", got)
	}
	// trusted but no XFF: RemoteAddr host
	if got := clientIP(mk("", "10.0.0.9:5000"), true); got != "10.0.0.9" {
		t.Errorf("trusted no-xff = %q, want 10.0.0.9", got)
	}
}

type nopConn struct{}

func (nopConn) Send(v any) bool          { return true }
func (nopConn) Close()                   {}
func (nopConn) CloseAfter(time.Duration) {}
