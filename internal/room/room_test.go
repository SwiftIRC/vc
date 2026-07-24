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

func TestJoinCarriesGravatar(t *testing.T) {
	const aliceHash = "84059b07d4be67b806386c0aad8070a23f18836bbaae342275dc0a83414c32ee"
	const bobHash = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"
	r := New(Config{Slug: "swift", Adhoc: true})
	alice, ac := member("p1", "alice", RoleUser)
	alice.Gravatar = aliceHash
	if err := r.Join(alice, ""); err != nil {
		t.Fatal(err)
	}
	bob, bc := member("p2", "bob", RoleUser)
	bob.Gravatar = bobHash
	if err := r.Join(bob, ""); err != nil {
		t.Fatal(err)
	}
	// bob's Joined roster carries alice's gravatar
	joined, ok := bc.msgs[0].(signal.Joined)
	if !ok {
		t.Fatalf("bob msg[0] = %T, want signal.Joined", bc.msgs[0])
	}
	if len(joined.Peers) != 1 || joined.Peers[0].Gravatar != aliceHash {
		t.Errorf("roster gravatar = %+v, want alice %q", joined.Peers, aliceHash)
	}
	// alice was told bob arrived, with bob's gravatar
	last := ac.msgs[len(ac.msgs)-1]
	pj, ok := last.(signal.PeerJoined)
	if !ok || pj.Gravatar != bobHash {
		t.Errorf("alice last msg = %#v, want PeerJoined with gravatar %q", last, bobHash)
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

// TestRefFlowsThroughRosterJoinLeave verifies the stable per-session Ref is carried on
// the roster (PeerInfo), the PeerJoined broadcast, and the PeerLeft broadcast — the three
// frames a client needs to recognise a reconnecting member and suppress its chime.
func TestRefFlowsThroughRosterJoinLeave(t *testing.T) {
	r := New(Config{Slug: "s", Adhoc: true})
	alice, _ := member("p1", "alice", RoleUser)
	alice.Ref = "refA"
	r.Join(alice, "")

	bob, bc := member("p2", "bob", RoleUser)
	bob.Ref = "refB"
	r.Join(bob, "")

	// bob's roster carries alice's ref.
	joined := bc.msgs[0].(signal.Joined)
	if len(joined.Peers) != 1 || joined.Peers[0].Ref != "refA" {
		t.Errorf("roster ref = %q, want refA", joinedFirstRef(joined))
	}
	// alice's PeerJoined for bob carries bob's ref.
	ac := alice.Conn.(*fakeConn)
	pj := ac.msgs[len(ac.msgs)-1].(signal.PeerJoined)
	if pj.ID != "p2" || pj.Ref != "refB" {
		t.Errorf("PeerJoined ref = %+v, want ID p2 Ref refB", pj)
	}
	// When bob leaves, the PeerLeft carries bob's ref too.
	r.Leave("p2")
	pl := ac.msgs[len(ac.msgs)-1].(signal.PeerLeft)
	if pl.ID != "p2" || pl.Ref != "refB" {
		t.Errorf("PeerLeft = %+v, want ID p2 Ref refB", pl)
	}
}

func joinedFirstRef(j signal.Joined) string {
	if len(j.Peers) == 0 {
		return ""
	}
	return j.Peers[0].Ref
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

// A mid-call op grant must survive a reconnect (new participant, same account) — a
// screenshare-induced or network reconnect shouldn't silently demote an op.
func TestOpGrantSurvivesReconnect(t *testing.T) {
	r := New(Config{Slug: "s", Adhoc: true})
	alice, _ := member("p1", "alice", RoleUser) // first ad-hoc joiner -> op
	r.Join(alice, "")

	bob := &Participant{ID: "p2", Name: "bob", Role: RoleUser, Account: "bob-acct", Conn: &fakeConn{}}
	r.Join(bob, "")
	if err := r.GrantOp("p1", "p2"); err != nil {
		t.Fatalf("GrantOp: %v", err)
	}

	// bob's socket drops and he reconnects as a fresh participant (new ID, same
	// account, default role). The grant must be re-applied.
	r.Leave("p2")
	bob2 := &Participant{ID: "p2b", Name: "bob", Role: RoleUser, Account: "bob-acct", Conn: &fakeConn{}}
	if err := r.Join(bob2, ""); err != nil {
		t.Fatalf("rejoin: %v", err)
	}
	if bob2.Role != RoleOp {
		t.Errorf("bob rejoined as %q, want op (grant should survive reconnect)", bob2.Role)
	}

	// An unrelated account (and a guest with no account) is not silently opped.
	guest := &Participant{ID: "p3", Name: "carol", Role: RoleUser, Conn: &fakeConn{}}
	r.Join(guest, "")
	if guest.Role == RoleOp {
		t.Error("a fresh guest wrongly received op")
	}
}

// The ad-hoc first-joiner op is a GUEST (no account); it must still survive a
// reconnect, keyed by the stable session ref rather than an account.
func TestAdhocOpSurvivesReconnectByRef(t *testing.T) {
	r := New(Config{Slug: "s", Adhoc: true})
	alice := &Participant{ID: "p1", Name: "alice", Role: RoleUser, Ref: "refA", Conn: &fakeConn{}}
	if err := r.Join(alice, ""); err != nil {
		t.Fatal(err)
	}
	if alice.Role != RoleOp {
		t.Fatalf("first ad-hoc joiner should be op, got %q", alice.Role)
	}
	// Her socket drops; she reconnects as a fresh participant (new ID, SAME ref,
	// no account). Op must be restored from the session ref.
	r.Leave("p1")
	alice2 := &Participant{ID: "p1b", Name: "alice", Role: RoleUser, Ref: "refA", Conn: &fakeConn{}}
	if err := r.Join(alice2, ""); err != nil {
		t.Fatalf("rejoin: %v", err)
	}
	if alice2.Role != RoleOp {
		t.Errorf("ad-hoc op rejoined as %q, want op (should survive reconnect by ref)", alice2.Role)
	}
}

// A guest (no account) hand-opped mid-call must survive a reconnect too, keyed by ref.
func TestGuestOpGrantSurvivesReconnectByRef(t *testing.T) {
	r := New(Config{Slug: "s", Adhoc: true})
	alice := &Participant{ID: "p1", Name: "alice", Role: RoleUser, Ref: "refA", Conn: &fakeConn{}}
	r.Join(alice, "") // ad-hoc op
	bob := &Participant{ID: "p2", Name: "bob", Role: RoleUser, Ref: "refB", Conn: &fakeConn{}}
	r.Join(bob, "")
	if err := r.GrantOp("p1", "p2"); err != nil {
		t.Fatalf("GrantOp: %v", err)
	}
	// bob reconnects (new ID, same ref, still no account).
	r.Leave("p2")
	bob2 := &Participant{ID: "p2b", Name: "bob", Role: RoleUser, Ref: "refB", Conn: &fakeConn{}}
	if err := r.Join(bob2, ""); err != nil {
		t.Fatalf("rejoin: %v", err)
	}
	if bob2.Role != RoleOp {
		t.Errorf("guest op rejoined as %q, want op (grant should survive by ref)", bob2.Role)
	}
}

// Security: an empty ref must never become an op key — otherwise the first no-nonce
// op would seed a "" entry that hands op to every other no-nonce joiner.
func TestEmptyRefNeverInheritsOp(t *testing.T) {
	r := New(Config{Slug: "s", Adhoc: true})
	alice := &Participant{ID: "p1", Name: "alice", Role: RoleUser, Ref: "", Conn: &fakeConn{}}
	r.Join(alice, "") // ad-hoc op, but Ref==""
	bob := &Participant{ID: "p2", Name: "bob", Role: RoleUser, Ref: "", Conn: &fakeConn{}}
	r.Join(bob, "")
	if bob.Role == RoleOp {
		t.Error("a no-ref guest wrongly inherited op via an empty ref key")
	}
}

func TestSetQuality(t *testing.T) {
	r := New(Config{Slug: "s", Adhoc: true})
	alice, _ := member("p1", "alice", RoleUser) // first ad-hoc joiner -> op
	r.Join(alice, "")
	bob, bc := member("p2", "bob", RoleUser)
	r.Join(bob, "")

	// Only an op may set it.
	if err := r.SetQuality("p2", "camera", "high"); err != ErrNotOp {
		t.Fatalf("non-op SetQuality = %v, want ErrNotOp", err)
	}

	// Op caps the camera; bob gets the Quality broadcast and a moderation feed entry.
	if err := r.SetQuality("p1", "camera", "high"); err != nil {
		t.Fatalf("SetQuality: %v", err)
	}
	var gotQ *signal.Quality
	var gotMod *signal.Moderation
	bc.mu.Lock()
	for _, m := range bc.msgs {
		switch v := m.(type) {
		case signal.Quality:
			q := v
			gotQ = &q
		case signal.Moderation:
			if v.Action == "quality" {
				md := v
				gotMod = &md
			}
		}
	}
	bc.mu.Unlock()
	if gotQ == nil || gotQ.Camera != "high" || gotQ.Screen != "" {
		t.Errorf("Quality broadcast = %+v, want camera=high screen=empty", gotQ)
	}
	if gotMod == nil || gotMod.Target != "camera" || gotMod.Kind != "high" {
		t.Errorf("quality moderation = %+v, want target=camera kind=high", gotMod)
	}

	r.SetQuality("p1", "screen", "medium")

	// Garbage is ignored (not an error, no state change).
	if err := r.SetQuality("p1", "camera", "bogus"); err != nil {
		t.Fatalf("bad tier should be ignored, got %v", err)
	}
	if err := r.SetQuality("p1", "elsewhere", "high"); err != nil {
		t.Fatalf("bad target should be ignored, got %v", err)
	}

	// A late joiner's Joined carries the current caps so it can apply them.
	carol, cc := member("p3", "carol", RoleUser)
	r.Join(carol, "")
	var joined *signal.Joined
	cc.mu.Lock()
	for _, m := range cc.msgs {
		if j, ok := m.(signal.Joined); ok {
			jj := j
			joined = &jj
		}
	}
	cc.mu.Unlock()
	if joined == nil || joined.Quality.Camera != "high" || joined.Quality.Screen != "medium" {
		t.Errorf("late-joiner Joined.Quality = %+v, want camera=high screen=medium", joined)
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
