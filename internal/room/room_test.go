package room

import (
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/ryanwohara/webrtc-chat/internal/signal"
)

type fakeConn struct {
	mu         sync.Mutex
	msgs       []any
	closed     bool
	full       bool
	closeAfter time.Duration
}

func (f *fakeConn) Send(v any) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.full {
		return false
	}
	f.msgs = append(f.msgs, v)
	return true
}
func (f *fakeConn) Close()                     { f.mu.Lock(); f.closed = true; f.mu.Unlock() }
func (f *fakeConn) CloseAfter(d time.Duration) { f.mu.Lock(); f.closeAfter = d; f.mu.Unlock() }
func (f *fakeConn) typed(t *testing.T) (kinds []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, m := range f.msgs {
		kinds = append(kinds, fmt.Sprintf("%T", m))
	}
	return
}

func member(id, name string, role Role) (*Participant, *fakeConn) {
	c := &fakeConn{}
	return &Participant{ID: id, Name: name, Role: role, Conn: c}, c
}

func TestJoinSendsRosterAndBroadcasts(t *testing.T) {
	r := New(Config{Slug: "swift", Adhoc: true})
	alice, ac := member("p1", "alice", RoleUser)
	if err := r.Join(alice, ""); err != nil {
		t.Fatal(err)
	}
	if alice.Role != RoleOp {
		t.Errorf("first ad-hoc joiner role = %q, want op", alice.Role)
	}
	bob, bc := member("p2", "bob", RoleUser)
	if err := r.Join(bob, ""); err != nil {
		t.Fatal(err)
	}
	if bob.Role != RoleUser {
		t.Errorf("second joiner role = %q, want user", bob.Role)
	}
	// bob got a Joined with alice in the roster
	joined, ok := bc.msgs[0].(signal.Joined)
	if !ok {
		t.Fatalf("bob msg[0] = %T, want signal.Joined", bc.msgs[0])
	}
	if joined.SelfID != "p2" || len(joined.Peers) != 1 || joined.Peers[0].ID != "p1" || joined.Peers[0].Role != "op" {
		t.Errorf("bad Joined: %+v", joined)
	}
	// alice was told bob arrived
	last := ac.msgs[len(ac.msgs)-1]
	pj, ok := last.(signal.PeerJoined)
	if !ok || pj.ID != "p2" || pj.Name != "bob" {
		t.Errorf("alice last msg = %#v, want PeerJoined p2", last)
	}
	if r.Count() != 2 {
		t.Errorf("Count = %d", r.Count())
	}
}

func TestJoinDefaultsMediaOn(t *testing.T) {
	r := New(Config{Slug: "s", Adhoc: true})
	alice, _ := member("p1", "alice", RoleUser)
	r.Join(alice, "")
	bob, bc := member("p2", "bob", RoleUser)
	r.Join(bob, "")
	// bob's roster lists alice with media defaulting ON.
	joined := bc.msgs[0].(signal.Joined)
	if joined.Peers[0].Mic != true || joined.Peers[0].Camera != true {
		t.Errorf("roster default media = mic:%v camera:%v, want true true", joined.Peers[0].Mic, joined.Peers[0].Camera)
	}
	// alice's PeerJoined for bob also defaults ON.
	ac := alice.Conn.(*fakeConn)
	pj := ac.msgs[len(ac.msgs)-1].(signal.PeerJoined)
	if pj.Mic != true || pj.Camera != true {
		t.Errorf("PeerJoined default media = mic:%v camera:%v, want true true", pj.Mic, pj.Camera)
	}
}

func TestJoinCarriesProvidedInitialMedia(t *testing.T) {
	r := New(Config{Slug: "s", Adhoc: true})
	alice, _ := member("p1", "alice", RoleUser)
	r.Join(alice, "") // default ON
	// bob joins already muted (mic off, camera on) — reported via the join frame.
	bob, bc := member("p2", "bob", RoleUser)
	bob.SetInitialMedia(false, true)
	r.Join(bob, "")
	// bob's own roster still shows alice ON (alice provided nothing -> default).
	joined := bc.msgs[0].(signal.Joined)
	if joined.Peers[0].Mic != true || joined.Peers[0].Camera != true {
		t.Errorf("alice roster media = mic:%v camera:%v, want true true", joined.Peers[0].Mic, joined.Peers[0].Camera)
	}
	// alice's PeerJoined for bob must carry bob's real (muted) state, NOT the ON
	// default — this is what prevents the "briefly un-muted" flash for existing peers.
	ac := alice.Conn.(*fakeConn)
	pj := ac.msgs[len(ac.msgs)-1].(signal.PeerJoined)
	if pj.ID != "p2" || pj.Mic != false || pj.Camera != true {
		t.Errorf("bob PeerJoined = %+v, want {ID:p2 Mic:false Camera:true}", pj)
	}
}

