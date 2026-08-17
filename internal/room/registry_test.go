package room

import (
	"errors"
	"testing"
	"time"

	"github.com/SwiftIRC/coyote/internal/token"
)

func TestResolveAdhoc(t *testing.T) {
	g := NewRegistry(true, time.Now)
	r, err := g.Resolve("random", nil)
	if err != nil {
		t.Fatal(err)
	}
	r2, _ := g.Resolve("random", nil)
	if r != r2 {
		t.Error("same slug resolved to different rooms")
	}
}

func TestResolveAdhocDisabled(t *testing.T) {
	g := NewRegistry(false, time.Now)
	if _, err := g.Resolve("random", nil); !errors.Is(err, ErrNotProvisioned) {
		t.Fatalf("want ErrNotProvisioned, got %v", err)
	}
}

func TestProvisionThenResolve(t *testing.T) {
	g := NewRegistry(false, time.Now)
	g.Provision("#swift", "swift", true)
	r, err := g.Resolve("swift", nil)
	if err != nil {
		t.Fatal(err)
	}
	// identified-only came through: a guest join must be rejected
	guest, _ := member("p1", "rando", RoleGuest)
	if err := r.Join(guest, ""); !errors.Is(err, ErrIdentifiedOnly) {
		t.Errorf("guest join on identified-only channel room: %v", err)
	}
	// channel rooms never promote first joiner
	ident, _ := member("p2", "alice", RoleUser)
	ident.Account = "alice"
	r.Join(ident, "")
	if ident.Role != RoleUser {
		t.Errorf("channel room promoted joiner to %q", ident.Role)
	}
}

func TestTokenProvisionsRoom(t *testing.T) {
	g := NewRegistry(false, time.Now)
	claims := &token.Claims{Channel: "#swift", Room: "swift", Account: "Ryan",
		Nick: "Ryan", Role: "op", Flags: token.FlagIdentifiedOnly}
	if _, err := g.Resolve("swift", claims); err != nil {
		t.Fatalf("token should provision: %v", err)
	}
	// mismatched slug in token must NOT provision other rooms
	if _, err := g.Resolve("other", claims); !errors.Is(err, ErrNotProvisioned) {
		t.Errorf("mismatched token slug provisioned a room: %v", err)
	}
}

func TestProvisionUpdatesLiveRoom(t *testing.T) {
	g := NewRegistry(false, time.Now)
	g.Provision("#swift", "swift", false)
	r, _ := g.Resolve("swift", nil)
	g.Provision("#swift", "swift", true) // ops flipped IDENTIFIED ON
	guest, _ := member("p1", "rando", RoleGuest)
	if err := r.Join(guest, ""); !errors.Is(err, ErrIdentifiedOnly) {
		t.Errorf("live room did not pick up IDENTIFIED ON: %v", err)
	}
}

func TestSweepGCAndMetaSurvives(t *testing.T) {
	now := time.Unix(1000, 0)
	clock := func() time.Time { return now }
	g := NewRegistry(true, clock)
	g.Provision("#swift", "swift", false)
	r, _ := g.Resolve("swift", nil)
	p, _ := member("p1", "alice", RoleUser)
	r.Join(p, "")
	r.Leave("p1")

	now = now.Add(30 * time.Second)
	g.Sweep()
	if r2, _ := g.Resolve("swift", nil); r2 != r {
		t.Fatal("room GC'd before grace expired")
	}

	now = now.Add(31 * time.Second)
	g.Sweep()
	r3, err := g.Resolve("swift", nil)
	if err != nil {
		t.Fatalf("meta must survive GC: %v", err)
	}
	if r3 == r {
		t.Error("room instance not GC'd after grace")
	}
	if count, _ := g.Peek("swift"); count != 0 {
		t.Errorf("Peek count = %d", count)
	}
}

func TestPeek(t *testing.T) {
	g := NewRegistry(true, time.Now)
	if count, locked := g.Peek("ghost"); count != 0 || locked {
		t.Errorf("Peek(ghost) = %d,%v", count, locked)
	}
	r, _ := g.Resolve("busy", nil)
	p, _ := member("p1", "alice", RoleUser)
	r.Join(p, "")
	r.SetLock("p1", "pw") // p1 is op (ad-hoc first joiner)
	if count, locked := g.Peek("busy"); count != 1 || !locked {
		t.Errorf("Peek(busy) = %d,%v", count, locked)
	}
}
