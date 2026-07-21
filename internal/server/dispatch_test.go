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

func TestCountdownSyncedOverWS(t *testing.T) {
	_, srv := newTestHub(t, "", true)
	a := dialRoom(t, srv, "cafe")
	send(t, a, map[string]any{"type": "join", "name": "alice"})
	recv(t, a, "joined")
	b := dialRoom(t, srv, "cafe")
	send(t, b, map[string]any{"type": "join", "name": "bob"})
	recv(t, b, "joined")

	// alice starts: everyone (including alice) gets a start naming the starter.
	send(t, a, map[string]any{"type": "countdown", "action": "start"})
	if m := recv(t, b, "countdown"); m["action"] != "start" || m["by"] != "alice" {
		t.Errorf("bob start = %v", m)
	}
	if m := recv(t, a, "countdown"); m["action"] != "start" {
		t.Errorf("alice start = %v", m)
	}

	// bob (not the starter) tries to stop: refused, no broadcast. alice stops:
	// the only stop bob sees is alice's — so the first stop must be "by alice".
	send(t, b, map[string]any{"type": "countdown", "action": "stop"})
	send(t, a, map[string]any{"type": "countdown", "action": "stop"})
	if m := recv(t, b, "countdown"); m["action"] != "stop" || m["by"] != "alice" {
		t.Errorf("bob stop = %v (want stop by alice; a non-starter stop must not broadcast)", m)
	}
}

func TestMediaStateBroadcastOverWS(t *testing.T) {
	_, srv := newTestHub(t, "", true)
	a := dialRoom(t, srv, "cafe")
	send(t, a, map[string]any{"type": "join", "name": "alice"})
	ja := recv(t, a, "joined")
	aliceID := ja["selfId"].(string)
	b := dialRoom(t, srv, "cafe")
	send(t, b, map[string]any{"type": "join", "name": "bob"})
	recv(t, b, "joined")

	// alice self-mutes her mic (camera stays on); bob learns via peer-media-state.
	send(t, a, map[string]any{"type": "media-state", "mic": false, "camera": true})
	m := recv(t, b, "peer-media-state")
	if m["id"] != aliceID || m["mic"] != false || m["camera"] != true {
		t.Errorf("peer-media-state = %v", m)
	}

	// A late joiner's roster carries alice's stored (muted) state.
	c := dialRoom(t, srv, "cafe")
	send(t, c, map[string]any{"type": "join", "name": "carol"})
	jc := recv(t, c, "joined")
	peers := jc["peers"].([]any)
	var alice map[string]any
	for _, p := range peers {
		pm := p.(map[string]any)
		if pm["id"] == aliceID {
			alice = pm
		}
	}
	if alice == nil {
		t.Fatalf("alice not in carol's roster: %v", peers)
	}
	if alice["mic"] != false || alice["camera"] != true {
		t.Errorf("late-joiner roster for alice = %v, want mic:false camera:true", alice)
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
