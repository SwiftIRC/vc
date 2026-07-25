package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/ryanwohara/webrtc-chat/internal/token"
)

func TestInviteRegisterAndPeek(t *testing.T) {
	secret := "test-secret-0123456789abcdef"
	h, srv := newTestHub(t, secret, true)

	tok, err := token.Sign(token.Claims{
		Channel: "#swift", Room: "swift", Account: "alice", Nick: "alice", Role: "op",
		IssuedAt: time.Now().Unix(), ExpiresAt: time.Now().Add(10 * time.Minute).Unix(),
	}, []byte(secret))
	if err != nil {
		t.Fatal(err)
	}
	body := `{"id":"short-id-123","token":"` + tok + `"}`

	// Register the invite (authenticated with the shared secret).
	req, _ := http.NewRequest("POST", srv.URL+"/api/invite", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+secret)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("POST /api/invite = %d, want 204", resp.StatusCode)
	}

	// The store resolves the id to the token's claims, and registering provisioned it.
	cl, ok := h.invites.get("short-id-123")
	if !ok || cl.Role != "op" || cl.Room != "swift" {
		t.Fatalf("invite lookup = %+v ok=%v, want op/swift", cl, ok)
	}
	if _, err := h.reg.Resolve("swift", nil); err != nil {
		t.Errorf("room not provisioned by invite: %v", err)
	}

	// Peek returns the display name for the lobby (no auth).
	gresp, gbody := httpGet(t, srv.URL+"/api/invite/short-id-123")
	if gresp.StatusCode != 200 {
		t.Fatalf("peek = %d, want 200", gresp.StatusCode)
	}
	var pk struct {
		Name string `json:"name"`
	}
	if json.Unmarshal([]byte(gbody), &pk); pk.Name != "alice" {
		t.Errorf("peek name = %q, want alice", pk.Name)
	}

	// Wrong secret is refused.
	bad, _ := http.NewRequest("POST", srv.URL+"/api/invite", strings.NewReader(body))
	bad.Header.Set("Authorization", "Bearer wrong")
	bresp, _ := http.DefaultClient.Do(bad)
	bresp.Body.Close()
	if bresp.StatusCode != http.StatusUnauthorized {
		t.Errorf("unauthorized invite = %d, want 401", bresp.StatusCode)
	}

	// An unknown id peeks 404.
	nresp, _ := httpGet(t, srv.URL+"/api/invite/nope")
	if nresp.StatusCode != http.StatusNotFound {
		t.Errorf("unknown invite peek = %d, want 404", nresp.StatusCode)
	}
}

func TestInviteClaimSingleUse(t *testing.T) {
	s := newInviteStore(func() time.Time { return time.Unix(1000, 0) })
	s.put("id", token.Claims{Nick: "alice", Role: "op", ExpiresAt: 2000})

	// Peek (get) must not bind — the lobby reads the name before anyone joins.
	if _, ok := s.get("id"); !ok {
		t.Fatal("peek before claim failed")
	}

	// First join binds the invite to session A.
	if cl, ok := s.claim("id", "sessionA"); !ok || cl.Nick != "alice" {
		t.Fatalf("first claim = %+v ok=%v, want alice/true", cl, ok)
	}
	// Same session reconnecting/refreshing keeps working.
	if _, ok := s.claim("id", "sessionA"); !ok {
		t.Error("same-session reclaim rejected — reconnect would break")
	}
	// A different session (someone else with the link) is refused: single-use.
	if _, ok := s.claim("id", "sessionB"); ok {
		t.Error("different session claimed an already-used invite")
	}
	// An empty session after binding is also refused (can't bypass the binding).
	if _, ok := s.claim("id", ""); ok {
		t.Error("empty session claimed a bound invite")
	}
}

func TestInviteClaimNoSessionStaysReusable(t *testing.T) {
	s := newInviteStore(func() time.Time { return time.Unix(1000, 0) })
	s.put("id", token.Claims{Nick: "bob", ExpiresAt: 2000})

	// A client that sends no session can't bind; the invite stays usable (no worse
	// than pre-single-use), and a later real session can still bind it.
	if _, ok := s.claim("id", ""); !ok {
		t.Fatal("no-session join rejected")
	}
	if _, ok := s.claim("id", ""); !ok {
		t.Error("second no-session join rejected — should stay reusable when unbound")
	}
	if _, ok := s.claim("id", "sessionA"); !ok {
		t.Error("real session could not bind an unbound invite")
	}
	if _, ok := s.claim("id", "sessionB"); ok {
		t.Error("invite reusable after a real session bound it")
	}
}

func TestInviteClaimExpired(t *testing.T) {
	s := newInviteStore(func() time.Time { return time.Unix(3000, 0) })
	s.put("id", token.Claims{Nick: "c", ExpiresAt: 2000}) // already expired at now=3000
	if _, ok := s.claim("id", "sessionA"); ok {
		t.Error("expired invite claimed")
	}
}

func TestInviteStoreExpiry(t *testing.T) {
	s := newInviteStore(func() time.Time { return time.Unix(1000, 0) })
	s.put("id", token.Claims{Nick: "a", ExpiresAt: 1500})
	if _, ok := s.get("id"); !ok {
		t.Fatal("live invite not resolved")
	}
	s.now = func() time.Time { return time.Unix(1600, 0) } // past expiry
	if _, ok := s.get("id"); ok {
		t.Error("expired invite still resolved")
	}
}

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
