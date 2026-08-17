package server

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strings"
	"time"

	"github.com/SwiftIRC/coyote/internal/web"
)

// startTime stamps every served asset's Last-Modified. embed.FS reports a zero
// modtime, which makes browsers revalidate to 304 and keep stale JS/CSS forever;
// a real per-process time means a redeploy (new process) busts client caches
// while assets still cache within a single run.
var startTime = time.Now()

// shell is the SPA app shell (index.html), read once from the embedded FS at startup
// so serving it is a plain byte write with an explicit content type. Its asset URLs
// are version-stamped as they are read (see mustReadShell).
var shell = mustReadShell()

// versionPlaceholder is the token index.html carries where the asset digest belongs.
const versionPlaceholder = "__ASSET_VERSION__"

// scenesPlaceholder is where the shell carries the background scenes this build
// embedded (see scenes.go). Injecting them into the shell — rather than having the
// client fetch a manifest — keeps the effect catalogue SYNCHRONOUS at module load.
// An async catalogue would mean resolveEffectId could run before the scenes existed
// and quietly downgrade a saved background to "none".
const scenesPlaceholder = "__BACKGROUND_SCENES__"

func mustReadShell() []byte {
	b, err := fs.ReadFile(web.Assets, "index.html")
	if err != nil {
		panic(err)
	}
	// Stamp the build's digest into the shell's asset URLs (/v/<version>/app.js). A
	// missing placeholder would ship a shell pointing at a literal "__ASSET_VERSION__"
	// path — a 404 and a blank app — so fail loudly at startup instead.
	if !bytes.Contains(b, []byte(versionPlaceholder)) {
		panic("index.html is missing " + versionPlaceholder)
	}
	if !bytes.Contains(b, []byte(scenesPlaceholder)) {
		panic("index.html is missing " + scenesPlaceholder)
	}
	b = bytes.ReplaceAll(b, []byte(versionPlaceholder), []byte(assetsVersion))
	return bytes.ReplaceAll(b, []byte(scenesPlaceholder), embeddedScenesJSON())
}

// assetsVersion is a digest of the embedded client assets, computed once at startup.
// The client fetches it at boot and polls /api/version; when it changes, the served
// page is out of date and the client offers a reload. It is derived from the asset
// CONTENTS (not the process start time), so a same-binary restart keeps it stable and
// only a redeploy that actually changed the client bumps it.
var assetsVersion = computeAssetsVersion()

func computeAssetsVersion() string {
	h := sha256.New()
	// fs.WalkDir visits in lexical order, so the digest is deterministic across runs
	// of the same build.
	_ = fs.WalkDir(web.Assets, ".", func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, readErr := fs.ReadFile(web.Assets, path)
		if readErr != nil {
			return readErr
		}
		io.WriteString(h, path)
		h.Write([]byte{0})
		h.Write(b)
		return nil
	})
	return hex.EncodeToString(h.Sum(nil))[:16]
}

// handleVersion reports the running build's asset version so a client with an older
// page loaded can detect it and prompt a reload. Never cached.
func (h *Hub) handleVersion(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(map[string]string{"version": assetsVersion})
}

// splitVersioned peels a "v/<version>/" prefix off an asset path. It reports the
// underlying asset path, whether the request was version-stamped at all, and whether
// that version is the running build's.
//
// A stale client still asks for its OLD version's URLs; those keep serving the CURRENT
// bytes (all we have) so the page self-heals, but only a CURRENT-version URL is safe to
// mark immutable — a rollback would otherwise leave the browser holding newer content
// under an older build's URL forever.
func splitVersioned(p string) (assetPath string, versioned, current bool) {
	rest, ok := strings.CutPrefix(p, "v/")
	if !ok {
		return p, false, false
	}
	version, assetPath, ok := strings.Cut(rest, "/")
	if !ok || assetPath == "" {
		return p, false, false
	}
	return assetPath, true, version == assetsVersion
}

// acceptsGzip reports whether the client advertised gzip in Accept-Encoding.
// A token scan is enough: gzip is the only encoding we ever offer, so there is
// nothing to rank, and an explicit "gzip;q=0" refusal only costs that client a
// decompression we do for them anyway.
func acceptsGzip(r *http.Request) bool {
	for _, part := range strings.Split(r.Header.Get("Accept-Encoding"), ",") {
		name, _, _ := strings.Cut(strings.TrimSpace(part), ";")
		if name == "gzip" {
			return true
		}
	}
	return false
}

