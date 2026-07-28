# Virtual and Blurred Backgrounds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a participant blur or replace their camera background, chosen in the pre-join lobby and changeable mid-call.

**Architecture:** The raw camera track feeds a hidden `<video>` into a MediaPipe `ImageSegmenter`; a 2D-canvas compositor draws a background (blurred video, or a procedurally-painted canvas) and masks the person over it; `canvas.captureStream()` yields a processed track that goes **into** `media.stream`, replacing the raw device track there. Because both the lobby preview (`prejoin.js:251`) and the self tile (`grid.js:529`) bind `media.stream` exactly once, and `app.js:374` already republishes on `camera-track`, the effect reaches preview, self tile, and every remote peer with no change to those files.

**Tech Stack:** Vanilla ES modules (no build step), `@mediapipe/tasks-vision` (vendored, gzipped), Go 1.26 `embed`, `node --test` for pure logic.

**Spec:** `docs/superpowers/specs/2026-07-28-virtual-backgrounds-design.md`

## Global Constraints

- **Vanilla JS only.** No framework, no bundler, no transpile, no `node_modules` at runtime. The vendored MediaPipe bundle is the sole third-party blob, behind a wrapper we own — matching `vendor/noise-suppressor-worklet.min.js`.
- **Node 22** (`.nvmrc`). Run tests as `node --test internal/web/test/*.test.js` — the **glob form**; a bare directory argument fails in this sandbox.
- **Go 1.26+.** `go build ./...` and `go test ./internal/web/ ./internal/server/` must stay green.
- **Client-only feature.** No change to `internal/signal`, `internal/room`, `internal/sfu`, or the wire protocol.
- **SIMD-only MediaPipe.** Do not vendor `vision_wasm_nosimd_internal.*` (another 11.1 MB). SIMD is in Chrome 91+, Firefox 89+, Safari 16.4+.
- **Assets are embedded gzipped**, never raw. The `.wasm` is 11.5 MB raw and 3.38 MB gzipped.
- **Effect ids are frozen** once Task 4 lands: `none`, `blur`, `blur-strong`, `aurora`, `dusk`, `grid`, `depth`, `paper`. A rename silently orphans every saved preference.
- **Commit style:** conventional commits (`feat(web):`, `fix(server):`, `docs:`). **No `Co-Authored-By` trailer.** Do **not** `git push` — the user pushes and deploys.
- Baseline before starting: 68 JS tests pass, `go build ./...` clean, `go test ./internal/web/ ./internal/server/` passes.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `internal/server/static.go` | modify | Serve gzip-embedded assets with correct `Content-Type` + `Content-Encoding` |
| `internal/server/static_test.go` | modify | Cover the gzip branch both ways |
| `internal/web/assets/vendor/mediapipe/*` | create | Vendored runtime + model, all `.gz` |
| `internal/web/web_test.go` | modify | Assert the vendored files are embedded |
| `internal/web/assets/lib/fpsGuard.js` | create | Pure frame-rate watchdog |
| `internal/web/assets/lib/backgrounds.js` | create | Effect catalogue + procedural painters |
| `internal/web/assets/lib/segmenter.js` | create | MediaPipe lifecycle + canvas compositor |
| `internal/web/assets/net/media.js` | modify | `setBackground()` + parked-raw-track lifecycle |
| `internal/web/assets/ui/background.js` | create | `BackgroundPicker` component |
| `internal/web/assets/ui/prejoin.js` | modify | Mount picker in the lobby |
| `internal/web/assets/ui/controls.js` | modify | Mount picker in the ☰ menu |
| `internal/web/assets/style.css` | modify | Picker chip styles |
| `internal/web/test/fpsGuard.test.js` | create | Watchdog tests |
| `internal/web/test/backgrounds.test.js` | create | Catalogue + painter tests |
| `internal/web/test/prefs.test.js` | modify | `background` key round-trip |
| `README.md`, `MANUAL-TEST.md` | modify | Document the feature and its manual checks |

---

### Task 1: Pre-compressed asset serving

Assets that exist in the embed only as `<name>.gz` must be served under their real name, with the real content type. This lands first because Task 2's vendored files depend on it — without it they are unreachable.

**Files:**
- Modify: `internal/server/static.go` (imports; `handleStatic` at 106-146; new helpers)
- Test: `internal/server/static_test.go`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `GET /vendor/mediapipe/<file>` serves `<file>.gz` from the embed with `Content-Type` from `<file>`'s extension, `Content-Encoding: gzip` when accepted, `Vary: Accept-Encoding`, and an `ETag` of `assetsVersion`. Later tasks rely on this for `vision_bundle.mjs`, `vision_wasm_internal.js`, `vision_wasm_internal.wasm`, and `selfie_segmenter.tflite`.

- [ ] **Step 1: Write the failing test**

Append to `internal/server/static_test.go`:

```go
// A gzip-only embedded asset must reach the browser under its REAL name and type.
// Content-Type from ".gz" would be application/gzip, which makes the browser
// refuse to compile the WebAssembly module — the whole point of this path.
func TestServesGzipEmbeddedAssetToGzipClient(t *testing.T) {
	h := newTestHub(t)
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
	h := newTestHub(t)
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
	h := newTestHub(t)
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
```

Add to that file's imports: `compress/gzip`, `io`, `strings` (keep any already present).

**If `newTestHub` does not exist in `static_test.go`,** read the file and reuse whatever constructor its existing tests use; do not invent a second one.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./internal/server/ -run 'GzipEmbedded' -v`

Expected: FAIL. The three tests fail on status 200-vs-404 or a missing header, because neither the helper nor the vendored `.gz` file exists yet. (Task 2 adds the real asset; for now these fail on the missing file — that is the expected red.)

To keep this task self-contained, create a **placeholder** gzip asset so the branch is testable before the 3.4 MB vendoring lands:

```bash
mkdir -p internal/web/assets/vendor/mediapipe
printf '\x00asm\x01\x00\x00\x00' | gzip -9 > internal/web/assets/vendor/mediapipe/vision_wasm_internal.wasm.gz
```

Re-run; the tests now fail on the missing serving logic rather than the missing file.

- [ ] **Step 3: Write the implementation**

In `internal/server/static.go`, add to the import block: `"compress/gzip"`, `"mime"`, `"path"`.

Add these helpers above `handleStatic`:

```go
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
```

Now replace the body of the `if p != ""` block in `handleStatic` (lines 109-142) with:

```go
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./internal/server/ -run 'GzipEmbedded' -v && go test ./internal/server/ ./internal/web/`

Expected: the three new tests PASS and the whole `internal/server` suite stays green (the existing static tests must not regress — the `cache` refactor changes where the header is set, not its value).

- [ ] **Step 5: Commit**

```bash
git add internal/server/static.go internal/server/static_test.go internal/web/assets/vendor/mediapipe/
git commit -m "feat(server): serve gzip-embedded assets under their real name and type

Lets a large asset ship in the binary compressed and reach the browser
decompressed. Content-Type always comes from the original name: a browser
told application/gzip refuses to compile a WebAssembly module."
```

---

### Task 2: Vendor the MediaPipe runtime and model

**Files:**
- Create: `internal/web/assets/vendor/mediapipe/{vision_bundle.mjs,vision_wasm_internal.js,vision_wasm_internal.wasm,selfie_segmenter.tflite}.gz`
- Create: `internal/web/assets/vendor/mediapipe/README.md`
- Modify: `internal/web/web_test.go`

**Interfaces:**
- Consumes: Task 1's `serveEmbeddedGzip`.
- Produces: `/vendor/mediapipe/vision_bundle.mjs` (ESM entry, exports `FilesetResolver` and `ImageSegmenter`), `/vendor/mediapipe/` as the `forVisionTasks` base path, `/vendor/mediapipe/selfie_segmenter.tflite` as `modelAssetPath`. Task 5 imports these exact URLs.

- [ ] **Step 1: Write the failing test**

Replace `TestAssetsEmbedded` in `internal/web/web_test.go`:

```go
func TestAssetsEmbedded(t *testing.T) {
	for _, name := range []string{"index.html", "app.js"} {
		if _, err := fs.Stat(Assets, name); err != nil {
			t.Errorf("asset %q not embedded: %v", name, err)
		}
	}
}

