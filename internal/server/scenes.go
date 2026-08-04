package server

import (
	"encoding/json"
	"io/fs"
	"path"
	"sort"
	"strings"

	"github.com/ryanwohara/webrtc-chat/internal/web"
)

// The photographic background scenes are discovered from what was EMBEDDED, not
// from a list hard-coded in the client. `//go:embed all:assets` fixes that set at
// build time, so scanning it here is a build-time decision surfaced at startup.
//
// This exists because four of the five scenes shipped originally are copyrighted
// film/TV frames that cannot carry the project's MIT licence (see
// THIRD-PARTY-NOTICES.md). They are untracked now: present in a local checkout,
// absent from a clone. A client with a hard-coded catalogue would have offered a
// clone four chips whose images 404 and which never render — so the catalogue
// follows the build instead.
//
// It also makes the feature extensible in the obvious way: drop a .webp into
// assets/img/, rebuild, and it appears. Metadata for a file listed in scenes.json
// is used as written; anything else gets a label derived from its filename and a
// neutral fallback colour.

// sceneMeta is one entry of assets/img/scenes.json: metadata only, no image data,
// so it stays in the repository whether or not its file does.
type sceneMeta struct {
	File     string `json:"file"`
	Label    string `json:"label"`
	Fallback string `json:"fallback"`
}

// scene is what the client receives. src is version-stamped so it inherits the
// immutable caching every other asset gets, and so it does not depend on the page
// path (a relative URL would resolve against document.baseURI and, on a room URL
// with a trailing slash, fetch the SPA shell instead of the image).
type scene struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	Src      string `json:"src"`
	Fallback string `json:"fallback"`
}

// neutralFallback covers an image with no recorded average colour. It is --border,
// the same neutral the picker already paints behind a non-painted chip.
const neutralFallback = "#2b2f37"

// buildScenes lists the scenes actually embedded, in scenes.json's curated order
// followed by any unlisted .webp alphabetically. version stamps each src.
func buildScenes(assets fs.FS, version string) []scene {
	files, err := fs.Glob(assets, "img/*.webp")
	if err != nil {
		return nil
	}
	present := make(map[string]bool, len(files))
	for _, f := range files {
		present[path.Base(f)] = true
	}

	var meta []sceneMeta
	if b, err := fs.ReadFile(assets, "img/scenes.json"); err == nil {
		// A malformed manifest must not cost a build its backgrounds: fall through
		// with no metadata and every present image still gets a derived entry.
		_ = json.Unmarshal(b, &meta)
	}

	out := make([]scene, 0, len(files))
	listed := make(map[string]bool, len(meta))
	for _, m := range meta {
		listed[m.File] = true
		if !present[m.File] {
			continue // recorded but not embedded — the untracked-image case
		}
		out = append(out, newScene(m.File, m.Label, m.Fallback, version))
	}

	var extra []string
	for f := range present {
		if !listed[f] {
			extra = append(extra, f)
		}
	}
	sort.Strings(extra) // deterministic: the shell is built once and cached
	for _, f := range extra {
		out = append(out, newScene(f, "", "", version))
	}
	return out
}

func newScene(file, label, fallback, version string) scene {
	id := strings.TrimSuffix(file, path.Ext(file))
	if label == "" {
		label = labelFromID(id)
	}
	if fallback == "" {
		fallback = neutralFallback
	}
	return scene{ID: id, Label: label, Src: "/v/" + version + "/img/" + file, Fallback: fallback}
}

// labelFromID turns a filename stem into a chip label: "office-space" -> "Office
// Space". Only used for an image with no scenes.json entry.
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
