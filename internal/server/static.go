package server

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"io/fs"
	"net/http"
	"strings"
	"time"

	"github.com/ryanwohara/webrtc-chat/internal/web"
)

// startTime stamps every served asset's Last-Modified. embed.FS reports a zero
// modtime, which makes browsers revalidate to 304 and keep stale JS/CSS forever;
// a real per-process time means a redeploy (new process) busts client caches
// while assets still cache within a single run.
var startTime = time.Now()

// shell is the SPA app shell (index.html), read once from the embedded FS at
// startup so serving it is a plain byte write with an explicit content type.
var shell = mustReadShell()

func mustReadShell() []byte {
	b, err := fs.ReadFile(web.Assets, "index.html")
	if err != nil {
		panic(err)
	}
	return b
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

// handleStatic serves an embedded asset, or the SPA shell (index.html) for the
// app root and room paths. A request that names a real embedded file (e.g.
// /app.js, /style.css) is served from the embedded FS with its correct
// Content-Type; everything else — the root and room slugs like /lobby — returns
// the shell, and the client reads the room from location.pathname.
func (h *Hub) handleStatic(w http.ResponseWriter, r *http.Request) {
	p := strings.TrimPrefix(r.URL.Path, "/")
	if p != "" {
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
					w.Header().Set("Cache-Control", "no-cache") // revalidate; 304 within a run, 200 after redeploy
					http.ServeContent(w, r, p, startTime, rs)
					return
				}
			}
			http.FileServerFS(web.Assets).ServeHTTP(w, r) // fallback (should not happen for embed)
			return
		}
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Write(shell)
}