// The background-effects runtime is embedded gzipped. A missing file here is a
// feature that is dead on arrival at runtime and that no JS test would notice,
// so assert each one explicitly rather than trusting the vendoring step.
func TestMediaPipeAssetsEmbedded(t *testing.T) {
	for _, name := range []string{
		"vendor/mediapipe/vision_bundle.mjs.gz",
		"vendor/mediapipe/vision_wasm_internal.js.gz",
		"vendor/mediapipe/vision_wasm_internal.wasm.gz",
		"vendor/mediapipe/selfie_segmenter.tflite.gz",
	} {
		info, err := fs.Stat(Assets, name)
		if err != nil {
			t.Errorf("asset %q not embedded: %v", name, err)
			continue
		}
		// Guards against a truncated or placeholder file being committed.
		if info.Size() < 1024 {
			t.Errorf("asset %q is only %d bytes — looks truncated", name, info.Size())
		}
	}
	// The no-SIMD fallback is deliberately not vendored; it would add ~11MB raw
	// for browsers this app does not otherwise support.
	if _, err := fs.Stat(Assets, "vendor/mediapipe/vision_wasm_nosimd_internal.wasm.gz"); err == nil {
		t.Error("no-SIMD build should not be vendored")
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./internal/web/ -run MediaPipe -v`

Expected: FAIL — three of the four files are absent, and the fourth (the Task 1 placeholder) is under 1024 bytes.

- [ ] **Step 3: Vendor the files**

```bash
cd /tmp && rm -rf mp-vendor && mkdir mp-vendor && cd mp-vendor
npm pack @mediapipe/tasks-vision
tar xzf mediapipe-tasks-vision-*.tgz

DEST="$OLDPWD/internal/web/assets/vendor/mediapipe"
# (run from the repo root instead if $OLDPWD is not the repo)
DEST=/home/rohara/Workspace/webrtc-chat/internal/web/assets/vendor/mediapipe
mkdir -p "$DEST"

gzip -9 -c package/vision_bundle.mjs               > "$DEST/vision_bundle.mjs.gz"
gzip -9 -c package/wasm/vision_wasm_internal.js    > "$DEST/vision_wasm_internal.js.gz"
gzip -9 -c package/wasm/vision_wasm_internal.wasm  > "$DEST/vision_wasm_internal.wasm.gz"

# The model is NOT in the npm package — fetch it once from Google's model CDN and
# commit it, so nothing is fetched from Google at runtime.
curl -fsSL -o selfie_segmenter.tflite \
  https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite
gzip -9 -c selfie_segmenter.tflite > "$DEST/selfie_segmenter.tflite.gz"

ls -l "$DEST"
```

Expected sizes: `vision_wasm_internal.wasm.gz` ≈ 3.38 MB, `vision_wasm_internal.js.gz` ≈ 80 KB, `vision_bundle.mjs.gz` ≈ 40 KB, `selfie_segmenter.tflite.gz` ≈ 212 KB.

**If the model URL 404s,** the version path has moved. List available versions at `https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/` and take the newest, or use `latest/` in place of `1/`. Record whichever URL worked in the README below — do not leave it undocumented.

Write `internal/web/assets/vendor/mediapipe/README.md`:

```markdown
# Vendored MediaPipe (tasks-vision)

Powers the background blur / virtual background effects (`lib/segmenter.js`).

Vendored rather than fetched at runtime so the binary stays self-contained and no
user's browser is sent to a Google endpoint.

## Contents

Everything is stored **gzipped** and served by `internal/server/static.go` under
its real name with `Content-Encoding: gzip`. Raw, these total ~12 MB; gzipped,
~3.7 MB.

| File | Source |
|---|---|
| `vision_bundle.mjs.gz` | `npm pack @mediapipe/tasks-vision` → `package/vision_bundle.mjs` |
| `vision_wasm_internal.js.gz` | same → `package/wasm/vision_wasm_internal.js` |
| `vision_wasm_internal.wasm.gz` | same → `package/wasm/vision_wasm_internal.wasm` |
| `selfie_segmenter.tflite.gz` | `https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite` |

The model is **not** in the npm package and must be fetched separately.

## Deliberate omission

`vision_wasm_nosimd_internal.*` is not vendored. It is another ~11 MB raw, and
WASM SIMD is available in Chrome 91+, Firefox 89+, and Safari 16.4+ — every
browser this app otherwise supports. `web_test.go` asserts it stays absent.

## Updating

Re-run the commands above, confirm `go test ./internal/web/` passes, and re-check
the manual segmentation-quality steps in `MANUAL-TEST.md` — a model change can
alter output quality without failing a single test.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./internal/web/ -run MediaPipe -v && go build ./... && ls -l webrtc-chat`

Expected: PASS. Binary is roughly 22 MB (was ~18.7 MB).

Verify it actually serves:

```bash
./webrtc-chat -addr :8099 &
sleep 1
curl -s -H 'Accept-Encoding: gzip' -D- -o /dev/null http://localhost:8099/vendor/mediapipe/vision_wasm_internal.wasm | grep -i 'content-\|etag'
kill %1
```

Expected: `Content-Type: application/wasm`, `Content-Encoding: gzip`.

- [ ] **Step 5: Commit**

```bash
git add internal/web/assets/vendor/mediapipe/ internal/web/web_test.go
git commit -m "feat(web): vendor the MediaPipe selfie-segmentation runtime

SIMD build only, stored gzipped: ~12MB raw becomes ~3.7MB embedded. The
model is not in the npm package and is fetched once from Google's model CDN
at vendoring time, never at runtime."
```

---

### Task 3: `lib/fpsGuard.js` — the frame-rate watchdog

**Files:**
- Create: `internal/web/assets/lib/fpsGuard.js`
- Test: `internal/web/test/fpsGuard.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `class FpsGuard`, constructed as `new FpsGuard({ graceMs?, windowMs?, minFps? })`. Methods: `push(nowMs) → void`, `check(nowMs) → boolean` (true exactly once), `reset() → void`, getter `tripped → boolean`. Exported constants `GRACE_MS = 3000`, `WINDOW_MS = 5000`, `MIN_FPS = 12`. Task 5 calls `push()` per composited frame and `check()` from a 1 s interval.

- [ ] **Step 1: Write the failing test**

Create `internal/web/test/fpsGuard.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { FpsGuard, GRACE_MS, WINDOW_MS, MIN_FPS } from "../assets/lib/fpsGuard.js";

// Drive the guard at a steady rate from t=0 to t=untilMs, checking as it goes.
// Returns the timestamp it tripped at, or null if it never did.
function run(guard, fps, untilMs) {
  const step = 1000 / fps;
  for (let t = 0; t <= untilMs; t += step) {
    guard.push(t);
    if (guard.check(t)) return t;
  }
  return null;
}

test("a healthy 30fps feed never trips", () => {
  const g = new FpsGuard();
  assert.equal(run(g, 30, 30000), null);
  assert.equal(g.tripped, false);
});

test("exactly MIN_FPS is acceptable and does not trip", () => {
  const g = new FpsGuard();
  assert.equal(run(g, MIN_FPS, 30000), null);
});

test("a sustained 5fps feed trips", () => {
  const g = new FpsGuard();
  const at = run(g, 5, 30000);
  assert.notEqual(at, null, "should have tripped");
  assert.equal(g.tripped, true);
});

test("the grace period protects a slow start", () => {
  const g = new FpsGuard();
  // Terrible throughput, but only during warm-up: no verdict is possible yet.
  for (let t = 0; t < GRACE_MS; t += 500) {
    g.push(t);
    assert.equal(g.check(t), false, `tripped during grace at t=${t}`);
  }
});

test("no verdict until a full window of post-grace history exists", () => {
  const g = new FpsGuard();
  const boundary = GRACE_MS + WINDOW_MS;
  for (let t = 0; t < boundary; t += 500) {
    g.push(t);
    assert.equal(g.check(t), false, `tripped too early at t=${t}`);
  }
});

test("a total stall trips even though push() stops being called", () => {
  const g = new FpsGuard();
  // A healthy start, then frames stop entirely — the compositor is wedged.
  for (let t = 0; t <= 4000; t += 1000 / 30) g.push(t);
  // check() is driven by a timer, so it keeps running with no frames arriving.
  let tripped = false;
  for (let t = 4000; t <= 20000 && !tripped; t += 1000) tripped = g.check(t);
  assert.equal(tripped, true, "a wedged compositor must be caught");
});

test("it trips at most once", () => {
  const g = new FpsGuard();
  const at = run(g, 2, 30000);
  assert.notEqual(at, null);
  // Every later check is silent — the caller already tore the pipeline down.
  for (let t = at + 1000; t < at + 20000; t += 1000) {
    assert.equal(g.check(t), false, `re-tripped at t=${t}`);
  }
});

test("reset re-arms it for a newly chosen effect", () => {
  const g = new FpsGuard();
  assert.notEqual(run(g, 2, 30000), null);
  g.reset();
  assert.equal(g.tripped, false);
  const g2 = new FpsGuard();
  assert.equal(run(g2, 30, 30000), null, "a fresh guard on a healthy feed is quiet");
});

test("thresholds are overridable so callers can tune without editing the module", () => {
  const g = new FpsGuard({ graceMs: 0, windowMs: 1000, minFps: 50 });
  assert.notEqual(run(g, 30, 10000), null, "30fps is below a 50fps floor");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test internal/web/test/fpsGuard.test.js`

Expected: FAIL — `Cannot find module '../assets/lib/fpsGuard.js'`.

- [ ] **Step 3: Write the implementation**

Create `internal/web/assets/lib/fpsGuard.js`:

```js
// A frame-rate watchdog for the background compositor. It answers exactly one
// question — "is this device keeping up?" — and does nothing about the answer:
// it owns no tracks, renders nothing, and reads no clock. The caller supplies
// every timestamp.
//
// That purity is the point. Segmentation is expensive enough on low-end phones
// that some of them cannot sustain a usable frame rate, and shipping a 5fps
// slideshow to the whole room is worse than shipping no effect. Deciding when to
// give up is fiddly, timing-dependent logic, so it lives here where `node --test`
// can drive it with synthetic timestamps instead of a real browser.
//
// Two entry points, because they catch different failures:
//   push(now)   record a composited frame.
//   check(now)  render a verdict. Driven from a timer as well as from the render
//               loop, so a TOTAL stall — where push() simply stops being called —
//               is caught. push() alone could never detect that.
//
// It trips at most once: the caller tears the pipeline down on the first true.
// reset() re-arms it when the user picks a different effect, so a device that
// choked on a virtual background still gets to try a cheap blur.

// Model warm-up and first-frame shader compilation are slow by nature; judging
// them would trip on every single start.
export const GRACE_MS = 3000;
// How much recent history a verdict is based on.
export const WINDOW_MS = 5000;
// Below this, no effect beats a stuttering one.
export const MIN_FPS = 12;

export class FpsGuard {
  constructor({ graceMs = GRACE_MS, windowMs = WINDOW_MS, minFps = MIN_FPS } = {}) {
    this.graceMs = graceMs;
    this.windowMs = windowMs;
    this.minFps = minFps;
    this.reset();
  }

  reset() {
    this._start = null;
    this._frames = [];
    this._tripped = false;
  }

  get tripped() {
    return this._tripped;
  }

  // Record one composited frame.
  push(nowMs) {
    if (this._tripped) return;
    if (this._start === null) this._start = nowMs;
    this._frames.push(nowMs);
    this._prune(nowMs);
  }

  // Render a verdict. Returns true exactly once, on the first observation that
  // sustained throughput is too low to continue.
  check(nowMs) {
    if (this._tripped || this._start === null) return false;
    // Judge only once a full window of POST-warm-up history exists. Before that
    // the window is partly filled with warm-up frames (or empty), so any verdict
    // would be about start-up cost rather than steady-state throughput.
    if (nowMs - this._start < this.graceMs + this.windowMs) return false;
    this._prune(nowMs);
    // Frames actually delivered, over the window's real length — not over the
    // span between the frames we happen to hold. A wedged compositor lands here
    // with zero frames and a rate of 0, which is exactly the verdict we want.
    const fps = this._frames.length / (this.windowMs / 1000);
    if (fps >= this.minFps) return false;
    this._tripped = true;
    return true;
  }

  // Drop frames that have aged out, keeping the array O(fps × windowSeconds).
  _prune(nowMs) {
    const cutoff = nowMs - this.windowMs;
    let drop = 0;
    while (drop < this._frames.length && this._frames[drop] < cutoff) drop++;
    if (drop > 0) this._frames.splice(0, drop);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test internal/web/test/fpsGuard.test.js`

Expected: PASS, 9 tests.

Then confirm nothing else broke: `node --test internal/web/test/*.test.js` → 77 pass.

- [ ] **Step 5: Commit**

```bash
git add internal/web/assets/lib/fpsGuard.js internal/web/test/fpsGuard.test.js
git commit -m "feat(web): frame-rate watchdog for the background compositor

Pure state machine over caller-supplied timestamps, so the timing logic is
testable without a browser. check() is timer-driven as well as frame-driven
so a total compositor stall is caught, which push() alone cannot detect."
```

---

### Task 4: `lib/backgrounds.js` — catalogue and procedural painters

**Files:**
- Create: `internal/web/assets/lib/backgrounds.js`
- Test: `internal/web/test/backgrounds.test.js`
- Modify: `internal/web/test/prefs.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `EFFECTS` — frozen array of `{ id, label, kind }` where `kind` is `"none" | "blur" | "paint"`; blur entries add `radius` (fraction of frame width), paint entries add `paint(ctx, w, h)`.
  - `resolveEffectId(id) → string` — returns `id` if known, else `"none"`.
  - `effectById(id) → object` — always returns a catalogue entry, never undefined.
  - Named painters `paintAurora`, `paintDusk`, `paintGrid`, `paintDepth`, `paintPaper`, each `(ctx, w, h) => void`.
  - Tasks 5 and 7 both call painters — Task 5 at frame size, Task 7 at 48×27 for thumbnails.

- [ ] **Step 1: Write the failing test**

Create `internal/web/test/backgrounds.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { EFFECTS, resolveEffectId, effectById } from "../assets/lib/backgrounds.js";

// A recording stand-in for CanvasRenderingContext2D. Node has no canvas, but the
// properties that matter here — does the painter cover the frame, does it leave
// global state dirty — are observable from the call log alone.
function fakeCtx(w, h) {
  const calls = [];
  const ctx = {
    canvas: { width: w, height: h },
    globalCompositeOperation: "source-over",
    filter: "none",
    fillStyle: "",
    fillRect: (x, y, rw, rh) => calls.push({ op: "fillRect", x, y, w: rw, h: rh }),
    beginPath: () => calls.push({ op: "beginPath" }),
    arc: () => calls.push({ op: "arc" }),
    fill: () => calls.push({ op: "fill" }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
  };
  return { ctx, calls };
}

// The id set is a PUBLIC contract: it is written into localStorage. Renaming an
// id silently orphans every saved preference, and nothing else would catch it.
test("the effect id set is frozen", () => {
  assert.deepEqual(
    EFFECTS.map((e) => e.id),
    ["none", "blur", "blur-strong", "aurora", "dusk", "grid", "depth", "paper"],
  );
});

test("every effect is well formed for its kind", () => {
  for (const e of EFFECTS) {
    assert.ok(e.label, `${e.id} has no label`);
    assert.ok(["none", "blur", "paint"].includes(e.kind), `${e.id} has kind ${e.kind}`);
    if (e.kind === "blur") {
      assert.equal(typeof e.radius, "number", `${e.id} needs a radius`);
      assert.ok(e.radius > 0 && e.radius < 0.2, `${e.id} radius ${e.radius} is out of range`);
    }
    if (e.kind === "paint") assert.equal(typeof e.paint, "function", `${e.id} needs a painter`);
  }
});

test("ids are unique", () => {
  assert.equal(new Set(EFFECTS.map((e) => e.id)).size, EFFECTS.length);
});

test("blur-strong is actually stronger than blur", () => {
  const light = EFFECTS.find((e) => e.id === "blur");
  const strong = EFFECTS.find((e) => e.id === "blur-strong");
  assert.ok(strong.radius > light.radius);
});

test("an unknown stored preference falls back to none rather than throwing", () => {
  assert.equal(resolveEffectId("aurora"), "aurora");
  assert.equal(resolveEffectId("beach-sunset"), "none"); // a since-removed id
  assert.equal(resolveEffectId(undefined), "none");
  assert.equal(resolveEffectId(null), "none");
  assert.equal(resolveEffectId(""), "none");
  assert.equal(resolveEffectId(42), "none");
});

test("effectById always returns an entry", () => {
  assert.equal(effectById("dusk").id, "dusk");
  assert.equal(effectById("nonsense").id, "none");
  assert.equal(effectById(undefined).id, "none");
});

test("every painter covers the whole frame", () => {
  for (const e of EFFECTS.filter((x) => x.kind === "paint")) {
    const { ctx, calls } = fakeCtx(640, 360);
    e.paint(ctx, 640, 360);
    const covers = calls.some((c) => c.op === "fillRect" && c.x === 0 && c.y === 0 && c.w === 640 && c.h === 360);
    assert.ok(covers, `${e.id} never fills the full frame — the camera would show through`);
  }
});

test("no painter leaks global canvas state", () => {
  // Aurora composites its glows with "lighter". Leaving that set would corrupt
  // whatever the compositor draws next, on a shared context.
  for (const e of EFFECTS.filter((x) => x.kind === "paint")) {
    const { ctx } = fakeCtx(640, 360);
    e.paint(ctx, 640, 360);
    assert.equal(ctx.globalCompositeOperation, "source-over", `${e.id} left compositing dirty`);
    assert.equal(ctx.filter, "none", `${e.id} left a filter set`);
  }
});

test("painters are deterministic — no per-frame shimmer", () => {
  for (const e of EFFECTS.filter((x) => x.kind === "paint")) {
    const a = fakeCtx(320, 180);
    const b = fakeCtx(320, 180);
    e.paint(a.ctx, 320, 180);
    e.paint(b.ctx, 320, 180);
    assert.deepEqual(a.calls, b.calls, `${e.id} draws differently on identical input`);
  }
});

test("painters scale to thumbnail size without dividing by zero", () => {
  for (const e of EFFECTS.filter((x) => x.kind === "paint")) {
    const { ctx, calls } = fakeCtx(48, 27);
    e.paint(ctx, 48, 27); // must not throw
    assert.ok(calls.length > 0, `${e.id} drew nothing at thumbnail size`);
  }
});
```

Append to `internal/web/test/prefs.test.js`:

```js
test("the background choice round-trips alongside the other media prefs", () => {
  stubStorage();
  saveMediaPrefs({ mic: true, camera: true, cameraId: "cam-1" });
  saveMediaPrefs({ background: "aurora" }); // must not disturb the rest
  assert.deepEqual(loadMediaPrefs(), { mic: true, camera: true, cameraId: "cam-1", background: "aurora" });
  saveMediaPrefs({ background: "none" });
  assert.equal(loadMediaPrefs().background, "none");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test internal/web/test/backgrounds.test.js internal/web/test/prefs.test.js`

Expected: `backgrounds.test.js` fails with `Cannot find module`. `prefs.test.js` should **pass** already — `saveMediaPrefs` is a generic merge and needs no change. If it fails, stop and read `prefs.js`; do not modify it to force the test green.

- [ ] **Step 3: Write the implementation**

Create `internal/web/assets/lib/backgrounds.js`:

```js
// The background-effect catalogue, and the painters that draw the virtual ones.
//
// Backgrounds are drawn in code rather than shipped as image files. That keeps
// the binary from carrying photo assets, sidesteps image licensing entirely, and
// stays sharp at any resolution — the same painter fills a 1080p frame and a
// 48x27 picker thumbnail, so a chip is always an exact preview of the effect.
//
// Every painter must:
//   - fill the ENTIRE (w, h) rect, or the real camera shows through at the edges;
//   - be deterministic — no Math.random, or the background shimmers frame to
//     frame, which reads as a glitch;
//   - restore any global context state it changed, since the compositor reuses
//     one context.
// All three are enforced by test/backgrounds.test.js.
//
// Sizes are expressed as fractions of w/h for the same reason: a pixel constant
// tuned at 720p looks wrong at 480p and invisible in a thumbnail.

// --- painter helpers ---

function fill(ctx, w, h, color) {
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, h);
}

// A soft radial wash placed at (x, y) as a fraction of the frame, with radius r
// as a fraction of the frame's longer side.
function glow(ctx, w, h, { x, y, r, from, to }) {
  const cx = w * x;
  const cy = h * y;
  const radius = Math.max(w, h) * r;
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
  g.addColorStop(0, from);
  g.addColorStop(1, to);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

// --- painters ---

// Deep night sky with additive colour washes.
export function paintAurora(ctx, w, h) {
  fill(ctx, w, h, "#0d1b2a");
  ctx.globalCompositeOperation = "lighter"; // washes add, rather than occlude
  glow(ctx, w, h, { x: 0.25, y: 0.3, r: 0.75, from: "rgba(80, 60, 190, 0.85)", to: "rgba(80, 60, 190, 0)" });
  glow(ctx, w, h, { x: 0.75, y: 0.65, r: 0.7, from: "rgba(32, 150, 160, 0.75)", to: "rgba(32, 150, 160, 0)" });
  glow(ctx, w, h, { x: 0.55, y: 0.15, r: 0.55, from: "rgba(150, 70, 200, 0.55)", to: "rgba(150, 70, 200, 0)" });
  ctx.globalCompositeOperation = "source-over"; // never leave this set
}

// A warm horizon, darkest at the top so a face stays the brightest thing on screen.
export function paintDusk(ctx, w, h) {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "#141a2e");
  g.addColorStop(0.55, "#3a2b4a");
  g.addColorStop(0.82, "#8a4a46");
  g.addColorStop(1, "#c9764a");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

// The app's own dark ground with a faint accent dot grid, vignetted so the dots
// fall away at the edges and never compete with the subject.
export function paintGrid(ctx, w, h) {
  fill(ctx, w, h, "#14161a"); // --bg
  const pitch = w / 24; // fraction of width, so the pattern reads the same at any size
  const r = Math.max(0.5, pitch * 0.06);
  ctx.fillStyle = "rgba(76, 141, 255, 0.22)"; // --accent, well faded
  for (let y = pitch / 2; y < h; y += pitch) {
    for (let x = pitch / 2; x < w; x += pitch) {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  glow(ctx, w, h, { x: 0.5, y: 0.5, r: 0.8, from: "rgba(20, 22, 26, 0)", to: "rgba(20, 22, 26, 0.85)" });
}

// A single accent-tinted pool of light behind the head, heavily vignetted.
export function paintDepth(ctx, w, h) {
  fill(ctx, w, h, "#0f1116");
  glow(ctx, w, h, { x: 0.5, y: 0.42, r: 0.62, from: "rgba(76, 141, 255, 0.42)", to: "rgba(76, 141, 255, 0)" });
  glow(ctx, w, h, { x: 0.5, y: 0.5, r: 0.95, from: "rgba(15, 17, 22, 0)", to: "rgba(15, 17, 22, 0.9)" });
}

// A light neutral, for anyone in a bright room where the dark options look odd.
export function paintPaper(ctx, w, h) {
  const g = ctx.createLinearGradient(0, 0, w * 0.3, h);
  g.addColorStop(0, "#f4f1ea");
  g.addColorStop(1, "#dcd6c8");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  glow(ctx, w, h, { x: 0.5, y: 0.5, r: 0.9, from: "rgba(120, 110, 90, 0)", to: "rgba(120, 110, 90, 0.28)" });
}

// --- the catalogue ---

// Blur radii are fractions of frame WIDTH, so a given strength looks the same at
// 480p and 1080p. A pixel constant would be a wall at one resolution and barely
// visible at another.
export const EFFECTS = Object.freeze([
  Object.freeze({ id: "none", label: "None", kind: "none" }),
  Object.freeze({ id: "blur", label: "Blur", kind: "blur", radius: 0.012 }),
  Object.freeze({ id: "blur-strong", label: "Blur+", kind: "blur", radius: 0.03 }),
  Object.freeze({ id: "aurora", label: "Aurora", kind: "paint", paint: paintAurora }),
  Object.freeze({ id: "dusk", label: "Dusk", kind: "paint", paint: paintDusk }),
  Object.freeze({ id: "grid", label: "Grid", kind: "paint", paint: paintGrid }),
  Object.freeze({ id: "depth", label: "Depth", kind: "paint", paint: paintDepth }),
  Object.freeze({ id: "paper", label: "Paper", kind: "paint", paint: paintPaper }),
]);

// The saved-preference gate. Effect ids live in localStorage, so a rename, a
// downgrade, or a hand-edited value can all present an id this build has never
// heard of. Resolve to "none" rather than throwing or leaving the pipeline in an
// undefined state — the worst outcome should be "no effect", never "no camera".
export function resolveEffectId(id) {
  return EFFECTS.some((e) => e.id === id) ? id : "none";
}

// Always returns a catalogue entry, so callers never guard for undefined.
export function effectById(id) {
  const wanted = resolveEffectId(id);
  return EFFECTS.find((e) => e.id === wanted) || EFFECTS[0];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test internal/web/test/*.test.js`

Expected: PASS — 77 from before plus 10 new backgrounds tests plus 1 new prefs test = 88.

- [ ] **Step 5: Commit**

```bash
git add internal/web/assets/lib/backgrounds.js internal/web/test/backgrounds.test.js internal/web/test/prefs.test.js
git commit -m "feat(web): background effect catalogue and procedural painters

Backgrounds are drawn in code rather than shipped as images: no photo assets
in the binary, no image licensing, and sharp at any size — the same painter
fills a 1080p frame and a 48x27 picker thumbnail.

Tests enforce the three properties a painter must have (covers the frame,
deterministic, restores global context state) and freeze the id set, which is
a public contract because it is written to localStorage."
```

---

### Task 5: `lib/segmenter.js` — the MediaPipe pipeline

Browser-only; no unit test (same call as `media.js` and `confirm.js`). Verification is `node --check`, a module-load smoke test, and the manual pass in Task 9.

**Files:**
- Create: `internal/web/assets/lib/segmenter.js`

**Interfaces:**
- Consumes: `FpsGuard` (Task 3); `effectById` (Task 4); `/vendor/mediapipe/*` (Task 2).
- Produces: `class BackgroundSegmenter`, constructed as `new BackgroundSegmenter({ onBail })`. Methods:
  - `async start(rawTrack, effectId) → MediaStreamTrack` — resolves with the composited track; rejects if the model or camera frame cannot be brought up.
  - `setEffect(effectId) → void` — switch effect without rebuilding the model.
  - `stop() → void` — idempotent teardown; stops the composited track, cancels loops, releases the model.
  - getter `track → MediaStreamTrack | null`.
  - `onBail()` is invoked at most once, from the FPS guard, on the same tick the guard trips. Task 6 supplies it.

- [ ] **Step 1: Write the module**

Create `internal/web/assets/lib/segmenter.js`:

```js
// Background blur / virtual background: the media pipeline behind the effect.
//
// The shape mirrors the noise-suppression graph in media.js one level up. There,
// a raw mic feeds an AudioWorklet and the PROCESSED track is what gets published.
// Here a raw camera track feeds a segmentation model and a canvas compositor, and
// the composited track is what gets published.
//
//   raw camera track ──► hidden <video> ──► ImageSegmenter ──► person mask
//                              │                                   │
//                              └──────► canvas compositor ◄────────┘
//                                              │
//                                      captureStream(24)
//
// This module owns the model, the canvases, and the render loop. It does NOT own
// tracks beyond the one it produces: it never stops the raw track it was handed,
// and it never touches media.stream. Swapping tracks is media.js's job, because
// media.js is the only module that knows what is currently published.
//
// The ~3.4MB MediaPipe runtime is imported lazily, on first start(), so a user
// who never opens the background picker never downloads it.

import { FpsGuard } from "./fpsGuard.js";
import { effectById } from "./backgrounds.js";

const VENDOR_BASE = "/vendor/mediapipe";
const MODEL_PATH = `${VENDOR_BASE}/selfie_segmenter.tflite`;
const OUTPUT_FPS = 24;
// How often the watchdog renders a verdict. Frame-driven checks alone cannot
// catch a total stall, because a stalled compositor stops calling push().
const GUARD_TICK_MS = 1000;

// Cached across instances: the fileset resolves once per page, and re-resolving
// it on every effect change would re-fetch the runtime.
let visionModule = null;
let filesetPromise = null;

async function loadVision() {
  if (!visionModule) visionModule = await import(`${VENDOR_BASE}/vision_bundle.mjs`);
  if (!filesetPromise) {
    filesetPromise = visionModule.FilesetResolver.forVisionTasks(VENDOR_BASE);
    // A failed load must not poison every later attempt — clear the cache so a
    // retry can actually retry.
    filesetPromise.catch(() => {
      filesetPromise = null;
    });
  }
  return { vision: visionModule, fileset: await filesetPromise };
}

export class BackgroundSegmenter {
  constructor({ onBail } = {}) {
    this.onBail = typeof onBail === "function" ? onBail : () => {};
    this._effect = effectById("none");
    this._segmenter = null;
    this._video = null;
    this._out = null; // the visible composite; its captureStream is published
    this._outCtx = null;
    this._scratch = null; // person, alpha-cut, before compositing over the background
    this._scratchCtx = null;
    this._maskCanvas = null; // the model's mask, at model resolution
    this._maskCtx = null;
    this._painted = null; // cached procedural background, repainted only on resize
    this._paintedFor = null; // the effect id _painted holds, so a switch repaints
    this._stream = null;
    this._track = null;
    this._raf = null;
    this._guard = new FpsGuard();
    this._guardTimer = null;
    this._stopped = false;
  }

  get track() {
    return this._track;
  }

  // Bring the pipeline up on `rawTrack` and resolve with the composited track.
  // Rejects if the model or the first camera frame cannot be obtained, leaving
  // nothing running — the caller keeps publishing the raw track.
  async start(rawTrack, effectId) {
    if (!rawTrack) throw new Error("no camera track to process");
    this._effect = effectById(effectId);

    const { vision, fileset } = await loadVision();
    if (this._stopped) return null; // stopped while the runtime was loading

    this._segmenter = await vision.ImageSegmenter.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: MODEL_PATH,
        // GPU keeps the model off the main thread's CPU budget. Some machines
        // have no usable WebGL context, so fall back rather than fail outright.
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      // A CONFIDENCE mask, not a category mask: the soft probability edge is what
      // keeps hair and shoulders from looking die-cut.
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    }).catch(async (err) => {
      console.warn("segmenter: GPU delegate failed, falling back to CPU", err);
      return vision.ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_PATH, delegate: "CPU" },
        runningMode: "VIDEO",
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      });
    });
    if (this._stopped) return null;

    await this._startVideo(rawTrack);
    if (this._stopped) return null;

    this._buildCanvases();
    this._stream = this._out.captureStream(OUTPUT_FPS);
    this._track = this._stream.getVideoTracks()[0] || null;
    if (!this._track) throw new Error("compositor produced no video track");

    this._guard.reset();
    this._guardTimer = setInterval(() => this._tickGuard(), GUARD_TICK_MS);
    this._scheduleFrame();
    return this._track;
  }

  // Switch effect without rebuilding the model — the expensive part stays warm.
  // The guard re-arms, so a device that choked on a virtual background still gets
  // a fair try at a cheap blur.
  setEffect(effectId) {
    this._effect = effectById(effectId);
    this._painted = null;
    this._paintedFor = null;
    this._guard.reset();
  }

  // Idempotent teardown. Stops the composited track (not the raw one — the caller
  // owns that), cancels both loops, and releases the model.
  stop() {
    this._stopped = true;
    if (this._raf) {
      if (this._video && this._cancelFrame) this._cancelFrame();
      this._raf = null;
    }
    if (this._guardTimer) {
      clearInterval(this._guardTimer);
      this._guardTimer = null;
    }
    if (this._track) {
      this._track.stop();
      this._track = null;
    }
    this._stream = null;
    if (this._segmenter) {
      try {
        this._segmenter.close();
      } catch {
        /* already closed */
      }
      this._segmenter = null;
    }
    if (this._video) {
      this._video.srcObject = null;
      this._video.remove();
      this._video = null;
    }
    this._out = this._outCtx = this._scratch = this._scratchCtx = null;
    this._maskCanvas = this._maskCtx = this._painted = null;
  }

  // --- internals ---

  // The source <video> must be IN the document and actually rendering: iOS Safari
  // will not produce frames for a detached or display:none video. Hide it with
  // opacity and a 1px box instead.
  async _startVideo(rawTrack) {
    const video = document.createElement("video");
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;";
    video.srcObject = new MediaStream([rawTrack]);
    document.body.append(video);
    this._video = video;

    await new Promise((resolve, reject) => {
      const done = () => {
        video.removeEventListener("loadedmetadata", done);
        resolve();
      };
      // A camera that never delivers metadata would hang start() forever.
      const timer = setTimeout(() => reject(new Error("camera frame timed out")), 10000);
      video.addEventListener("loadedmetadata", () => {
        clearTimeout(timer);
        done();
      });
    });
    await video.play().catch(() => {
      /* autoplay of a muted, in-document video is permitted; ignore races */
    });
  }

  _buildCanvases() {
    const w = this._video.videoWidth || 640;
    const h = this._video.videoHeight || 360;
    this._out = Object.assign(document.createElement("canvas"), { width: w, height: h });
    this._outCtx = this._out.getContext("2d");
    this._scratch = Object.assign(document.createElement("canvas"), { width: w, height: h });
    this._scratchCtx = this._scratch.getContext("2d");
  }

  // rVFC fires once per decoded camera frame, which is exactly the cadence we
  // want; rAF is the fallback for browsers that lack it (older Firefox).
  _scheduleFrame() {
    if (this._stopped || !this._video) return;
    if (typeof this._video.requestVideoFrameCallback === "function") {
      const id = this._video.requestVideoFrameCallback(() => this._onFrame());
      this._cancelFrame = () => this._video && this._video.cancelVideoFrameCallback(id);
    } else {
      const id = requestAnimationFrame(() => this._onFrame());
      this._cancelFrame = () => cancelAnimationFrame(id);
    }
    this._raf = true;
  }

  _onFrame() {
    if (this._stopped) return;
    try {
      this._renderFrame();
      this._guard.push(performance.now());
    } catch (err) {
      console.error("segmenter: frame failed", err);
    }
    this._scheduleFrame();
  }

  _renderFrame() {
    const video = this._video;
    const seg = this._segmenter;
    if (!video || !seg || !video.videoWidth) return;

    // The camera can change resolution mid-call (a device switch, or a browser
    // adapting to bandwidth); follow it rather than compositing at a stale size.
    if (this._out.width !== video.videoWidth || this._out.height !== video.videoHeight) {
      this._out.width = this._scratch.width = video.videoWidth;
      this._out.height = this._scratch.height = video.videoHeight;
      this._painted = null; // the cached background is now the wrong size
    }

    seg.segmentForVideo(video, performance.now(), (result) => {
      try {
        this._composite(result);
      } finally {
        // MediaPipe results hold GPU/WASM memory that is not garbage collected.
        // Leaking one per frame exhausts the heap within a minute.
        if (result && typeof result.close === "function") result.close();
      }
    });
  }

  _composite(result) {
    const masks = result && result.confidenceMasks;
    if (!masks || !masks.length) return;
    // The selfie segmenter emits person confidence LAST: a single-mask model
    // emits it alone, a two-mask model emits background then person. Taking the
    // last entry is correct for both shapes.
    const mask = masks[masks.length - 1];
    const w = this._out.width;
    const h = this._out.height;

    this._drawBackground(w, h);
    this._drawMaskedPerson(mask, w, h);
    this._outCtx.drawImage(this._scratch, 0, 0);
  }

  _drawBackground(w, h) {
    const ctx = this._outCtx;
    const effect = this._effect;
    if (effect.kind === "blur") {
      const radius = Math.max(2, Math.round(w * effect.radius));
      this._blurInto(ctx, this._video, w, h, radius);
      return;
    }
    if (effect.kind === "paint") {
      // Painted once and reused: regenerating a gradient 24 times a second is
      // pure waste, and it is invariant anyway.
      if (!this._painted || this._paintedFor !== effect.id) {
        this._painted = Object.assign(document.createElement("canvas"), { width: w, height: h });
        effect.paint(this._painted.getContext("2d"), w, h);
        this._paintedFor = effect.id;
      }
      ctx.drawImage(this._painted, 0, 0, w, h);
      return;
    }
    // kind "none" should never reach the compositor — media.js tears the
    // pipeline down instead — but draw the plain frame rather than a black hole.
    ctx.drawImage(this._video, 0, 0, w, h);
  }

  // ctx.filter is the good path, but Safari below 17 does not implement it. The
  // fallback halves the image repeatedly and scales it back up: bilinear
  // smoothing on the way out gives a serviceable approximate blur everywhere.
  _blurInto(ctx, source, w, h, radius) {
    if (ctx.filter !== undefined) {
      ctx.filter = `blur(${radius}px)`;
      ctx.drawImage(source, 0, 0, w, h);
      ctx.filter = "none";
      return;
    }
    const steps = Math.max(1, Math.min(4, Math.round(Math.log2(radius))));
    const small = Object.assign(document.createElement("canvas"), {
      width: Math.max(1, w >> steps),
      height: Math.max(1, h >> steps),
    });
    const sctx = small.getContext("2d");
    sctx.imageSmoothingEnabled = true;
    sctx.drawImage(source, 0, 0, small.width, small.height);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(small, 0, 0, w, h);
  }

  _drawMaskedPerson(mask, w, h) {
    const ctx = this._scratchCtx;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(this._video, 0, 0, w, h);

    const mw = mask.width;
    const mh = mask.height;
    const conf = mask.getAsFloat32Array();
    if (!this._maskCanvas || this._maskCanvas.width !== mw || this._maskCanvas.height !== mh) {
      this._maskCanvas = Object.assign(document.createElement("canvas"), { width: mw, height: mh });
      this._maskCtx = this._maskCanvas.getContext("2d");
      this._maskImage = this._maskCtx.createImageData(mw, mh);
    }
    // Widen the confidence values into an alpha channel. This is the CPU hot path
    // (~65k elements per frame); if the FPS guard trips on hardware that should
    // cope, measure here first.
    const px = this._maskImage.data;
    for (let i = 0, j = 3; i < conf.length; i++, j += 4) {
      px[j] = conf[i] * 255;
    }
    this._maskCtx.putImageData(this._maskImage, 0, 0);

    // destination-in keeps only what the mask's alpha covers, leaving the person
    // alpha-cut on a transparent field. A small blur feathers the edge so the
    // composite does not look like a paper cutout; where ctx.filter is missing we
    // accept the harder edge rather than losing the effect.
    ctx.globalCompositeOperation = "destination-in";
    if (ctx.filter !== undefined) ctx.filter = `blur(${Math.max(1, Math.round(w * 0.004))}px)`;
    ctx.drawImage(this._maskCanvas, 0, 0, w, h);
    ctx.filter = "none";
    ctx.globalCompositeOperation = "source-over";
  }

  _tickGuard() {
    if (this._stopped) return;
    if (this._guard.check(performance.now())) {
      console.warn("segmenter: frame rate too low, dropping the background effect");
      // Report only; media.js owns the tracks and performs the revert.
      this.onBail();
    }
  }
}
```

- [ ] **Step 2: Verify it parses and loads**

Run:

```bash
node --check internal/web/assets/lib/segmenter.js
node --check internal/web/assets/lib/backgrounds.js
node --check internal/web/assets/lib/fpsGuard.js
```

Expected: no output (all parse).

Smoke-test that its static imports resolve (the MediaPipe import is dynamic, so this does not need a browser):

```bash
node --input-type=module -e "
  const m = await import('./internal/web/assets/lib/segmenter.js');
  if (typeof m.BackgroundSegmenter !== 'function') throw new Error('no BackgroundSegmenter export');
  console.log('ok');
"
```

Expected: `ok`.

- [ ] **Step 3: Confirm the suite is still green**

Run: `node --test internal/web/test/*.test.js`

Expected: 88 pass.

- [ ] **Step 4: Commit**

```bash
git add internal/web/assets/lib/segmenter.js
git commit -m "feat(web): MediaPipe segmentation pipeline for background effects

Mirrors the noise-suppression graph one level up: a raw camera track feeds a
model and a canvas compositor, and the composited track is what gets
published. Owns the model, canvases, and render loop but never touches
media.stream — swapping tracks belongs to media.js, which knows what is
currently published.

The runtime is imported lazily on first start(), so a user who never opens
the picker never downloads it."
```

---

### Task 6: `net/media.js` — `setBackground()` and the parked-track lifecycle

**Files:**
- Modify: `internal/web/assets/net/media.js` (constructor ~22-44; `disableCamera` 186-192; `enableCamera` 199-205; `useDevices` 125-165; `stop` 273-287; `_swapTrack` 439-460)

**Interfaces:**
- Consumes: `BackgroundSegmenter` (Task 5), `resolveEffectId` (Task 4).
- Produces on `Media`:
  - `async setBackground(effectId) → string` — the effect actually in force afterwards (`"none"` if the build failed). Emits `camera-track` with whatever should now be published.
  - getter `backgroundEffect → string`.
  - `cameraTrack` still returns `stream.getVideoTracks()[0]`, which is the **composited** track while an effect is active. Nothing downstream changes.
  - New event `"background-changed"` `{ effectId, reverted }` — `reverted: true` when the watchdog bailed, so the UI can distinguish a user choice from an automatic revert. Task 7 listens.

- [ ] **Step 1: Add the imports and state**

At the top of `media.js`, after the existing header comment, add:

```js
import { BackgroundSegmenter } from "../lib/segmenter.js";
import { resolveEffectId } from "../lib/backgrounds.js";
```

Extend the module header comment's event list with:

```js
//   "background-changed" {effectId, reverted}  the background effect changed;
//                                reverted=true means the frame-rate watchdog
//                                dropped it rather than the user choosing
```

In the constructor, after the noise-suppression block (after `this._nsOn = false;`), add:

```js
    // Background effects (blur / virtual background). The mirror image of the
    // noise-suppression graph above, with one deliberate inversion: for audio the
    // RAW track stays in `stream` and the processed one lives beside it, but for
    // video the COMPOSITED track goes into `stream` and the raw device track is
    // parked here. That is what makes the lobby preview and the self tile show
    // the user their own effect — both bind `stream` once and never rebind.
    this._bgEffect = "none";
    this._segmenter = null;
    this._rawCameraTrack = null; // the device track, parked while an effect is on
```

- [ ] **Step 2: Add `setBackground` and its helpers**

Add a new section before `// --- internals ---`:

```js
  // --- background effects ---

  // Whichever effect is currently in force ("none" when the camera is raw).
  get backgroundEffect() {
    return this._bgEffect;
  }

  // Apply a background effect, replacing whatever was in force. Returns the effect
  // ACTUALLY in force afterwards, so a caller that asked for "aurora" and got
  // "none" back knows the pipeline failed to build and can reflect that.
  //
  // Emits "camera-track" with whatever should now be published, which app.js
  // forwards to peer.replaceTrack — so remotes see the change with no
  // renegotiation, exactly as they do for a camera device switch.
  //
  // With the camera off there is nothing to process: the choice is recorded and
  // applied by enableCamera() when the device comes back.
  async setBackground(effectId) {
    const wanted = resolveEffectId(effectId);
    if (wanted === this._bgEffect) return this._bgEffect;

    if (!this.cameraTrack && !this._rawCameraTrack) {
      this._bgEffect = wanted; // remembered; enableCamera applies it
      this._emitBackground(wanted, false);
      return wanted;
    }

    if (wanted === "none") {
      this._teardownBackground();
      this._bgEffect = "none";
      this._emitBackground("none", false);
      return "none";
    }

    // Already running: swap the effect without rebuilding the model.
    if (this._segmenter) {
      this._segmenter.setEffect(wanted);
      this._bgEffect = wanted;
      this._emitBackground(wanted, false);
      return wanted;
    }

    try {
      await this._buildBackground(wanted);
      this._bgEffect = wanted;
      this._emitBackground(wanted, false);
      return wanted;
    } catch (error) {
      // Leave the raw camera streaming — the user must never be left with a dead
      // video track because an effect failed to load.
      this._teardownBackground();
      this._bgEffect = "none";
      this._emitError(error, "background");
      this._emitBackground("none", false);
      return "none";
    }
  }

  // Build the pipeline on the current device track and swap the composited track
  // into `stream`. Throws with the raw camera left untouched if anything fails.
  async _buildBackground(effectId) {
    const raw = this._rawCameraTrack || this.cameraTrack;
    if (!raw) throw new Error("no camera to process");

    const segmenter = new BackgroundSegmenter({ onBail: () => this._onBackgroundBail() });
    const processed = await segmenter.start(raw, effectId);
    if (!processed) {
      segmenter.stop();
      throw new Error("background pipeline produced no track");
    }
    this._segmenter = segmenter;
    this._rawCameraTrack = raw;
    processed.enabled = raw.enabled; // carry the mute state onto the published track
    // Swap directly rather than via _swapTrack: that helper STOPS the outgoing
    // track, which here is the raw device feeding the pipeline.
    const current = this.stream.getVideoTracks()[0] || null;
    if (current && current !== processed) this.stream.removeTrack(current);
    this.stream.addTrack(processed);
    this.dispatchEvent(new CustomEvent("camera-track", { detail: { track: processed } }));
  }

  // Tear the pipeline down and put the raw device track back in `stream`. Safe to
  // call when no effect is running. Emits "camera-track" only when the published
  // track actually changed.
  _teardownBackground() {
    const segmenter = this._segmenter;
    const raw = this._rawCameraTrack;
    this._segmenter = null;
    this._rawCameraTrack = null;
    if (!segmenter) return;

    const processed = segmenter.track;
    segmenter.stop(); // stops the composited track, never the raw one
    if (!this.stream) return;
    if (processed) this.stream.removeTrack(processed);
    if (raw && raw.readyState === "live") {
      if (processed) raw.enabled = processed.enabled; // carry the mute state back
      this.stream.addTrack(raw);
      this.dispatchEvent(new CustomEvent("camera-track", { detail: { track: raw } }));
    } else {
      // The device went away while the effect was running (unplugged, or a
      // disableCamera race). Report camera-off rather than a dead track.
      this.dispatchEvent(new CustomEvent("camera-track", { detail: { track: null } }));
    }
  }

  // The frame-rate watchdog gave up. Revert to the raw camera and tell the UI it
  // was automatic, so the picker can show a notice AND — importantly — not
  // persist "none" as though the user had chosen it.
  _onBackgroundBail() {
    if (!this._segmenter) return; // already torn down
    this._teardownBackground();
    this._bgEffect = "none";
    this._emitBackground("none", true);
  }

  _emitBackground(effectId, reverted) {
    this.dispatchEvent(new CustomEvent("background-changed", { detail: { effectId, reverted } }));
  }
```

- [ ] **Step 3: Update the four lifecycle methods**

**`disableCamera()`** — replace the whole method:

```js
  // Turn the camera OFF by releasing the device: track.stop() frees the hardware
  // and turns its indicator light off, unlike merely disabling the track. Removes
  // the video track from `stream` and emits "camera-track" {track:null} so the
  // publisher drops the outgoing frames. A no-op when the camera is already off.
  //
  // With a background effect running there are TWO tracks to deal with: the
  // composited one in `stream` and the parked raw device track feeding it. Both
  // must stop, or the camera light stays on with no video going anywhere.
  disableCamera() {
    const raw = this._rawCameraTrack;
    const effect = this._bgEffect; // remembered, so re-enabling restores the effect
    if (this._segmenter) {
      const segmenter = this._segmenter;
      this._segmenter = null;
      this._rawCameraTrack = null;
      const processed = segmenter.track;
      segmenter.stop();
      if (processed && this.stream) this.stream.removeTrack(processed);
      if (raw) raw.stop(); // the device itself — this is what kills the light
      this._bgEffect = effect;
      this.dispatchEvent(new CustomEvent("camera-track", { detail: { track: null } }));
      return;
    }
    const track = this.cameraTrack;
    if (!track) return;
    this.stream.removeTrack(track);
    track.stop();
    this.dispatchEvent(new CustomEvent("camera-track", { detail: { track: null } }));
  }
```

**`enableCamera()`** — replace the whole method:

```js
  // Turn the camera back ON by re-acquiring it (a fresh getUserMedia video capture),
  // adding it to `stream`, and emitting "camera-track" with the new track (which the
  // publisher republishes). Resolves with the new track; rejects (and emits "error")
  // if acquisition fails, leaving the camera off. A no-op returning the current track
  // when already on. `deviceId` optionally pins a specific camera.
  //
  // A background effect chosen while the camera was off is applied here, so the
  // camera never comes back showing a room the user had already hidden.
  async enableCamera(deviceId = this._cameraId) {
    if (this.cameraTrack) return this.cameraTrack;
    const video = deviceId ? { deviceId: { exact: deviceId } } : true;
    const fresh = await this._getUserMedia({ video });
    this._adopt(fresh); // swaps the new video track into `stream`, emits "camera-track"
    if (this._bgEffect !== "none") {
      const wanted = this._bgEffect;
      this._bgEffect = "none"; // so setBackground sees a real transition
      await this.setBackground(wanted);
    }
    return this.cameraTrack;
  }
```

**`useDevices()`** — inside the method, capture the effect before `_adopt` and restore after. Immediately after the line `const rebuildNs = !!micId && this._nsOn;` add:

```js
    // A camera switch replaces the device feeding the effect pipeline, so the
    // pipeline must be rebuilt on the new device — the same shape as rebuildNs
    // below. Tear it down BEFORE _adopt so the parked raw track is back in
    // `stream` and _swapTrack has the right thing to replace.
    const rebuildBg = !!cameraId && this._bgEffect !== "none";
    const wantedBg = this._bgEffect;
    if (rebuildBg) {
      this._teardownBackground();
      this._bgEffect = "none";
    }
```

Then immediately before the closing `return this.stream;` of `useDevices`, add:

```js
    if (rebuildBg) {
      // A rebuild failure leaves the raw camera published rather than a dead
      // track; setBackground already reports and degrades to "none".
      await this.setBackground(wantedBg);
    }
```

**`stop()`** — add background teardown. After the line `this.stopScreen();` insert:

```js
    this._teardownBackground();
    this._bgEffect = "none";
```

**`_swapTrack()`** — add a guard comment at the top of the video branch. After the line `if (prev === next) return;` insert:

```js
    // The parked raw camera track is NOT in `stream` while an effect runs, so it
    // can never be `prev` here. The background paths swap tracks themselves for
    // exactly this reason: this helper stops whatever it replaces, which would
    // kill the device feeding the compositor.
```

- [ ] **Step 4: Verify**

Run:

```bash
node --check internal/web/assets/net/media.js
node --test internal/web/test/*.test.js
go build ./...
```

Expected: parses clean, 88 tests pass, build succeeds.

- [ ] **Step 5: Commit**

```bash
git add internal/web/assets/net/media.js
git commit -m "feat(web): background effect lifecycle in Media

setBackground() builds the compositor and swaps its output into stream, so the
lobby preview, the self tile, and every remote peer all follow with no changes
to those call sites.

The four existing camera lifecycle methods learn about the parked raw device
track. disableCamera in particular must stop BOTH tracks: stopping only the
composited one would leave the camera light on with no video going anywhere."
```

---

### Task 7: `ui/background.js` — the picker component

**Files:**
- Create: `internal/web/assets/ui/background.js`
- Modify: `internal/web/assets/style.css`

**Interfaces:**
- Consumes: `EFFECTS`, `effectById` (Task 4); `Media.setBackground` and the `background-changed` event (Task 6).
- Produces: `class BackgroundPicker`, constructed as `new BackgroundPicker({ media, compact, onChange })`. Property `el` is the root element to insert. Method `destroy()` detaches listeners. `onChange(effectId, reverted)` fires after every settled change; Task 8 uses it to persist — and to **not** persist a reverted one.

- [ ] **Step 1: Write the module**

Create `internal/web/assets/ui/background.js`:

```js
// The background picker: a strip of thumbnail chips for the blur and virtual
// background effects. Mounted twice — in the pre-join lobby, and as a row in the
// in-call settings menu (`compact`, which wraps to a grid so the popover stays a
// sane width).
//
// Thumbnails are drawn by the SAME painters that draw the real background, at
// 48x27, so a chip is always an exact preview rather than a stale asset that can
// drift from what the effect actually produces.
//
// The ~3.4MB MediaPipe runtime is loaded on first use, not on page load, so the
// disabled/pending state here matters: it is the only feedback during a load that
// can take a few seconds on a slow connection. This mirrors how the noise
// suppression button handles its ~2MB worklet.

import { EFFECTS, effectById } from "../lib/backgrounds.js";

const THUMB_W = 48;
const THUMB_H = 27;

// Tiny DOM helper: el("button", {class:"x", onClick:fn}, "text"). The "text" key
// sets textContent, so any caller string is inert markup-wise.
function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) node.setAttribute(k, "");
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const kid of kids) if (kid != null) node.append(kid);
  return node;
}

// Draw an effect's chip preview. "paint" effects call their own painter; the blur
// chips get a schematic stand-in (there is no camera frame to blur at chip size,
// and faking one would be more misleading than a glyph).
function drawThumb(canvas, effect) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, THUMB_W, THUMB_H);
  if (effect.kind === "paint") {
    effect.paint(ctx, THUMB_W, THUMB_H);
    return;
  }
  ctx.fillStyle = "#2b2f37"; // --border
  ctx.fillRect(0, 0, THUMB_W, THUMB_H);
  if (effect.kind === "blur") {
    // A soft blob behind a sharp one: reads as "subject sharp, background soft".
    if (ctx.filter !== undefined) ctx.filter = `blur(${effect.id === "blur-strong" ? 4 : 2}px)`;
    ctx.fillStyle = "rgba(76, 141, 255, 0.55)";
    ctx.fillRect(THUMB_W * 0.1, THUMB_H * 0.2, THUMB_W * 0.8, THUMB_H * 0.7);
    ctx.filter = "none";
    ctx.fillStyle = "#e6e8ec"; // --fg
    ctx.beginPath();
    ctx.arc(THUMB_W / 2, THUMB_H * 0.62, THUMB_H * 0.28, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  // "none": a diagonal slash.
  ctx.strokeStyle = "#9aa1ac"; // --muted
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(6, THUMB_H - 6);
  ctx.lineTo(THUMB_W - 6, 6);
  ctx.stroke();
}

export class BackgroundPicker {
  // { media, compact, onChange }. `compact` is the in-menu variant. onChange is
  // called after every settled change with (effectId, reverted) — reverted=true
  // means the watchdog dropped the effect, which callers must NOT persist.
  constructor({ media, compact = false, onChange } = {}) {
    this.media = media || null;
    this.onChange = typeof onChange === "function" ? onChange : () => {};
    this.busy = false;
    this.chips = new Map();

    this.notice = el("p", { class: "bg-notice", role: "status", hidden: true });
    this.strip = el("div", { class: "bg-strip", role: "radiogroup", "aria-label": "Background" });

    for (const effect of EFFECTS) {
      const canvas = el("canvas", { class: "bg-thumb", width: THUMB_W, height: THUMB_H, "aria-hidden": "true" });
      drawThumb(canvas, effect);
      const chip = el(
        "button",
        {
          type: "button",
          class: "bg-chip",
          role: "radio",
          "aria-checked": "false",
          title: effect.label,
          onClick: () => this._choose(effect.id),
        },
        canvas,
        el("span", { class: "bg-label", text: effect.label }),
      );
      this.chips.set(effect.id, chip);
      this.strip.append(chip);
    }

    this.el = el("div", { class: compact ? "bg-picker compact" : "bg-picker" }, this.strip, this.notice);

    // Media is the authority on what is actually in force — a build failure or a
    // watchdog bail changes it without anyone clicking a chip.
    this._onChanged = (e) => this._reflect((e.detail && e.detail.effectId) || "none", !!(e.detail && e.detail.reverted));
    if (this.media) this.media.addEventListener("background-changed", this._onChanged);

    this._reflect(this.media ? this.media.backgroundEffect : "none", false);
  }

  // Set the selection without going through Media — used to restore a saved
  // preference into the UI before the pipeline has been built.
  select(effectId) {
    this._reflect(effectById(effectId).id, false);
  }

  destroy() {
    if (this.media) this.media.removeEventListener("background-changed", this._onChanged);
    this.chips.clear();
  }

  async _choose(effectId) {
    if (!this.media || this.busy) return;
    if (this.media.backgroundEffect === effectId) return;
    this.busy = true;
    this._setPending(effectId, true);
    this.notice.hidden = true;
    let settled = "none";
    try {
      settled = await this.media.setBackground(effectId);
    } catch {
      /* Media emits its own error; reflect whatever state we ended in */
      settled = this.media.backgroundEffect;
    } finally {
      this.busy = false;
      this._setPending(effectId, false);
    }
    this._reflect(settled, false);
    if (settled !== effectId) {
      this.notice.hidden = false;
      this.notice.textContent = "That background could not be started.";
    }
    this.onChange(settled, false);
  }

  _reflect(effectId, reverted) {
    for (const [id, chip] of this.chips) {
      const on = id === effectId;
      chip.classList.toggle("on", on);
      chip.setAttribute("aria-checked", on ? "true" : "false");
    }
    if (reverted) {
      this.notice.hidden = false;
      this.notice.textContent = "Background turned off — this device couldn't keep up.";
      this.onChange(effectId, true);
    }
  }

  _setPending(effectId, pending) {
    const chip = this.chips.get(effectId);
    if (chip) chip.classList.toggle("pending", pending);
    for (const c of this.chips.values()) c.disabled = pending;
  }
}
```

- [ ] **Step 2: Add the styles**

Append to `internal/web/assets/style.css`:

```css
/* --- background picker (lobby + settings menu) --- */

.bg-strip {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  padding-bottom: 4px;
}

/* In the settings popover a scrolling strip is awkward to hit, so wrap instead. */
.bg-picker.compact .bg-strip {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  overflow-x: visible;
}

.bg-chip {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 4px;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--muted);
  cursor: pointer;
  font: inherit;
  font-size: 11px;
  line-height: 1;
}

