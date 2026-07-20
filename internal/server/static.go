package server

import (
	"io/fs"
	"net/http"
	"strings"

	"github.com/ryanwohara/webrtc-chat/internal/web"
)

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
			http.FileServerFS(web.Assets).ServeHTTP(w, r)
			return
		}
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write(shell)
}
