# Invite Survives Refresh — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `#i=` invite's *bound* session can refresh/reconnect for the whole call, instead of being evicted when the token's original short first-use TTL passes.

**Architecture:** In `invite.go` `claim()`, handle the bound-session branch *before* the expiry gate and slide a generous GC horizon (`boundInviteTTL`) forward on each (re)claim. Server-only; no client, protocol, or `get()`/`sweep()`/`put()` change.

**Tech Stack:** Go stdlib; `go test` with the invite store's injectable clock.

## Global Constraints

- Server-only change to `internal/server/invite.go` + tests in `internal/server/invite_test.go`. No client/protocol change.
- The invite is nonce-locked (`claimedBy`), so a lingering bound entry is harmless — only its binding session could ever claim it. `boundInviteTTL` is purely a GC horizon.
- Preserve all existing behavior: single-use vs a different session, legacy no-session reusability, and unbound-invite expiry at the original TTL (first-use window).
- `go test ./internal/server/`, `go vet ./internal/...`, and `gofmt -l internal/server/` must pass/be clean.
- Commit messages must NOT include any `Co-Authored-By` trailer.

---

### Task 1: Keep a claimed invite alive for its bound session

**Files:**
- Modify: `internal/server/invite.go` (add `boundInviteTTL` const; restructure `claim()` ~73–94)
- Test: `internal/server/invite_test.go`

**Interfaces:** none exported; `claim(id, session)` keeps its signature and existing semantics for every path except the bound-session one (now survives the original TTL).

- [ ] **Step 1: Write the failing behavioral test**

Add to `internal/server/invite_test.go`:

```go
func TestInviteBoundSessionSurvivesOriginalTTL(t *testing.T) {
	now := time.Unix(1000, 0)
	s := newInviteStore(func() time.Time { return now })
	s.put("id", token.Claims{Nick: "alice", ExpiresAt: 2000}) // original short first-use TTL

	// First use binds the invite to sessionA (within the original window).
	if cl, ok := s.claim("id", "sessionA"); !ok || cl.Nick != "alice" {
		t.Fatalf("first claim = %+v %v, want alice ok", cl, ok)
	}
	// Advance well past the original ExpiresAt (2000) — the refresh scenario.
	now = time.Unix(9000, 0)
	// The bound session can still re-claim (refresh/reconnect). This is the fix.
	if cl, ok := s.claim("id", "sessionA"); !ok || cl.Nick != "alice" {
		t.Errorf("bound reclaim after original expiry = %+v %v, want ok", cl, ok)
	}
	// A genuinely different session is still refused.
	if _, ok := s.claim("id", "sessionB"); ok {
		t.Error("a different session must still be refused for a bound invite")
	}
}
```

- [ ] **Step 2: Run the test — confirm it FAILS**

Run: `go test ./internal/server/ -run TestInviteBoundSessionSurvivesOriginalTTL`
Expected: FAIL — the bound reclaim at now=9000 is currently refused (the expiry gate deletes the entry past ExpiresAt=2000).

- [ ] **Step 3: Add the `boundInviteTTL` constant**

In `internal/server/invite.go`, add near the top (after the imports, before `inviteStore`):

```go
// boundInviteTTL is how long a CLAIMED invite stays collectable after its last use —
// the GC horizon for a session-bound link, slid forward on every (re)claim so the
// bound tab can refresh/reconnect for the whole call. Generous on purpose: the
// horizon only advances on a (re)claim, so it must exceed the longest a socket stays
// up between joins. A bound entry is nonce-locked, so a lingering one is harmless.
const boundInviteTTL = 24 * time.Hour
```

- [ ] **Step 4: Restructure `claim()`**

Replace the current `claim` body (the function at ~line 73):

```go
func (s *inviteStore) claim(id, session string) (token.Claims, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.m[id]
	if !ok {
		return token.Claims{}, false
	}
	if !s.now().Before(e.expires) {
		delete(s.m, id)
		return token.Claims{}, false
	}
	switch {
	case e.claimedBy == "" && session != "":
		e.claimedBy = session // first use binds the link to this session
		s.m[id] = e
		return e.claims, true
	case e.claimedBy == session:
		return e.claims, true // same session reconnecting/refreshing (covers the unbound no-session case)
	default:
		return token.Claims{}, false // bound to a different session — already used elsewhere
	}
}
```

with:

