package server

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

func httpGet(t *testing.T, url string) (*http.Response, string) {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return resp, string(b)
}

func TestStaticShellAndAssets(t *testing.T) {
	_, srv := newTestHub(t, "", true)

	// GET / → the SPA shell (text/html, contains the mount point).
	resp, body := httpGet(t, srv.URL+"/")
	if resp.StatusCode != 200 {
		t.Errorf("GET / status = %d, want 200", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Errorf("GET / content-type = %q, want text/html", ct)
	}
	if !strings.Contains(body, `id="app"`) {
		t.Errorf("GET / body missing app shell: %q", body)
	}

	// GET /app.js → the embedded JS served with a JS content type.
	resp, body = httpGet(t, srv.URL+"/app.js")
	if resp.StatusCode != 200 {
		t.Errorf("GET /app.js status = %d, want 200", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, "javascript") {
		t.Errorf("GET /app.js content-type = %q, want a javascript type", ct)
	}
	if !strings.Contains(body, "SwiftIRC VC loaded") {
		t.Errorf("GET /app.js body = %q", body)
	}

	// GET /someroom → the shell, NOT a 404 (the client reads the slug from the URL).
	resp, body = httpGet(t, srv.URL+"/someroom")
	if resp.StatusCode != 200 {
		t.Errorf("GET /someroom status = %d, want 200", resp.StatusCode)
	}
	if !strings.Contains(body, `id="app"`) {
		t.Errorf("GET /someroom did not return the shell: %q", body)
	}
}

// TestStaticDoesNotShadowRoutes guards the Go 1.22 mux precedence: the GET /
// catch-all must not swallow the more specific health/WS routes.
func TestStaticDoesNotShadowRoutes(t *testing.T) {
	_, srv := newTestHub(t, "", true)

	// /healthz still returns "ok", not the shell.
	resp, body := httpGet(t, srv.URL+"/healthz")
	if resp.StatusCode != 200 || strings.TrimSpace(body) != "ok" {
		t.Errorf("GET /healthz = %d %q, want 200 \"ok\"", resp.StatusCode, body)
	}

	// /ws/{room} still upgrades to a WebSocket (routes to handleWS, not the shell).
	c := dialRoom(t, srv, "lobby")
	send(t, c, map[string]any{"type": "join", "name": "alice"})
	recv(t, c, "joined")
}
