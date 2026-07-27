package signal

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestDecodeClientMessages(t *testing.T) {
	cases := []struct {
		in   string
		want any
	}{
		{`{"type":"join","name":"alice","password":"pw","token":"abc.def"}`, &Join{Name: "alice", Password: "pw", Token: "abc.def"}},
		{`{"type":"join","name":"alice","gravatar":"84059b07d4be67b806386c0aad8070a23f18836bbaae342275dc0a83414c32ee"}`, &Join{Name: "alice", Gravatar: "84059b07d4be67b806386c0aad8070a23f18836bbaae342275dc0a83414c32ee"}},
		{`{"type":"offer","sdp":"v=0"}`, &Offer{SDP: "v=0"}},
		{`{"type":"answer","sdp":"v=0"}`, &Answer{SDP: "v=0"}},
		{`{"type":"chat","text":"hi"}`, &Chat{Text: "hi"}},
		{`{"type":"set-lock","password":"s3cret"}`, &SetLock{Password: "s3cret"}},
		{`{"type":"set-lock"}`, &SetLock{}},
		{`{"type":"kick","id":"p1"}`, &Kick{ID: "p1"}},
		{`{"type":"mute-peer","id":"p1","kind":"mic"}`, &MutePeer{ID: "p1", Kind: "mic"}},
		{`{"type":"ban","id":"p1"}`, &Ban{ID: "p1"}},
		{`{"type":"countdown","action":"start"}`, &Countdown{Action: "start"}},
		{`{"type":"countdown","action":"stop"}`, &Countdown{Action: "stop"}},
		{`{"type":"media-state","mic":true,"camera":false}`, &MediaState{Mic: true, Camera: false}},
		{`{"type":"media-state","mic":false,"camera":true}`, &MediaState{Mic: false, Camera: true}},
		{`{"type":"rename","name":"bob"}`, &Rename{Name: "bob"}},
		{`{"type":"leave"}`, &Leave{}},
	}
	for _, c := range cases {
		got, err := Decode([]byte(c.in))
		if err != nil {
			t.Errorf("Decode(%s): %v", c.in, err)
			continue
		}
		gotJSON, _ := json.Marshal(got)
		wantJSON, _ := json.Marshal(c.want)
		if string(gotJSON) != string(wantJSON) {
			t.Errorf("Decode(%s) = %s, want %s", c.in, gotJSON, wantJSON)
		}
	}
}

func TestDecodeCandidatePreservesRawJSON(t *testing.T) {
	in := `{"type":"candidate","candidate":{"candidate":"candidate:1 1 udp 2 1.2.3.4 5 typ host","sdpMid":"0"}}`
	got, err := Decode([]byte(in))
	if err != nil {
		t.Fatal(err)
	}
	c, ok := got.(*Candidate)
	if !ok {
		t.Fatalf("got %T", got)
	}
	if !strings.Contains(string(c.Candidate), "sdpMid") {
		t.Errorf("raw candidate lost: %s", c.Candidate)
	}
}

func TestDecodeRejectsUnknownAndMalformed(t *testing.T) {
	for _, in := range []string{`{"type":"nope"}`, `{}`, `not json`, `{"type":"joined"}`} {
		if _, err := Decode([]byte(in)); err == nil {
			t.Errorf("Decode(%s) should fail", in)
		}
	}
}

func TestEncodeServerMessages(t *testing.T) {
	cases := []struct {
		in       any
		wantType string
		contains []string
	}{
		{Joined{SelfID: "p1", Role: "op", Peers: []PeerInfo{{ID: "p2", Name: "bob", Role: "user", Mic: true, Camera: false}}}, "joined", []string{`"selfId":"p1"`, `"role":"op"`, `"peers"`, `"mic":true`, `"camera":false`}},
		{Joined{SelfID: "p1", Role: "op", RoomAgeSec: 90}, "joined", []string{`"roomAge":90`}},
		{PeerJoined{ID: "p2", Name: "bob", Role: "voice", Mic: false, Camera: true}, "peer-joined", []string{`"id":"p2"`, `"mic":false`, `"camera":true`}},
		{PeerJoined{ID: "p2", Name: "bob", Role: "user", Gravatar: "84059b07d4be67b806386c0aad8070a23f18836bbaae342275dc0a83414c32ee"}, "peer-joined", []string{`"gravatar":"84059b07`}},
		{PeerLeft{ID: "p2"}, "peer-left", nil},
		{PeerMediaState{ID: "p2", Mic: false, Camera: true}, "peer-media-state", []string{`"id":"p2"`, `"mic":false`, `"camera":true`}},
		{PeerRenamed{ID: "p2", Name: "bob"}, "peer-renamed", []string{`"id":"p2"`, `"name":"bob"`}},
		{Offer{SDP: "v=0"}, "offer", []string{`"sdp":"v=0"`}},
		{Tracks{Tracks: []TrackInfo{{Mid: "0", ParticipantID: "p2", Kind: "camera"}}}, "tracks", []string{`"participantId":"p2"`}},
		{ChatEvent{From: "alice", Text: "hi", TS: 1753000000}, "chat", []string{`"ts":1753000000`}},
		{Moderation{Actor: "alice", Action: "kick", Target: "bob"}, "moderation", nil},
		{CountdownEvent{Action: "start", By: "alice"}, "countdown", []string{`"action":"start"`, `"by":"alice"`}},
		{Kicked{By: "alice"}, "kicked", nil},
		{Banned{By: "alice"}, "banned", nil},
		{Muted{Kind: "mic"}, "muted", nil},
		{RoomLocked{}, "room-locked", nil},
		{RoomUnlocked{}, "room-unlocked", nil},
		{ServerRestarting{}, "server-restarting", nil},
		{Error{Code: "bad-password", Message: "wrong password"}, "error", []string{`"code":"bad-password"`}},
	}
	for _, c := range cases {
		raw, err := Encode(c.in)
		if err != nil {
			t.Errorf("Encode(%T): %v", c.in, err)
			continue
		}
		var env struct {
			Type string `json:"type"`
		}
		json.Unmarshal(raw, &env)
		if env.Type != c.wantType {
			t.Errorf("Encode(%T) type = %q, want %q", c.in, env.Type, c.wantType)
		}
		for _, sub := range c.contains {
			if !strings.Contains(string(raw), sub) {
				t.Errorf("Encode(%T) = %s, missing %s", c.in, raw, sub)
			}
		}
	}
}

func TestEncodeRejectsClientOnlyTypes(t *testing.T) {
	if _, err := Encode(Join{Name: "x"}); err == nil {
		t.Error("Encode(Join) should fail — client-only type")
	}
}

func TestRoomAgeOmittedWhenZero(t *testing.T) {
	raw, err := Encode(Joined{SelfID: "p1", Role: "op"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "roomAge") {
		t.Errorf("Encode(Joined{age:0}) = %s, should omit roomAge", raw)
	}
}

func TestGravatarOmittedWhenEmpty(t *testing.T) {
	for _, v := range []any{PeerJoined{ID: "p2", Name: "bob", Role: "user"}, Joined{SelfID: "p1", Role: "op", Peers: []PeerInfo{{ID: "p2", Name: "bob", Role: "user"}}}} {
		raw, err := Encode(v)
		if err != nil {
			t.Fatalf("Encode(%T): %v", v, err)
		}
		if strings.Contains(string(raw), "gravatar") {
			t.Errorf("Encode(%T) = %s, should omit empty gravatar", v, raw)
		}
	}
}
