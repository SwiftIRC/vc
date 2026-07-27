package room

import (
	"fmt"
	"sync"
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

// TestRenameRaceWithModeration exercises Rename running concurrently with a
// moderation action that reads both actor and target names (MutePeer). Rename
// mutates Participant.Name under r.mu, but requireOp/target used to return the
// pointer and let callers read .Name after the lock was released — a data race.
// Run with -race: it must fail pre-fix and pass post-fix.
func TestRenameRaceWithModeration(t *testing.T) {
	r := New(Config{Slug: "s", Adhoc: true})
	op, _ := member("op", "opname", RoleOp)
	victim, _ := member("v", "victim", RoleUser)
	if err := r.Join(op, ""); err != nil {
		t.Fatal(err)
	}
	if err := r.Join(victim, ""); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		for i := 0; i < 300; i++ {
			r.Rename("v", fmt.Sprintf("v%d", i))
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < 300; i++ {
			_ = r.MutePeer("op", "v", "mic")
		}
	}()
	wg.Wait()
}
