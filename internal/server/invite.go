package server

import (
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/SwiftIRC/coyote/internal/token"
)

// boundInviteTTL is how long a CLAIMED invite stays collectable after its last use —
// the GC horizon for a session-bound link, slid forward on every (re)claim so the
// bound tab can refresh/reconnect for the whole call. Generous on purpose: the
// horizon only advances on a (re)claim, so it must exceed the longest a socket stays
// up between joins. A bound entry is nonce-locked, so a lingering one is harmless.
const boundInviteTTL = 24 * time.Hour

// inviteStore maps a short opaque id -> the verified token Claims it stands in for.
// The Anope module registers a token under a random id and hands out a compact link
// (origin/slug#i=<id>) instead of embedding the whole token, which is long enough to
// wrap and get truncated in an IRC NOTICE. Entries expire with the token they hold; a
// sweep drops stale ones so the map can't grow without bound.
type inviteStore struct {
	mu  sync.Mutex
	m   map[string]inviteEntry
	now func() time.Time
}

type inviteEntry struct {
	claims  token.Claims
	expires time.Time
	// claimedBy binds the invite to the first browser session that JOINS with it
	// (an opaque client nonce), making the link single-use: that session can
	// reconnect/refresh freely, but anyone else presenting the same id is refused.
	// Empty until the first bindable join. See claim.
	claimedBy string
}

func newInviteStore(now func() time.Time) *inviteStore {
	if now == nil {
		now = time.Now
	}
	return &inviteStore{m: map[string]inviteEntry{}, now: now}
}

func (s *inviteStore) put(id string, claims token.Claims) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.m[id] = inviteEntry{claims: claims, expires: time.Unix(claims.ExpiresAt, 0)}
}

// get returns the claims for a live id WITHOUT binding it — used by the read-only
// lobby peek, which must not consume the invite. An absent OR expired id returns
// ok=false; an expired one is dropped in passing.
func (s *inviteStore) get(id string) (token.Claims, bool) {
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
	return e.claims, true
}

// claim resolves an id for a JOIN and binds it to session, making the link single-use.
// The first bindable join (empty claimedBy, non-empty session) records the session and
// succeeds; later joins succeed only from that same session — which is how a network
// drop or page refresh from the original tab keeps working while anyone else who got
// the link is refused. A join with no session (an older client that can't bind) is
// allowed but leaves the invite unbound, so it stays reusable for such clients rather
// than locking the identity behind a nonce they never sent — no worse than the
// pre-single-use behavior. Once bound, the invite outlives its original short
// (first-use) TTL: the bound session keeps succeeding and each (re)claim slides a
// longer GC horizon, so its tab refreshes/reconnects for the whole call. An
// unbound absent/expired id returns ok=false (expired dropped — the first-use
// window is still enforced for ids that were never bound).
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

func (s *inviteStore) sweep() {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	for id, e := range s.m {
		if !now.Before(e.expires) {
			delete(s.m, id)
		}
	}
}

// handleInvite registers a token under a caller-chosen short id (the Anope module
// mints both), so the tokened link can be origin/slug#i=<id> and never wrap. It is
// authenticated with the shared secret like /api/provision; the token is verified (it
// is signed with the same secret) before its claims are stored, and the room is
// provisioned from those claims so the public link works for guests too.
func (h *Hub) handleInvite(w http.ResponseWriter, r *http.Request) {
	if h.cfg.Secret == "" {
		http.Error(w, "invites disabled", http.StatusForbidden)
		return
	}
	auth := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if subtle.ConstantTimeCompare([]byte(auth), []byte(h.cfg.Secret)) != 1 {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	var body struct {
		ID    string `json:"id"`
		Token string `json:"token"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
		http.Error(w, "bad body", http.StatusBadRequest)
		return
	}
	if body.ID == "" || body.Token == "" {
		http.Error(w, "missing id or token", http.StatusBadRequest)
		return
	}
	cl, err := token.Verify(body.Token, []byte(h.cfg.Secret), h.now())
	if err != nil {
		http.Error(w, "invalid token", http.StatusBadRequest)
		return
	}
	slug := strings.ToLower(cl.Room)
	if !slugRe.MatchString(slug) {
		http.Error(w, "bad room in token", http.StatusBadRequest)
		return
	}
	h.invites.put(body.ID, cl)
	// Provision from the token's own claims so the public link works without a
	// separate /api/provision call.
	h.reg.Provision(cl.Channel, slug, cl.Flags&token.FlagIdentifiedOnly != 0)
	h.log.Info("invite registered", "channel", cl.Channel, "room", slug)
	w.WriteHeader(http.StatusNoContent)
}

// handleInvitePeek returns the display name an invite grants, so the lobby can show it
// (read-only) exactly as it does for a token link. No auth: the id is itself the
// unguessable credential, so anyone holding it already has the identity it names.
func (h *Hub) handleInvitePeek(w http.ResponseWriter, r *http.Request) {
	cl, ok := h.invites.get(r.PathValue("id"))
	if !ok {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(map[string]string{"name": cl.Nick})
}
