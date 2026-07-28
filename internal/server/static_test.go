package server

import (
	"compress/gzip"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
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

// The shell's asset URLs carry the build digest, and the whole module graph rides
// along on the path prefix (app.js's imports are relative), so a redeploy changes
// every JS/CSS URL and no cache can serve stale client code.
func TestShellStampsAssetURLsWithVersion(t *testing.T) {
	_, srv := newTestHub(t, "", true)

	_, body := httpGet(t, srv.URL+"/")
	for _, want := range []string{
		"/v/" + assetsVersion + "/app.js",
		"/v/" + assetsVersion + "/style.css",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("shell does not reference %q:\n%s", want, body)
		}
	}
	if strings.Contains(body, versionPlaceholder) {
		t.Errorf("shell still carries the unsubstituted %s placeholder", versionPlaceholder)
	}
}

// A current-version URL names one build's bytes for good, so it is served immutable —
// including the nested module paths the entry point imports.
func TestVersionedAssetsAreImmutable(t *testing.T) {
	_, srv := newTestHub(t, "", true)

	for _, path := range []string{"/app.js", "/style.css", "/ui/grid.js", "/lib/sounds.js"} {
		resp, body := httpGet(t, srv.URL+"/v/"+assetsVersion+path)
		if resp.StatusCode != 200 {
			t.Errorf("GET versioned %s = %d, want 200", path, resp.StatusCode)
			continue
		}
		if cc := resp.Header.Get("Cache-Control"); !strings.Contains(cc, "immutable") {
			t.Errorf("versioned %s Cache-Control = %q, want immutable", path, cc)
		}
		if body == "" {
			t.Errorf("versioned %s served an empty body", path)
		}
	}
}

// A stale client keeps requesting its OLD version's URLs. Those must still serve the
// current bytes (so the page self-heals on reload) but must NOT be marked immutable —
// a rollback would otherwise strand newer content under an older build's URL.
func TestStaleVersionServesCurrentBytesRevalidating(t *testing.T) {
	_, srv := newTestHub(t, "", true)

	resp, body := httpGet(t, srv.URL+"/v/0000000000000000/app.js")
	if resp.StatusCode != 200 {
		t.Fatalf("GET stale-versioned /app.js = %d, want 200", resp.StatusCode)
	}
	if cc := resp.Header.Get("Cache-Control"); cc != "no-cache" {
		t.Errorf("Cache-Control = %q, want no-cache", cc)
	}
	_, current := httpGet(t, srv.URL+"/v/"+assetsVersion+"/app.js")
	if body != current {
		t.Error("stale-versioned URL did not serve the current app.js bytes")
	}
}

// A version-stamped path is unambiguously an asset request, never a room slug, so a
// miss is a 404 — not the HTML shell, which a stale client would try to parse as JS.
func TestVersionedMissIs404(t *testing.T) {
	_, srv := newTestHub(t, "", true)

	resp, body := httpGet(t, srv.URL+"/v/"+assetsVersion+"/since-renamed.js")
	if resp.StatusCode != 404 {
		t.Errorf("GET versioned missing asset = %d, want 404", resp.StatusCode)
	}
	if strings.Contains(body, `id="app"`) {
		t.Error("versioned miss returned the SPA shell instead of a 404")
	}
}

// Unversioned asset URLs keep working (the mp3 chimes and the worklet are still
// referenced that way), and a room slug of "v" is still a room, not an asset path.
func TestUnversionedAssetsStillServed(t *testing.T) {
	_, srv := newTestHub(t, "", true)

	resp, _ := httpGet(t, srv.URL+"/app.js")
	if resp.StatusCode != 200 {
		t.Errorf("GET /app.js = %d, want 200", resp.StatusCode)
	}
	if cc := resp.Header.Get("Cache-Control"); cc != "no-cache" {
		t.Errorf("unversioned /app.js Cache-Control = %q, want no-cache", cc)
	}
	resp, body := httpGet(t, srv.URL+"/v")
	if resp.StatusCode != 200 || !strings.Contains(body, `id="app"`) {
		t.Errorf("GET /v = %d, want the shell for a room named \"v\"", resp.StatusCode)
	}
}