```go
func (s *inviteStore) claim(id, session string) (token.Claims, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.m[id]
	if !ok {
		return token.Claims{}, false
	}
	// The session that already bound this invite keeps it alive past the original
	// short first-use TTL, so its tab can refresh/reconnect for the whole call. Each
	// such (re)claim slides the GC horizon forward; the entry is nonce-locked, so a
	// lingering one is harmless. Checked BEFORE the expiry gate below — that gate is
	// the first-use window, and it must not evict the bound session.
	if e.claimedBy != "" && e.claimedBy == session {
		e.expires = s.now().Add(boundInviteTTL)
		s.m[id] = e
		return e.claims, true
	}
	// Every other path still requires the invite to be within its current window.
	if !s.now().Before(e.expires) {
		delete(s.m, id)
		return token.Claims{}, false
	}
	switch {
	case e.claimedBy == "" && session != "":
		// First use binds the link to this session and grants it the longer,
		// session-tied life (slid on each later reclaim above).
		e.claimedBy = session
		e.expires = s.now().Add(boundInviteTTL)
		s.m[id] = e
		return e.claims, true
	case e.claimedBy == "" && session == "":
		// Legacy no-session client on an unbound invite: allowed but never binds, so
		// it stays reusable under the original expiry (unchanged behavior).
		return e.claims, true
	default:
		return token.Claims{}, false // bound to a different session — already used elsewhere
	}
}
```

- [ ] **Step 5: Run the new test + the whole invite suite — confirm PASS**

Run: `go test ./internal/server/ -run TestInvite`
Expected: PASS — the new test passes, and the existing `TestInviteClaimSingleUse`, `TestInviteClaimNoSessionStaysReusable`, `TestInviteClaimExpired`, `TestInviteStoreExpiry`, `TestInviteRegisterAndPeek` all still pass (verified: the restructure preserves each — bound-elsewhere refused, no-session reusable, unbound-expired refused).

- [ ] **Step 6: Add the GC/slide test**

Add to `internal/server/invite_test.go` (references `boundInviteTTL`, now defined):

```go
func TestInviteBoundHorizonSlidesAndGCs(t *testing.T) {
	base := time.Unix(1000, 0)
	now := base
	s := newInviteStore(func() time.Time { return now })
	s.put("id", token.Claims{Nick: "alice", ExpiresAt: 2000})
	if _, ok := s.claim("id", "sessionA"); !ok { // bind → horizon = base + boundInviteTTL
		t.Fatal("bind failed")
	}
	// Reclaim just before the horizon slides it forward; a sweep then must NOT drop it.
	now = base.Add(boundInviteTTL - time.Minute)
	if _, ok := s.claim("id", "sessionA"); !ok {
		t.Fatal("reclaim before the horizon should succeed")
	}
	now = base.Add(boundInviteTTL + time.Minute) // past the ORIGINAL horizon, within the slid one
	s.sweep()
	if _, ok := s.claim("id", "sessionA"); !ok {
		t.Error("bound invite was swept despite a recent reclaim — horizon did not slide")
	}
	// Abandoned: no reclaim for a full horizon → sweep GCs it, and it is then gone.
	now = now.Add(boundInviteTTL + time.Minute)
	s.sweep()
	if _, ok := s.claim("id", "sessionA"); ok {
		t.Error("an abandoned bound invite should be swept after the horizon")
	}
}
```

- [ ] **Step 7: Run the full server suite, vet, and gofmt**

Run: `go test ./internal/server/ && go vet ./internal/... && gofmt -l internal/server/`
Expected: tests PASS, vet clean, `gofmt -l` prints nothing.

- [ ] **Step 8: Commit** (NO `Co-Authored-By` trailer)

```bash
git add internal/server/invite.go internal/server/invite_test.go
git commit -m "fix(server): keep a claimed invite alive for its bound session across refresh"
```

---

## Self-Review

**Spec coverage:**
- Bound-session branch before the expiry gate, sliding `boundInviteTTL` → Step 4.
- First-use binding also sets the horizon → Step 4.
- Legacy no-session preserved; different-session refused; unbound-expired refused → Step 4 + existing tests (Step 5).
- `get()`/`sweep()`/`put()`/client untouched → Global Constraints (no task edits them).
- Tests: bound survives original TTL, different-session refused, horizon slides + GC → Steps 1, 6.

**Placeholder scan:** No TBD/TODO; every step has complete code, exact commands, and expected results.

**Type consistency:** `boundInviteTTL` (a `time.Duration`) used consistently in `invite.go` and both tests; `claim(id, session)` signature unchanged; `e.expires` is a `time.Time` and `s.now().Add(boundInviteTTL)` matches.
