package server

import (
	"encoding/json"
	"strings"
	"testing"
	"testing/fstest"
)

// Backgrounds are exactly assets/img/bg/*.webp. The directory boundary is the whole
// rule: anything else under assets/img/ is some other kind of image and must not
// become a background chip.
func TestBuildScenesTakesOnlyTheBgDirectory(t *testing.T) {
	assets := fstest.MapFS{
		"img/bg/a.webp":      &fstest.MapFile{Data: []byte("webp")},
		"img/bg/b.webp":      &fstest.MapFile{Data: []byte("webp")},
		"img/logo.webp":      &fstest.MapFile{Data: []byte("webp")}, // a sibling image, not a background
		"img/bg/README.md":   &fstest.MapFile{Data: []byte("# docs")},
		"img/bg/notes.txt":   &fstest.MapFile{Data: []byte("x")},
		"img/bg/deep/c.webp": &fstest.MapFile{Data: []byte("webp")}, // not recursive
	}
	var ids []string
	for _, s := range buildScenes(assets, "v1") {
		ids = append(ids, s.ID)
	}
	if strings.Join(ids, ",") != "a,b" {
		t.Fatalf("ids = %v, want a,b", ids)
	}
}

// The shell is built once at startup and cached, so the order must not depend on
// map iteration.
func TestBuildScenesIsDeterministicallyOrdered(t *testing.T) {
	assets := fstest.MapFS{
		"img/bg/zebra.webp":  &fstest.MapFile{Data: []byte("webp")},
		"img/bg/apple.webp":  &fstest.MapFile{Data: []byte("webp")},
		"img/bg/middle.webp": &fstest.MapFile{Data: []byte("webp")},
	}
	for i := 0; i < 20; i++ {
		var ids []string
		for _, s := range buildScenes(assets, "v1") {
			ids = append(ids, s.ID)
		}
		if strings.Join(ids, ",") != "apple,middle,zebra" {
			t.Fatalf("run %d: ids = %v, want apple,middle,zebra", i, ids)
		}
	}
}

// src must be absolute and version-stamped. A relative one would be resolved by
// fetch() against document.baseURI, so on a room URL with a trailing slash it would
// request /room/img/bg/x.webp — which the SPA catch-all answers with HTML and a 200.
func TestBuildScenesStampsAbsoluteVersionedSrc(t *testing.T) {
	assets := fstest.MapFS{"img/bg/a.webp": &fstest.MapFile{Data: []byte("webp")}}
	got := buildScenes(assets, "deadbeef")
	if len(got) != 1 {
		t.Fatalf("got %d scenes, want 1", len(got))
	}
	if got[0].Src != "/v/deadbeef/img/bg/a.webp" {
		t.Errorf("src = %q, want /v/deadbeef/img/bg/a.webp", got[0].Src)
	}
}

// Naming the file well is the whole of naming the scene — there is no manifest to
// keep in step with the directory.
func TestLabelsComeFromFilenames(t *testing.T) {
	for id, want := range map[string]string{
		"carina":       "Carina",
		"office-space": "Office Space",
		"my_photo":     "My Photo",
		"a-b-c":        "A B C",
		"x":            "X",
	} {
		if got := labelFromID(id); got != want {
			t.Errorf("labelFromID(%q) = %q, want %q", id, got, want)
		}
	}
}

// A build with no scenes at all is legitimate — a clone with the unlicensed images
// removed, or anyone who emptied the directory. It must produce an empty array, not
// a nil that marshals to null and lands in the page as `window.__vcScenes = null`.
func TestScenesJSONIsAlwaysAnArray(t *testing.T) {
	for name, assets := range map[string]fstest.MapFS{
		"empty bg dir": {"img/bg/README.md": &fstest.MapFile{Data: []byte("# docs")}},
		"no img tree":  {},
	} {
		b := scenesJSON(assets, "v1")
		var out []scene
		if err := json.Unmarshal(b, &out); err != nil {
			t.Errorf("%s: %s is not valid JSON: %v", name, b, err)
		}
		if string(b) == "null" {
			t.Errorf("%s: marshalled to null; the page would get window.__vcScenes = null", name)
		}
		if len(out) != 0 {
			t.Errorf("%s: got %d scenes, want none", name, len(out))
		}
	}
}

// The payload is injected into a <script> block in the app shell. encoding/json
// escapes <, > and & by default; if that ever stopped being true a filename could
// close the script tag early and blank the app.
func TestScenesJSONCannotCloseTheScriptTag(t *testing.T) {
	assets := fstest.MapFS{"img/bg/</script><b>hi.webp": &fstest.MapFile{Data: []byte("webp")}}
	if got := string(scenesJSON(assets, "v1")); strings.Contains(got, "</script>") {
		t.Fatalf("payload contains a literal </script>: %s", got)
	}
}