// serveEmbeddedGzip serves an asset that is embedded ONLY in gzipped form
// (p+".gz"). It exists so ~12MB of MediaPipe WASM can ship as ~3.4MB: storing it
// raw would grow the binary by 65% instead of 20%.
//
// Clients that accept gzip get the stored bytes verbatim; anything else gets them
// decompressed on the fly. Reports whether it handled the request.
//
// Two things this deliberately does NOT do:
//   - Derive Content-Type from ".gz". A browser told application/gzip refuses to
//     compile a WebAssembly module. The type always comes from the ORIGINAL name.
//   - Use http.ServeContent. It would advertise byte ranges against the COMPRESSED
//     bytes while the client sees a decompressed body, so ranges are not offered.
func serveEmbeddedGzip(w http.ResponseWriter, r *http.Request, p string) bool {
	f, err := web.Assets.Open(p + ".gz")
	if err != nil {
		return false
	}
	defer f.Close()

	ctype := mime.TypeByExtension(path.Ext(p))
	if ctype == "" {
		// .tflite has no registered type; octet-stream is correct — MediaPipe
		// fetches the model as an ArrayBuffer and never sniffs it.
		ctype = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ctype)
	// A shared cache must not hand a gzipped body to a client that did not ask.
	w.Header().Set("Vary", "Accept-Encoding")

	// embed.FS has a zero modtime, so revalidation needs an explicit validator or
	// the runtime is re-fetched on every page load. assetsVersion is derived from
	// asset CONTENTS, so it changes exactly when the bytes do.
	etag := `"` + assetsVersion + `"`
	w.Header().Set("ETag", etag)
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return true
	}

	if acceptsGzip(r) {
		w.Header().Set("Content-Encoding", "gzip")
		_, _ = io.Copy(w, f)
		return true
	}
	zr, err := gzip.NewReader(f)
	if err != nil {
		http.Error(w, "corrupt asset", http.StatusInternalServerError)
		return true
	}
	defer zr.Close()
	_, _ = io.Copy(w, zr)
	return true
}

// handleStatic serves an embedded asset, or the SPA shell (index.html) for the
// app root and room paths. A request that names a real embedded file (e.g.
// /app.js, /style.css, or its version-stamped /v/<version>/app.js form) is served
// from the embedded FS with its correct Content-Type; everything else — the root
// and room slugs like /lobby — returns the shell, and the client reads the room
// from location.pathname.
func (h *Hub) handleStatic(w http.ResponseWriter, r *http.Request) {
	p := strings.TrimPrefix(r.URL.Path, "/")
	p, versioned, current := splitVersioned(p)
	if p != "" {
		// A current-version URL names exactly one build's bytes, so it can be
		// cached hard — that URL never changes meaning. Everything else
		// revalidates: 304 within a run, 200 after a redeploy.
		cache := "no-cache"
		if versioned && current {
			cache = "public, max-age=31536000, immutable"
		}
		// Some assets (the MediaPipe runtime) are embedded ONLY gzipped. Try that
		// form before the plain one, since the plain one does not exist for them.
		if _, err := fs.Stat(web.Assets, p+".gz"); err == nil {
			w.Header().Set("Cache-Control", cache)
			if serveEmbeddedGzip(w, r, p) {
				return
			}
		}
		// fs.Stat validates the path (rejecting "..") and tells a real asset
		// apart from a room slug. Directories fall through to the shell.
		if f, err := fs.Stat(web.Assets, p); err == nil && !f.IsDir() {
			file, err := web.Assets.Open(p)
			if err == nil {
				defer file.Close()
				// embed.FS files are seekable; ServeContent then sets the
				// Content-Type from the extension and handles Range + conditional
				// requests against startTime.
				if rs, ok := file.(io.ReadSeeker); ok {
					w.Header().Set("Cache-Control", cache)
					http.ServeContent(w, r, p, startTime, rs)
					return
				}
			}
			http.FileServerFS(web.Assets).ServeHTTP(w, r) // fallback (should not happen for embed)
			return
		}
		// A version-stamped path is unambiguously an asset request, never a room slug —
		// so a miss is a 404. Falling through to the shell would answer a stale client's
		// request for a since-renamed module with HTML, which it would try to parse as JS.
		if versioned {
			http.NotFound(w, r)
			return
		}
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Write(shell)
}
