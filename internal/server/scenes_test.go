package server

import (
	"encoding/json"
	"strings"
	"testing"
	"testing/fstest"
)

// The whole point of discovering scenes from the embedded FS: most scene images are
// untracked (copyrighted film/TV frames the MIT licence cannot cover), so a clone
// embeds fewer than a local checkout. A file recorded in scenes.json but absent from
// the build must simply not be offered — a chip whose image 404s would sit on its
// fallback colour forever with nothing to explain it.
func TestBuildScenesSkipsUnembeddedFiles(t *testing.T) {
	assets := fstest.MapFS{
		"img/scenes.json": &fstest.MapFile{Data: []byte(`[
			{"file":"gone.webp","label":"Gone","fallback":"#111111"},
			{"file":"here.webp","label":"Here","fallback":"#222222"}
		]`)},
		"img/here.webp": &fstest.MapFile{Data: []byte("webp")},
	}
	got := buildScenes(assets, "v1")
	if len(got) != 1 {
		t.Fatalf("got %d scenes, want 1: %+v", len(got), got)
	}
	if got[0].ID != "here" || got[0].Label != "Here" || got[0].Fallback != "#222222" {
		t.Errorf("metadata not carried through: %+v", got[0])
	}
}

// src must be absolute and version-stamped. A relative one would be resolved by
// fetch() against document.baseURI, so on a room URL with a trailing slash it would
// request /room/img/x.webp — which the SPA catch-all answers with HTML and a 200.
func TestBuildScenesStampsAbsoluteVersionedSrc(t *testing.T) {
	assets := fstest.MapFS{"img/a.webp": &fstest.MapFile{Data: []byte("webp")}}
	got := buildScenes(assets, "deadbeef")
	if len(got) != 1 {
		t.Fatalf("got %d scenes, want 1", len(got))
	}
	if got[0].Src != "/v/deadbeef/img/a.webp" {
		t.Errorf("src = %q, want /v/deadbeef/img/a.webp", got[0].Src)
	}
}

// Drop a .webp into assets/img/ and it should appear, with or without a manifest
// entry — that is what makes the feature usable by anyone who removed the
// unlicensed images and wants their own.
func TestBuildScenesPicksUpUnlistedImages(t *testing.T) {
	assets := fstest.MapFS{
		"img/scenes.json":   &fstest.MapFile{Data: []byte(`[{"file":"known.webp","label":"Known","fallback":"#333333"}]`)},
		"img/known.webp":    &fstest.MapFile{Data: []byte("webp")},
		"img/my_photo.webp": &fstest.MapFile{Data: []byte("webp")},
		"img/zzz.webp":      &fstest.MapFile{Data: []byte("webp")},
	}
	got := buildScenes(assets, "v1")
	var ids []string
	for _, s := range got {
		ids = append(ids, s.ID)
	}
	// Curated order first, then unlisted alphabetically — deterministic, because the
	// shell is built once at startup and cached for the process's life.
	if strings.Join(ids, ",") != "known,my_photo,zzz" {
		t.Fatalf("ids = %v, want known,my_photo,zzz", ids)
	}
	for _, s := range got[1:] {
		if s.Fallback != neutralFallback {
			t.Errorf("%s fallback = %q, want the neutral %q", s.ID, s.Fallback, neutralFallback)
		}
	}
	if got[1].Label != "My Photo" {
		t.Errorf("derived label = %q, want %q", got[1].Label, "My Photo")
	}
}

// A build with no images at all is a legitimate state (delete the unlicensed four
// and carina alike). It must produce an empty list, not a nil that marshals to null
// and lands in the page as `window.__vcScenes = null`.
func TestScenesJSONIsAlwaysAnArray(t *testing.T) {
	for name, assets := range map[string]fstest.MapFS{
		"no images":  {"img/scenes.json": &fstest.MapFile{Data: []byte(`[{"file":"x.webp"}]`)}},
		"no img dir": {},
		"bad manifest": {
			"img/scenes.json": &fstest.MapFile{Data: []byte("{ this is not json")},
		},
	} {
		b := scenesJSON(assets, "v1")
		var out []scene
		if err := json.Unmarshal(b, &out); err != nil {
			t.Errorf("%s: %s is not valid JSON: %v", name, b, err)
		}
		if string(b) == "null" {
			t.Errorf("%s: marshalled to null; the page would get window.__vcScenes = null", name)
		}
	}
}

// A malformed manifest must not cost a build its images: metadata is a nicety,
// the files are the feature.
func TestBuildScenesSurvivesABrokenManifest(t *testing.T) {
	assets := fstest.MapFS{
		"img/scenes.json": &fstest.MapFile{Data: []byte("{ not json at all")},
		"img/a.webp":      &fstest.MapFile{Data: []byte("webp")},
	}
	got := buildScenes(assets, "v1")
	if len(got) != 1 || got[0].ID != "a" {
		t.Fatalf("got %+v, want the image still offered", got)
	}
}

// The payload is injected into a <script> block in the app shell. encoding/json
// escapes <, > and & by default; if that ever stopped being true a label could
// close the script tag early and blank the app.
func TestScenesJSONCannotCloseTheScriptTag(t *testing.T) {
	assets := fstest.MapFS{
		"img/scenes.json": &fstest.MapFile{Data: []byte(`[{"file":"x.webp","label":"</script><b>hi"}]`)},
		"img/x.webp":      &fstest.MapFile{Data: []byte("webp")},
	}
	if got := string(scenesJSON(assets, "v1")); strings.Contains(got, "</script>") {
		t.Fatalf("payload contains a literal </script>: %s", got)
	}
}
