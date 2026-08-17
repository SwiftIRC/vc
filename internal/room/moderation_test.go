package room

import (
	"errors"
	"testing"

	"github.com/SwiftIRC/coyote/internal/signal"
)

// setup: adhoc room, alice joins first (auto-op), bob second (user).
func modRoom(t *testing.T) (*Room, *Participant, *fakeConn, *Participant, *fakeConn) {
	t.Helper()
	r := New(Config{Slug: "s", Adhoc: true})
	alice, ac := member("p1", "alice", RoleUser)
	bob, bc := member("p2", "bob", RoleUser)
	if err := r.Join(alice, ""); err != nil {
		t.Fatal(err)
	}
	if err := r.Join(bob, ""); err != nil {
		t.Fatal(err)
	}
	return r, alice, ac, bob, bc
}

func lastModeration(c *fakeConn) (signal.Moderation, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for i := len(c.msgs) - 1; i >= 0; i-- {
		if m, ok := c.msgs[i].(signal.Moderation); ok {
			return m, true
		}
	}
	return signal.Moderation{}, false
}

func TestNonOpCannotModerate(t *testing.T) {
	r, _, _, _, _ := modRoom(t)
	for _, err := range []error{
		r.Kick("p2", "p1"),
		r.Ban("p2", "p1"),
		r.MutePeer("p2", "p1", "mic"),
		r.SetLock("p2", "pw"),
	} {
		if !errors.Is(err, ErrNotOp) {
			t.Errorf("non-op action: %v, want ErrNotOp", err)
		}
	}
}

func TestKick(t *testing.T) {
	r, _, ac, _, bc := modRoom(t)
	if err := r.Kick("p1", "p2"); err != nil {
		t.Fatal(err)
	}
	bc.mu.Lock()
	var kicked bool
	for _, m := range bc.msgs {
		if k, ok := m.(signal.Kicked); ok && k.By == "alice" {
			kicked = true
		}
	}
	closed := bc.closed
	bc.mu.Unlock()
	// Option B: kick delivers the frame and removes the participant, but must
	// NOT close the socket (that would hard-close and race the frame write).
	// The client closes itself on receiving "kicked".
	if !kicked || closed {
		t.Errorf("target: kicked=%v closed=%v (want kicked=true, closed=false)", kicked, closed)
	}
	bc.mu.Lock()
	scheduled := bc.closeAfter
	bc.mu.Unlock()
	if scheduled <= 0 {
		t.Errorf("kick should schedule a bounded eviction, got closeAfter=%v", scheduled)
	}
	if r.Count() != 1 {
		t.Errorf("Count = %d after kick", r.Count())
	}
	if m, ok := lastModeration(ac); !ok || m.Action != "kick" || m.Target != "bob" {
		t.Errorf("feed entry = %+v ok=%v", m, ok)
	}
	// kicked ≠ banned: bob can rejoin
	bob2, _ := member("p3", "bob", RoleUser)
	if err := r.Join(bob2, ""); err != nil {
		t.Errorf("kicked user rejoin: %v", err)
	}
}

func TestBanByAccountAndIP(t *testing.T) {
	r, _, _, bob, _ := modRoom(t)
	bob.Account = "bobacct"
	if err := r.Ban("p1", "p2"); err != nil {
		t.Fatal(err)
	}
	again, _ := member("p3", "bob", RoleUser)
	again.Account = "bobacct"
	if err := r.Join(again, ""); !errors.Is(err, ErrBanned) {
		t.Errorf("banned account rejoin: %v", err)
	}
	// guest ban falls back to IP
	guest, _ := member("p4", "rando", RoleGuest)
	guest.IP = "10.0.0.9"
	r.Join(guest, "")
	if err := r.Ban("p1", "p4"); err != nil {
		t.Fatal(err)
	}
	guest2, _ := member("p5", "rando2", RoleGuest)
	guest2.IP = "10.0.0.9"
	if err := r.Join(guest2, ""); !errors.Is(err, ErrBanned) {
		t.Errorf("banned IP rejoin: %v", err)
	}
}

func TestMutePeerIsANudge(t *testing.T) {
	r, _, ac, _, bc := modRoom(t)
	if err := r.MutePeer("p1", "p2", "mic"); err != nil {
		t.Fatal(err)
	}
	if err := r.MutePeer("p1", "p2", "sausage"); err == nil {
		t.Error("invalid kind accepted")
	}
	bc.mu.Lock()
	var muted bool
	for _, m := range bc.msgs {
		if mm, ok := m.(signal.Muted); ok && mm.Kind == "mic" {
			muted = true
		}
	}
	stillOpen := !bc.closed
	bc.mu.Unlock()
	if !muted || !stillOpen {
		t.Errorf("nudge: muted=%v stillOpen=%v (mute must never disconnect)", muted, stillOpen)
	}
	if m, _ := lastModeration(ac); m.Action != "mute" || m.Kind != "mic" {
		t.Errorf("feed entry = %+v", m)
	}
}

func TestSetLockOpGatedAndBroadcasts(t *testing.T) {
	r, _, _, _, bc := modRoom(t)
	if err := r.SetLock("p1", "sesame"); err != nil {
		t.Fatal(err)
	}
	if !r.Locked() {
		t.Error("room not locked")
	}
	bc.mu.Lock()
	var lockedMsg bool
	for _, m := range bc.msgs {
		if _, ok := m.(signal.RoomLocked); ok {
			lockedMsg = true
		}
	}
	bc.mu.Unlock()
	if !lockedMsg {
		t.Error("RoomLocked not broadcast")
	}
	if err := r.SetLock("p1", ""); err != nil {
		t.Fatal(err)
	}
	if r.Locked() {
		t.Error("room still locked after unlock")
	}
}

func TestModerateUnknownTarget(t *testing.T) {
	r, _, _, _, _ := modRoom(t)
	if err := r.Kick("p1", "nope"); !errors.Is(err, ErrNoSuchPeer) {
		t.Errorf("Kick unknown: %v", err)
	}
}
