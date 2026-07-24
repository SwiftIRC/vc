# Invite survives a refresh for its bound session

## Problem

A `#i=<id>` invite link is single-use, bound to the browser tab's session nonce
(`invite.go` `claim`): the first join binds it, and the same session is meant to
"reconnect/refresh freely." But `claim()` runs the expiry gate
(`!now.Before(e.expires)`) for *everyone*, and `e.expires` is the token's original
short first-use TTL. So once that short TTL passes, even the session that
legitimately bound the invite is refused, and a page refresh can no longer rejoin.

## Decision

Keep a claimed invite alive **as long as its bound session keeps using it**, instead
of expiring it at the original first-use TTL. The invite is already nonce-locked —
only the binding session can ever claim it — so a lingering entry is harmless (no
one else could use it); the expiry is only a GC horizon.

Implementation: for the **bound-session** claim, drop the expiry gate and **slide a
generous GC horizon** forward on each (re)claim. Only a genuinely different tab is
ever refused. Server-only — no client change (the client already re-sends the invite
+ session nonce on every join/reconnect via `pendingJoin`).

**Why not "drop the invite when the participant leaves":** the server removes a
participant *immediately* on socket close (`server.go` `defer rm.Leave(p.ID)`); the
reconnect grace is client-side only. A literal drop-on-leave would release the invite
during a refresh's brief disconnect — right before the reconnect re-claims it —
breaking the fix, unless a server-side release-grace timer is added (extra machinery
and timing edge cases). The sliding horizon is race-free and, because the invite is
nonce-locked, functionally equivalent.

## Change — `internal/server/invite.go`

Add a package constant:

```go
// boundInviteTTL is how long a CLAIMED invite stays valid after its last use — the
// GC horizon for a session-bound link, slid forward on every (re)claim so the bound
// tab can refresh/reconnect for the whole call. Generous on purpose: the horizon
// only advances on a (re)claim, so it must exceed the longest a socket stays up
// between joins; a bound entry is nonce-locked, so a lingering one is harmless.
const boundInviteTTL = 24 * time.Hour
```

Restructure `claim(id, session)` so the bound-session branch is handled *before* the
expiry gate and slides the horizon:

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
	// such (re)claim slides the GC horizon; the entry is nonce-locked, so a lingering
	// one is harmless. Checked BEFORE the expiry gate — that gate is the first-use
	// window, which must not evict the bound session.
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
		return token.Claims{}, false // bound to a different session — already used
	}
}
```

`get()` (read-only lobby peek) and `sweep()` are unchanged — both GC by `e.expires`,
so a bound invite is collected `boundInviteTTL` after its last use, and an abandoned
(never-claimed) link still dies at its original short TTL.

## Behavior matrix (after the change)

| Case | Before | After |
|------|--------|-------|
| Bound session re-claims within original TTL | ✅ | ✅ (slides horizon) |
| Bound session re-claims AFTER original TTL (the refresh bug) | ❌ refused | ✅ allowed, horizon slid |
| Different session claims a bound invite | ❌ refused | ❌ refused (unchanged) |
| Unbound invite, first use within window | ✅ binds | ✅ binds (horizon set) |
| Unbound invite past original TTL, first use | ❌ refused | ❌ refused (unchanged) |
| Legacy no-session client on unbound invite, within window | ✅ | ✅ (unchanged) |

## Testing — `internal/server/invite_test.go` (injectable clock)

- A bound session re-claims successfully **after** the original expiry (advance the
  clock past the token TTL but within `boundInviteTTL`).
- A **different** session is still refused after the original expiry.
- An **unbound** invite still dies at the original TTL: a first-use claim after the
  original expiry is refused (the first-use window is still enforced).
- The horizon **slides**: claim, advance the clock to near the new horizon, claim
  again from the same session → still ok (and `get`/`sweep` would not have dropped
  it), proving the expiry moved forward.
- Legacy no-session behavior preserved: a no-session claim on an unbound invite
  works within the window and does not bind.

## Out of scope

- No client change. No protocol/wire change. No change to `get()`/`sweep()`/`put()`.
- Not addressing the `#t=` long-token links (stateless, re-verified each time — not
  single-use, so unaffected).
