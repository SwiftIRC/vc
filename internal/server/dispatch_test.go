package server

import (
	"testing"

	"github.com/ryanwohara/webrtc-chat/internal/token"
)

func TestChatFanOutAndReplay(t *testing.T) {
	_, srv := newTestHub(t, "", true)
	a := dialRoom(t, srv, "cafe")
	send(t, a, map[string]any{"type": "join", "name": "alice"})
	recv(t, a, "joined")
	b := dialRoom(t, srv, "cafe")
	send(t, b, map[string]any{"type": "join", "name": "bob"})
	recv(t, b, "joined")

	send(t, a, map[string]any{"type": "chat", "text": "hello"})
	m := recv(t, b, "chat")
	if m["from"] != "alice" || m["text"] != "hello" {
		t.Errorf("chat = %v", m)
	}
	// late joiner gets replay
	c := dialRoom(t, srv, "cafe")
	send(t, c, map[string]any{"type": "join", "name": "carol"})
	recv(t, c, "joined")
	if m := recv(t, c, "chat"); m["text"] != "hello" {
		t.Errorf("replay = %v", m)
	}
}

func TestModerationOverWS(t *testing.T) {
	_, srv := newTestHub(t, testSecret, false)
	op := dialRoom(t, srv, "swift")
	send(t, op, map[string]any{"type": "join", "token": opToken(t, "swift", 0)})
	recv(t, op, "joined")
	guest := dialRoom(t, srv, "swift")
	send(t, guest, map[string]any{"type": "join", "name": "troll"})
	j := recv(t, guest, "joined")
	trollID := j["selfId"].(string)

	// guest cannot moderate: error comes back only to them
	send(t, guest, map[string]any{"type": "kick", "id": "whoever"})
	if e := recv(t, guest, "error"); e["code"] != "not-op" {
		t.Errorf("code = %v", e["code"])
	}

	// op mutes: guest gets muted, op sees the feed entry
	send(t, op, map[string]any{"type": "mute-peer", "id": trollID, "kind": "mic"})
	if m := recv(t, guest, "muted"); m["kind"] != "mic" {
		t.Errorf("muted = %v", m)
	}
	if m := recv(t, op, "moderation"); m["action"] != "mute" {
		t.Errorf("feed = %v", m)
	}

	// op locks, then kicks
	send(t, op, map[string]any{"type": "set-lock", "password": "pw"})
	recv(t, op, "room-locked")
	send(t, op, map[string]any{"type": "kick", "id": trollID})
	if k := recv(t, guest, "kicked"); k["by"] != "Ryan" {
		t.Errorf("kicked = %v", k)
	}
}

func TestBanOverWSBlocksRejoin(t *testing.T) {
	_, srv := newTestHub(t, testSecret, false)
	op := dialRoom(t, srv, "swift")
	send(t, op, map[string]any{"type": "join", "token": opToken(t, "swift", 0)})
	recv(t, op, "joined")

	victimTok, _ := token.Sign(token.Claims{Room: "swift", Channel: "#swift",
		Account: "victim", Nick: "victim", Role: "user",
		IssuedAt: 1, ExpiresAt: 9999999999}, []byte(testSecret))
	v1 := dialRoom(t, srv, "swift")
	send(t, v1, map[string]any{"type": "join", "token": victimTok})
	j := recv(t, v1, "joined")

	send(t, op, map[string]any{"type": "ban", "id": j["selfId"].(string)})
	recv(t, v1, "banned")

	v2 := dialRoom(t, srv, "swift")
	send(t, v2, map[string]any{"type": "join", "token": victimTok})
	if e := recv(t, v2, "error"); e["code"] != "banned" {
		t.Errorf("rejoin code = %v", e["code"])
	}
}

func TestOversizedChatDropped(t *testing.T) {
	_, srv := newTestHub(t, "", true)
	a := dialRoom(t, srv, "cafe")
	send(t, a, map[string]any{"type": "join", "name": "alice"})
	recv(t, a, "joined")
	big := make([]byte, 3000)
	for i := range big {
		big[i] = 'x'
	}
	send(t, a, map[string]any{"type": "chat", "text": string(big)})
	send(t, a, map[string]any{"type": "chat", "text": "small"})
	if m := recv(t, a, "chat"); m["text"] != "small" {
		t.Errorf("oversized chat was not dropped: %v", m["text"])
	}
}
