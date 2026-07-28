package server

import (
	"context"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
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

// recvBefore reads frames in order until wantType, failing if rejectType shows up
// first. recv() alone cannot express "no error frame" because it skips past anything
// that is not the type it was asked for.
func recvBefore(t *testing.T, c *websocket.Conn, wantType, rejectType string) map[string]any {
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
		if m["type"] == rejectType {
			t.Fatalf("got a %q frame before %q: %v", rejectType, wantType, m)
		}
		if m["type"] == wantType {
			return m
		}
	}
	t.Fatalf("no %q frame before deadline", wantType)
	return nil
}

func TestPollOverWS(t *testing.T) {
	_, srv := newTestHub(t, testSecret, false)
	op := dialRoom(t, srv, "swift")
	send(t, op, map[string]any{"type": "join", "token": opToken(t, "swift", 0)})
	recv(t, op, "joined")
	guest := dialRoom(t, srv, "swift")
	send(t, guest, map[string]any{"type": "join", "name": "voter"})
	recv(t, guest, "joined")

	// A guest cannot create: the refusal is private to them, like the other
	// moderation commands.
	send(t, guest, map[string]any{"type": "create-poll", "question": "Ship it?", "options": []string{"Yes", "No"}})
	if e := recv(t, guest, "error"); e["code"] != "not-op" {
		t.Errorf("code = %v, want not-op", e["code"])
	}

	// The op creates: both see the poll open, and the feed narrates it.
	send(t, op, map[string]any{"type": "create-poll", "question": "Ship it?", "options": []string{"Yes", "No"}})
	opened := recv(t, guest, "poll")
	if opened["action"] != "open" || opened["question"] != "Ship it?" {
		t.Fatalf("open = %v", opened)
	}
	if m := recv(t, op, "moderation"); m["action"] != "poll-open" {
		t.Errorf("feed = %v", m)
	}
	pollID, _ := opened["id"].(string)

	// The guest votes; everyone sees the tally move.
	send(t, guest, map[string]any{"type": "vote", "pollId": pollID, "choice": 0})
	updated := recv(t, op, "poll")
	tallies, _ := updated["tallies"].([]any)
	if updated["action"] != "update" || len(tallies) != 2 || tallies[0].(float64) != 1 {
		t.Fatalf("update = %v", updated)
	}

	// A guest cannot close.
	send(t, guest, map[string]any{"type": "close-poll", "pollId": pollID})
	if e := recv(t, guest, "error"); e["code"] != "not-op" {
		t.Errorf("close code = %v, want not-op", e["code"])
	}

	// The op can.
	send(t, op, map[string]any{"type": "close-poll", "pollId": pollID})
	closed := recv(t, guest, "poll")
	if closed["action"] != "close" || closed["open"] != false {
		t.Fatalf("close = %v", closed)
	}
}

// A refused vote must stay silent: an "error" frame is treated by the in-call client
// as a terminal join error, so a stale card would eject the user from the call.
func TestRefusedVoteSendsNoErrorFrame(t *testing.T) {
	_, srv := newTestHub(t, testSecret, true)
	c := dialRoom(t, srv, "quiet")
	send(t, c, map[string]any{"type": "join", "name": "voter"})
	recv(t, c, "joined")

	send(t, c, map[string]any{"type": "vote", "pollId": "no-such-poll", "choice": 0})
	// Chat after it: the chat echo proves the socket is still being served, and
	// recvBefore fails if an error frame arrives first.
	send(t, c, map[string]any{"type": "chat", "text": "still here"})
	if m := recvBefore(t, c, "chat", "error"); m["text"] != "still here" {
		t.Fatalf("chat = %v", m)
	}
}