func TestGrantOp(t *testing.T) {
	r := New(Config{Slug: "s", Adhoc: true})
	alice, _ := member("p1", "alice", RoleUser) // first ad-hoc joiner -> op
	r.Join(alice, "")
	bob, bc := member("p2", "bob", RoleUser)
	r.Join(bob, "")
	carol, _ := member("p3", "carol", RoleUser)
	r.Join(carol, "")

	// A non-op cannot promote anyone.
	if err := r.GrantOp("p2", "p3"); err != ErrNotOp {
		t.Fatalf("non-op GrantOp = %v, want ErrNotOp", err)
	}
	if carol.Role == RoleOp {
		t.Fatal("carol became op via a non-op grant")
	}

	// The op promotes bob; the role changes and both broadcasts go out.
	if err := r.GrantOp("p1", "p2"); err != nil {
		t.Fatalf("GrantOp: %v", err)
	}
	if bob.Role != RoleOp {
		t.Errorf("bob role after grant = %q, want op", bob.Role)
	}
	var gotRole *signal.RoleChange
	var gotMod *signal.Moderation
	bc.mu.Lock()
	for _, m := range bc.msgs {
		switch v := m.(type) {
		case signal.RoleChange:
			rc := v
			gotRole = &rc
		case signal.Moderation:
			if v.Action == "op" {
				md := v
				gotMod = &md
			}
		}
	}
	bc.mu.Unlock()
	if gotRole == nil || gotRole.ID != "p2" || gotRole.Role != "op" {
		t.Errorf("bob RoleChange = %+v, want {ID:p2 Role:op}", gotRole)
	}
	if gotMod == nil || gotMod.Actor != "alice" || gotMod.Target != "bob" {
		t.Errorf("op Moderation = %+v, want actor alice target bob", gotMod)
	}

	// Idempotent: promoting an existing op is a no-op, no error.
	if err := r.GrantOp("p1", "p2"); err != nil {
		t.Fatalf("re-GrantOp existing op: %v", err)
	}

	// The promotion took effect: bob (now op) can himself promote carol.
	if err := r.GrantOp("p2", "p3"); err != nil {
		t.Fatalf("newly-op bob GrantOp carol: %v", err)
	}
	if carol.Role != RoleOp {
		t.Errorf("carol role after bob's grant = %q, want op", carol.Role)
	}
}

func TestSetMediaStateBroadcastsToRoom(t *testing.T) {
	r := New(Config{Slug: "s", Adhoc: true})
	alice, _ := member("p1", "alice", RoleUser)
	bob, bc := member("p2", "bob", RoleUser)
	r.Join(alice, "")
	r.Join(bob, "")
	r.SetMediaState("p1", false, true)
	var got *signal.PeerMediaState
	bc.mu.Lock()
	for _, m := range bc.msgs {
		if pm, ok := m.(signal.PeerMediaState); ok {
			p := pm
			got = &p
		}
	}
	bc.mu.Unlock()
	if got == nil {
		t.Fatal("bob did not receive PeerMediaState")
	}
	if got.ID != "p1" || got.Mic != false || got.Camera != true {
		t.Errorf("PeerMediaState = %+v, want {ID:p1 Mic:false Camera:true}", *got)
	}
}

func TestLateJoinerRosterReflectsStoredMuteState(t *testing.T) {
	r := New(Config{Slug: "s", Adhoc: true})
	alice, _ := member("p1", "alice", RoleUser)
	r.Join(alice, "")
	// alice self-mutes her mic (camera stays on).
	r.SetMediaState("p1", false, true)
	// A late joiner's roster must reflect alice's stored (muted) state.
	late, lc := member("p2", "late", RoleUser)
	r.Join(late, "")
	joined, ok := lc.msgs[0].(signal.Joined)
	if !ok {
		t.Fatalf("late msg[0] = %T, want signal.Joined", lc.msgs[0])
	}
	if len(joined.Peers) != 1 {
		t.Fatalf("roster len = %d, want 1", len(joined.Peers))
	}
	p := joined.Peers[0]
	if p.ID != "p1" || p.Mic != false || p.Camera != true {
		t.Errorf("late joiner roster entry = %+v, want alice mic:false camera:true", p)
	}
}

func TestSetMediaStateUnknownPeerNoPanic(t *testing.T) {
	r := New(Config{Slug: "s", Adhoc: true})
	// No such participant: must be a silent no-op (no broadcast, no panic).
	r.SetMediaState("ghost", false, false)
}

