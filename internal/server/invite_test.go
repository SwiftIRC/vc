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