.bg-chip:hover:not(:disabled) { border-color: var(--muted); color: var(--fg); }
.bg-chip.on { border-color: var(--accent); color: var(--fg); }
.bg-chip:disabled { opacity: 0.5; cursor: default; }
.bg-chip.pending { border-color: var(--accent); animation: bg-pulse 1s ease-in-out infinite; }

@keyframes bg-pulse { 50% { opacity: 0.45; } }

.bg-thumb {
  display: block;
  width: 48px;
  height: 27px;
  border-radius: 3px;
}

.bg-picker.compact .bg-thumb { width: 100%; height: auto; aspect-ratio: 16 / 9; }

.bg-label { white-space: nowrap; }
.bg-picker.compact .bg-label { display: none; } /* the title attribute carries it */

.bg-notice {
  margin: 6px 0 0;
  color: var(--muted);
  font-size: 12px;
}
```

- [ ] **Step 3: Verify**

Run:

```bash
node --check internal/web/assets/ui/background.js
node --input-type=module -e "
  const m = await import('./internal/web/assets/ui/background.js');
  if (typeof m.BackgroundPicker !== 'function') throw new Error('no BackgroundPicker export');
  console.log('ok');
"
node --test internal/web/test/*.test.js
```

Expected: parses, `ok`, 88 tests pass.

- [ ] **Step 4: Commit**

```bash
git add internal/web/assets/ui/background.js internal/web/assets/style.css
git commit -m "feat(web): background picker component

Thumbnails are drawn by the same painters that draw the real background, so a
chip cannot drift from what the effect actually produces. One component serves
both the lobby and the settings menu, the latter wrapping to a grid."
```

---

### Task 8: Wire the picker into the lobby and the call

**Files:**
- Modify: `internal/web/assets/ui/prejoin.js` (imports 12-13; `_build` 144-242; `_applyMediaPrefs` 131-142; `destroy` 439-448)
- Modify: `internal/web/assets/ui/controls.js` (imports 26-30; settings menu build ~373-398; a `destroy`/teardown path)

**Interfaces:**
- Consumes: `BackgroundPicker` (Task 7), `resolveEffectId` (Task 4), `loadMediaPrefs`/`saveMediaPrefs` (existing).
- Produces: the finished feature. Nothing later depends on it.

- [ ] **Step 1: Wire the lobby**

In `internal/web/assets/ui/prejoin.js`:

Add to the imports:

```js
import { BackgroundPicker } from "./background.js";
import { resolveEffectId } from "../lib/backgrounds.js";
```

In `_build()`, immediately before the `const form = el(` line, add:

```js
    // Background effects. A reverted choice (the watchdog gave up) must NOT be
    // persisted: writing "none" would be read back forever as a deliberate
    // preference, and a device that overheated once would silently lose the
    // feature for good. This is the same reasoning as the noise-suppression
    // persistence rule in controls.js.
    this.backgroundPicker = new BackgroundPicker({
      media: this.media,
      onChange: (effectId, reverted) => {
        if (!reverted) saveMediaPrefs({ background: effectId });
      },
    });
```

In the `form` element's children, insert the picker row directly after the `.devices` block and before the display-name field:

```js
      el("div", { class: "field" }, el("span", { text: "Background" }), this.backgroundPicker.el),
```

In `_applyMediaPrefs()`, append after the camera block:

```js
    // Restore the saved background. Only meaningful with a live camera; with the
    // camera off, Media records the choice and applies it on the next enable.
    const background = resolveEffectId(prefs.background);
    if (background !== "none") {
      this.backgroundPicker.select(background); // reflect it immediately; the build is async
      await this.media.setBackground(background).catch(() => {
        /* Media emits its own error and degrades to "none"; the picker follows
           via the background-changed event */
      });
    }
