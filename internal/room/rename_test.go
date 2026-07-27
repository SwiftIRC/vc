package room

import (
	"testing"

	"github.com/ryanwohara/webrtc-chat/internal/signal"
)

func lastRenamed(c *fakeConn) (signal.PeerRenamed, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for i := len(c.msgs) - 1; i >= 0; i-- {
		if m, ok := c.msgs[i].(signal.PeerRenamed); ok {
			return m, true
		}
	}
	return signal.PeerRenamed{}, false
}

func countRenamed(c *fakeConn) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := 0
	for _, m := range c.msgs {
		if _, ok := m.(signal.PeerRenamed); ok {
			n++
		}
	}
	return n
}

func TestRenameBroadcastsToAll(t *testing.T) {
	r := New(Config{Slug: "s", Adhoc: true})
	alice, ac := member("p1", "alice", RoleUser)
	bob, bc := member("p2", "bob", RoleUser)
	if err := r.Join(alice, ""); err != nil {
		t.Fatal(err)
	}
	if err := r.Join(bob, ""); err != nil {
		t.Fatal(err)
	}
	r.Rename("p1", "alice2")
	for who, c := range map[string]*fakeConn{"alice": ac, "bob": bc} {
		m, ok := lastRenamed(c)
		if !ok || m.ID != "p1" || m.Name != "alice2" {
			t.Errorf("%s: got %+v ok=%v, want {p1 alice2}", who, m, ok)
		}
	}
	if alice.Name != "alice2" {
		t.Errorf("participant name = %q, want alice2", alice.Name)
	}
}

func TestRenameNoOpOnUnchangedEmptyMissing(t *testing.T) {
	r := New(Config{Slug: "s", Adhoc: true})
	alice, ac := member("p1", "alice", RoleUser)
	if err := r.Join(alice, ""); err != nil {
		t.Fatal(err)
	}
	before := countRenamed(ac)
	r.Rename("p1", "alice") // unchanged
	r.Rename("p1", "")      // empty
	r.Rename("nope", "x")   // missing participant
	if got := countRenamed(ac); got != before {
		t.Errorf("no-op renames broadcast %d PeerRenamed, want 0", got-before)
	}
}
