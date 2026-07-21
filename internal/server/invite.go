package server

import (
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/ryanwohara/webrtc-chat/internal/token"
)

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

// get returns the claims for a live id. An absent OR expired id returns ok=false; an
// expired one is dropped in passing.
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