```

In `destroy()`, before `this.root.replaceChildren();`, add:

```js
    if (this.backgroundPicker) this.backgroundPicker.destroy();
```

- [ ] **Step 2: Wire the in-call settings menu**

In `internal/web/assets/ui/controls.js`:

Add to the imports:

```js
import { BackgroundPicker } from "./background.js";
```

In the settings-menu build, immediately before the `this.settingsMenu = el(` line, add:

```js
    // Background effects, compact variant so the popover stays a sane width. A
    // watchdog revert is never persisted — see the same rule on the denoise
    // toggle below: writing a state the user did not choose means reading it back
    // forever as though they had.
    this.backgroundPicker = new BackgroundPicker({
      media: this.media,
      compact: true,
      onChange: (effectId, reverted) => {
        if (!reverted) saveMediaPrefs({ background: effectId });
      },
    });
```

Add the row to the `settingsMenu` children, after the `"Noise suppression"` row:

```js
      this._settingsRow("Background", this.backgroundPicker.el),
```

Find the method that tears `Controls` down (search for where it removes listeners — likely `destroy()`; if there is none, attach to whatever `app.js` calls on leave). Add:

```js
    if (this.backgroundPicker) this.backgroundPicker.destroy();
```

**If `Controls` has no teardown method,** do not invent one — the `media` instance is discarded on leave, so the listener dies with it. Note that in the commit message instead.

- [ ] **Step 3: Verify**

Run:

```bash
node --check internal/web/assets/ui/prejoin.js
node --check internal/web/assets/ui/controls.js
node --test internal/web/test/*.test.js
go build ./... && go test ./internal/web/ ./internal/server/
```

Expected: all parse, 88 JS tests pass, Go builds and passes.

- [ ] **Step 4: Smoke-test in a real browser**

```bash
go build -o webrtc-chat ./cmd/webrtc-chat && ./webrtc-chat -addr :8080
```

Open `http://localhost:8080/bgtest`. Confirm, with the browser console open:

1. The Background row appears in the lobby with 8 chips, each showing a distinct preview.
2. Clicking **Blur** shows a pending state, then the preview blurs behind you. No console errors.
3. The Network tab shows `vision_wasm_internal.wasm` fetched **once**, ~3.4 MB, `Content-Encoding: gzip`.
4. Clicking **Aurora** switches without re-fetching the WASM.
5. Reload — the effect is restored from the saved preference.
6. Join. The self tile shows the effect; open a second tab and confirm the remote tile shows it too.
7. In-call ☰ → Background → **None**; both tiles go raw immediately.
8. Camera off, then on: the effect returns.
9. Switch camera device (if you have two): the effect survives.

Record any failure and fix before committing. Do not claim this step passed without running it.

- [ ] **Step 5: Commit**

```bash
git add internal/web/assets/ui/prejoin.js internal/web/assets/ui/controls.js
git commit -m "feat(web): background picker in the lobby and the settings menu

The saved choice is restored on lobby mount, so a returning user never briefly
shows the room they had already hidden. A watchdog revert is deliberately not
persisted: writing a state the user did not choose would be read back forever
as a deliberate preference."
```

---

### Task 9: Documentation

**Files:**
- Modify: `README.md` (the "What it does" list; the architecture module list)
- Modify: `MANUAL-TEST.md`

- [ ] **Step 1: Update README.md**

In the "What it does" bullet list, after the noise-suppression bullet, add:

```markdown
- Background blur and virtual backgrounds (MediaPipe selfie segmentation, run
  entirely in the browser), with an automatic fall back to no effect on a device
  that cannot sustain a usable frame rate.
```

In the `internal/web` architecture bullet, extend it to mention the vendored runtime:

```markdown
- **`internal/web`** — the embedded browser client (`assets/`), with `node --test`
  unit tests for its pure logic (`test/`). Includes the vendored MediaPipe
  segmentation runtime (`assets/vendor/mediapipe/`, stored gzipped — see its
  README), which is why the binary is ~22MB.
```

- [ ] **Step 2: Add a MANUAL-TEST.md section**

Append:

```markdown
## Virtual and blurred backgrounds

The test suite covers the catalogue, the frame-rate watchdog, and the asset
serving. It cannot cover segmentation QUALITY or thermal behaviour — those need a
real device and a real face, so they are checked here.

### Desktop (Chrome, Firefox, Safari 17+)

1. Open a room. The lobby shows a **Background** row with 8 chips.
2. Pick **Blur**. The preview blurs behind you within a few seconds. The first
   pick downloads ~3.4MB (Network tab: `vision_wasm_internal.wasm`,
   `Content-Encoding: gzip`); later picks do not re-download it.
3. Check the mask edge around **hair and shoulders**. Some softness is expected;
   large chunks of head disappearing is not.
4. Pick each virtual background in turn. Each should fill the frame completely —
   no camera visible at the edges, no flicker between frames.
5. Join with an effect on. Confirm the self tile AND a second browser's remote
   tile both show it.
6. Turn the camera off and back on: the effect returns.
7. Switch camera device: the effect survives on the new device.
8. Leave and rejoin: the effect is restored from the saved preference.
9. **Low light.** Dim the room. Quality degrades — confirm it degrades rather
   than breaking (no strobing, no fully-lost subject).

### Safari < 17 (no `CanvasRenderingContext2D.filter`)

10. Blur still works via the downscale fallback, though visibly coarser, and the
    mask edge is harder. Confirm it is not simply unblurred.

### Mobile (the watchdog path)

11. On the oldest phone available, pick a virtual background and leave the call
    running for two minutes.
12. Either it holds a usable frame rate, **or** it reverts to None with the notice
    "Background turned off — this device couldn't keep up." Both are passes; a
    sustained 5fps feed with no revert is a failure.
13. After a revert, reload. The effect must **not** be gone permanently — the
    reverted state is deliberately not persisted.
14. Note battery and thermal behaviour over those two minutes.

### Known and accepted

- In a **backgrounded tab** the composited stream freezes and remotes see a still
  frame, because `requestAnimationFrame` stops. This is expected; see the spec's
  "Accepted regression" section.
```

- [ ] **Step 3: Verify and commit**

Run: `node --test internal/web/test/*.test.js && go build ./... && go test ./internal/web/ ./internal/server/`

Expected: green.

```bash
git add README.md MANUAL-TEST.md
git commit -m "docs: document background effects and their manual test pass"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Blur, two strengths | 4 (catalogue), 5 (compositor) |
| Five procedural backgrounds | 4 |
| Lobby placement | 8 |
| In-call ☰ placement | 8 |
| Persistence + unknown-id fallback | 4 (`resolveEffectId`), 8 (save/restore) |
| Processed track into `media.stream` | 6 (`_buildBackground`) |
| Four `media.js` lifecycle methods | 6 |
| `_swapTrack` must not stop the parked track | 6 (guard comment + explicit swap) |
| Confidence mask, GPU→CPU fallback | 5 |
| `ctx.filter` fallback | 5 (`_blurInto`) |
| Cached procedural canvas | 5 (`_drawBackground`) |
| Watchdog, grace, one-shot, re-arm | 3 |
| Trip ownership split across three modules | 3 (decides), 5 (`onBail`), 6 (`_onBackgroundBail`), 7 (notice) |
| Reverted value not persisted | 8 (both call sites) |
| Lazy loading | 5 (dynamic import), 7 (pending state) |
| SIMD-only, no nosimd | 2 (+ test asserting absence) |
| Gzip embed + serving | 1, 2 |
| Model committed, not fetched at runtime | 2 |
| Frozen id set | 4 |
| Painter invariants | 4 |
| Go embed + content-type tests | 1, 2 |
| Manual pass documented as pending | 9 |
| Backgrounded-tab regression documented | 9 |

No gaps.

**Placeholder scan:** No "TBD"/"TODO"/"similar to Task N". Two conditional branches exist (model URL 404, `Controls` teardown method) and both state exactly what to do in each case rather than deferring. Task 1 Step 2 creates a real placeholder *asset* so the task is testable before Task 2 — that is intentional sequencing, and Task 2's `< 1024 bytes` assertion guarantees it cannot survive.

**Type consistency:** `resolveEffectId`/`effectById` (Task 4) are used with those exact names in Tasks 5, 6, 7, 8. `BackgroundSegmenter{start,setEffect,stop,track,onBail}` (Task 5) matches every call in Task 6. `FpsGuard{push,check,reset,tripped}` (Task 3) matches Task 5's use. `setBackground`/`backgroundEffect`/`background-changed{effectId,reverted}` (Task 6) match Task 7's use. `BackgroundPicker{el,select,destroy,onChange}` (Task 7) matches Task 8's use. Consistent.