func TestChannelRoomDoesNotPromoteFirstJoiner(t *testing.T) {
	r := New(Config{Slug: "swift", Channel: "#swift"})
	alice, _ := member("p1", "alice", RoleUser)
	r.Join(alice, "")
	if alice.Role != RoleUser {
		t.Errorf("channel-room joiner promoted to %q", alice.Role)
	}
}

func TestLockedRoomPassword(t *testing.T) {
	r := New(Config{Slug: "s", Adhoc: true})
	op, _ := member("p1", "op", RoleUser)
	r.Join(op, "")
	if err := r.SetLock("p1", "sesame"); err != nil {
		t.Fatal(err)
	}
	joiner, _ := member("p2", "eve", RoleUser)
	if err := r.Join(joiner, "wrong"); err != ErrBadPassword {
		t.Errorf("wrong password: %v", err)
	}
	if err := r.Join(joiner, "sesame"); err != nil {
		t.Errorf("right password: %v", err)
	}
}

func TestIdentifiedOnlyRejectsGuests(t *testing.T) {
	r := New(Config{Slug: "s", Channel: "#s", IdentifiedOnly: true})
	guest, _ := member("p1", "rando", RoleGuest)
	if err := r.Join(guest, ""); err != ErrIdentifiedOnly {
		t.Errorf("guest join: %v", err)
	}
	ident, _ := member("p2", "alice", RoleUser)
	ident.Account = "alice"
	if err := r.Join(ident, ""); err != nil {
		t.Errorf("identified join: %v", err)
	}
}

func TestChatReplayRingCap(t *testing.T) {
	r := New(Config{Slug: "s", Adhoc: true})
	alice, _ := member("p1", "alice", RoleUser)
	r.Join(alice, "")
	for i := 0; i < ChatHistory+5; i++ {
		r.Chat("p1", fmt.Sprintf("msg-%d", i))
	}
	late, lc := member("p9", "late", RoleUser)
	r.Join(late, "")
	var replayed []signal.ChatEvent
	for _, m := range lc.msgs {
		if ce, ok := m.(signal.ChatEvent); ok {
			replayed = append(replayed, ce)
		}
	}
	if len(replayed) != ChatHistory {
		t.Fatalf("replayed %d, want %d", len(replayed), ChatHistory)
	}
	if replayed[0].Text != "msg-5" || replayed[len(replayed)-1].Text != fmt.Sprintf("msg-%d", ChatHistory+4) {
		t.Errorf("ring window wrong: first=%q last=%q", replayed[0].Text, replayed[len(replayed)-1].Text)
	}
}

func TestOverflowingConnGetsClosed(t *testing.T) {
	r := New(Config{Slug: "s", Adhoc: true})
	alice, _ := member("p1", "alice", RoleUser)
	r.Join(alice, "")
	slow, sc := member("p2", "slow", RoleUser)
	r.Join(slow, "")
	sc.mu.Lock()
	sc.full = true
	sc.mu.Unlock()
	r.Chat("p1", "hello")
	sc.mu.Lock()
	closed := sc.closed
	sc.mu.Unlock()
	if !closed {
		t.Error("overflowing conn was not closed")
	}
}

func TestLeaveAndEmptySince(t *testing.T) {
	now := time.Unix(1000, 0)
	r := New(Config{Slug: "s", Adhoc: true, Now: func() time.Time { return now }})
	alice, _ := member("p1", "alice", RoleUser)
	bob, bc := member("p2", "bob", RoleUser)
	r.Join(alice, "")
	r.Join(bob, "")
	r.Leave("p1")
	pl, ok := bc.msgs[len(bc.msgs)-1].(signal.PeerLeft)
	if !ok || pl.ID != "p1" {
		t.Errorf("bob last msg = %#v, want PeerLeft p1", bc.msgs[len(bc.msgs)-1])
	}
	if _, empty := r.EmptySince(); empty {
		t.Error("room reported empty while bob present")
	}
	r.Leave("p2")
	since, empty := r.EmptySince()
	if !empty || !since.Equal(now) {
		t.Errorf("EmptySince = %v,%v", since, empty)
	}
}

func TestBroadcastRestartingThenCloseConns(t *testing.T) {
	r := New(Config{Slug: "s", Adhoc: true})
	alice, ac := member("p1", "alice", RoleUser)
	r.Join(alice, "")
	r.Broadcast(signal.ServerRestarting{}, "")
	r.CloseConns()
	found := false
	ac.mu.Lock()
	for _, m := range ac.msgs {
		if _, ok := m.(signal.ServerRestarting); ok {
			found = true
		}
	}
	closed := ac.closed
	ac.mu.Unlock()
	if !found || !closed {
		t.Errorf("shutdown: restarting=%v closed=%v", found, closed)
	}
}
