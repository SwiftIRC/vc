package server

import (
	"encoding/json"
	"io/fs"
	"path"
	"sort"
	"strings"

	"github.com/SwiftIRC/coyote/internal/web"
)

// The photographic background scenes are whatever .webp files are in
// assets/img/bg/. `//go:embed all:assets` fixes that set at build time, so
// scanning it here is a build-time decision surfaced at startup.
//
// Its own directory, rather than assets/img/, because a flat img/ would force
// every future image — an icon, an og:image, a placeholder — to be a background or
// to be specially excluded. A directory whose entire contents are backgrounds needs
// no rule and cannot be got wrong.
//
// Discovery rather than a hard-coded list because most of the shipped scenes are
// frames from copyrighted film and television which the project's MIT licence
// cannot cover (see THIRD-PARTY-NOTICES.md). They are untracked: present in a local
// checkout, absent from a clone. A fixed list would offer a clone chips whose
// images 404 and never render.
//
// It also makes the feature extensible in the obvious way: drop a .webp into
// assets/img/bg/, rebuild, and it appears — no manifest to update, no code to
// touch.

// scene is what the client receives. src is version-stamped so it inherits the
// immutable caching every other asset gets, and so it does not depend on the page
// path (a relative URL would resolve against document.baseURI and, on a room URL
// with a trailing slash, fetch the SPA shell instead of the image).
//
// There is no fallback colour here: the client paints black behind any scene whose
// image has not decoded (or never will). A per-image average colour looked tidier
// but meant carrying a hand-maintained manifest beside the files purely to make a
// failure state prettier, and it went stale the moment someone dropped in an image
// without updating it.
type scene struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Src   string `json:"src"`
}

// sceneDir is the one directory whose .webp contents are background scenes.
const sceneDir = "img/bg"

// buildScenes lists the scenes this build embedded, alphabetically by filename so
// the shell — built once at startup and cached for the process's life — is
// deterministic.
func buildScenes(assets fs.FS, version string) []scene {
	files, err := fs.Glob(assets, sceneDir+"/*.webp")
	if err != nil {
		return nil
	}
	sort.Strings(files)
	out := make([]scene, 0, len(files))
	for _, f := range files {
		base := path.Base(f)
		id := strings.TrimSuffix(base, path.Ext(base))
		out = append(out, scene{
			ID:    id,
			Label: labelFromID(id),
			Src:   "/v/" + version + "/" + sceneDir + "/" + base,
		})
	}
	return out
}

// labelFromID turns a filename stem into a chip label: "office-space" -> "Office
// Space". Naming the file well is the whole of naming the scene.
func labelFromID(id string) string {
	words := strings.FieldsFunc(id, func(r rune) bool { return r == '-' || r == '_' })
	for i, w := range words {
		words[i] = strings.ToUpper(w[:1]) + w[1:]
	}
	return strings.Join(words, " ")
}

// scenesJSON renders the scene list for injection into the app shell. Marshal
// escapes <, > and & by default, so the result is safe inside a <script> block and
// cannot terminate it early. A failure yields an empty array rather than breaking
// the shell: no scenes is a degraded picker, a broken shell is a blank app.
func scenesJSON(assets fs.FS, version string) []byte {
	b, err := json.Marshal(buildScenes(assets, version))
	if err != nil {
		return []byte("[]")
	}
	return b
}

// embeddedScenesJSON is the shell's scene payload, computed once at startup from
// the same embedded FS everything else is served from.
func embeddedScenesJSON() []byte { return scenesJSON(web.Assets, assetsVersion) }