// The version endpoint reports a non-empty asset digest so the client can detect a
// redeploy. It must not be cached.
func TestVersionEndpoint(t *testing.T) {
	_, srv := newTestHub(t, "", true)

	resp, body := httpGet(t, srv.URL+"/api/version")
	if resp.StatusCode != 200 {
		t.Fatalf("GET /api/version = %d, want 200", resp.StatusCode)
	}
	if cc := resp.Header.Get("Cache-Control"); !strings.Contains(cc, "no-store") {
		t.Errorf("Cache-Control = %q, want no-store", cc)
	}
	var v struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal([]byte(body), &v); err != nil {
		t.Fatalf("decode %q: %v", body, err)
	}
	if v.Version == "" {
		t.Errorf("empty version in %q", body)
	}
	// Stable across calls within one build.
	_, body2 := httpGet(t, srv.URL+"/api/version")
	if body2 != body {
		t.Errorf("version changed between calls: %q vs %q", body, body2)
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

// A gzip-only embedded asset must reach the browser under its REAL name and type.
// Content-Type from ".gz" would be application/gzip, which makes the browser
// refuse to compile the WebAssembly module — the whole point of this path.
func TestServesGzipEmbeddedAssetToGzipClient(t *testing.T) {
	h, _ := newTestHub(t, "", true)
	req := httptest.NewRequest(http.MethodGet, "/vendor/mediapipe/vision_wasm_internal.wasm", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec := httptest.NewRecorder()
	h.handleStatic(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Content-Encoding"); got != "gzip" {
		t.Errorf("Content-Encoding = %q, want gzip", got)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/wasm" {
		t.Errorf("Content-Type = %q, want application/wasm", got)
	}
	if got := rec.Header().Get("Vary"); !strings.Contains(got, "Accept-Encoding") {
		t.Errorf("Vary = %q, want it to contain Accept-Encoding", got)
	}
	zr, err := gzip.NewReader(rec.Body)
	if err != nil {
		t.Fatalf("body is not gzip: %v", err)
	}
	magic := make([]byte, 4)
	if _, err := io.ReadFull(zr, magic); err != nil {
		t.Fatalf("read magic: %v", err)
	}
	if string(magic) != "\x00asm" {
		t.Errorf("decompressed magic = %q, want \\x00asm", magic)
	}
}

// A client that does not advertise gzip still gets a usable asset: we decompress
// on the fly rather than 406, so curl and any encoding-stripping proxy work.
func TestServesGzipEmbeddedAssetDecompressedWhenNotAccepted(t *testing.T) {
	h, _ := newTestHub(t, "", true)
	req := httptest.NewRequest(http.MethodGet, "/vendor/mediapipe/vision_wasm_internal.wasm", nil)
	req.Header.Set("Accept-Encoding", "identity")
	rec := httptest.NewRecorder()
	h.handleStatic(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Content-Encoding"); got != "" {
		t.Errorf("Content-Encoding = %q, want empty", got)
	}
	if got := rec.Body.Bytes(); len(got) < 4 || string(got[:4]) != "\x00asm" {
		t.Errorf("body does not start with WASM magic")
	}
}

// embed.FS reports a zero modtime, so without an explicit validator a 3.4MB
// runtime would be re-downloaded on every page load (Cache-Control: no-cache
// means "revalidate", not "do not store").
func TestGzipEmbeddedAssetRevalidatesWithETag(t *testing.T) {
	h, _ := newTestHub(t, "", true)
	req := httptest.NewRequest(http.MethodGet, "/vendor/mediapipe/vision_wasm_internal.wasm", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec := httptest.NewRecorder()
	h.handleStatic(rec, req)
	etag := rec.Header().Get("ETag")
	if etag == "" {
		t.Fatal("no ETag on a gzip-embedded asset")
	}

	req2 := httptest.NewRequest(http.MethodGet, "/vendor/mediapipe/vision_wasm_internal.wasm", nil)
	req2.Header.Set("Accept-Encoding", "gzip")
	req2.Header.Set("If-None-Match", etag)
	rec2 := httptest.NewRecorder()
	h.handleStatic(rec2, req2)
	if rec2.Code != http.StatusNotModified {
		t.Errorf("status = %d, want 304", rec2.Code)
	}
}
