# Image Backgrounds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add five photographic virtual backgrounds (four film/TV sets plus the Webb Carina Nebula) to the existing background picker, split into an "Effects" row and a "Scenes" row.

**Architecture:** Five 1280x720 WebP files land in `internal/web/assets/img/` and are embedded by the existing `//go:embed all:assets`. `lib/backgrounds.js` gains a third effect kind, `image`, carrying a `src` and a `fallback` colour, plus two pure helpers (`coverRect`, `drawImageBackground`) so the drawing decision is unit-testable without a canvas. A new `lib/backgroundImages.js` memoises decoded `ImageBitmap`s and never rejects. The effect switch stays synchronous: selecting an image applies it immediately and draws `fallback` until the bitmap arrives, so the picker's state machine is untouched and no raw camera frame ever reaches the compositor.

**Tech Stack:** Vanilla ES modules (no build step), `node --test` for JS, Go 1.x `//go:embed` + `go test` for asset presence, ImageMagick `convert` for one-time offline asset preparation.

Spec: [docs/superpowers/specs/2026-07-29-image-backgrounds-design.md](../specs/2026-07-29-image-backgrounds-design.md)

## Global Constraints

- **Vanilla JS only.** No bundler, no npm runtime dependencies. `internal/web/package.json` is `{"private": true, "type": "module"}` and stays that way.
- **Effect ids are a localStorage contract.** Renaming an existing id orphans every saved preference. New ids are additive only.
- **The pipeline invariant:** the worst outcome is "no effect", never "no camera", and never a frame of raw camera reaching the compositor when an effect is active.
- **No commit trailers.** Do not add `Co-Authored-By` to any commit message in this repo.
- **Test commands:** JS is `node --test internal/web/test/`; Go is `go test ./...`. Both must pass before each commit.
- **`convert -quality` is inert for WebP in this ImageMagick build** (libwebp 1.3.2 delegate): q30 and q95 produce byte-identical output. Use `-define webp:method=6` and, where a size cap is needed, `-define webp:target-size=N`. Do not write `-quality` into any recorded command; it would mislead.
- **Exact asset values** (measured, not estimated) — these are the values to write into code and docs:

  | file | bytes | average colour |
  |---|---|---|
  | `office-space.webp` | 61768 | `#585454` |
  | `space-ghost.webp` | 49538 | `#675364` |
  | `star-trek.webp` | 61038 | `#7D705E` |
  | `idiocracy.webp` | 47706 | `#3E3524` |
  | `carina.webp` | 127254 | `#614E54` |
  | **total** | **347304 (~339K)** | |

---

## File Structure

**Created:**
- `internal/web/assets/img/office-space.webp` … `carina.webp` — the five assets (Task 1)
- `internal/web/assets/img/README.md` — provenance: source URL, credit, licence, SHA-256, exact command (Task 1)
- `internal/web/assets/lib/backgroundImages.js` — memoised, never-rejecting `ImageBitmap` loader (Task 5)
- `internal/web/test/backgroundImages.test.js` — loader tests (Task 5)

**Modified:**
- `internal/web/web_test.go` — asset-presence test (Task 1)
- `internal/web/assets/lib/backgrounds.js` — `coverRect` (Task 2), `drawImageBackground` (Task 3), five `image` entries + `GROUPS` + header rewrite (Task 4)
- `internal/web/test/backgrounds.test.js` — tests for all of the above (Tasks 2, 3, 4)
- `internal/web/assets/lib/segmenter.js` — `image` branch in `_drawBackground`, bitmap warming (Task 6)
- `internal/web/assets/ui/background.js` — two rows, image thumbnails (Task 7)
- `internal/web/assets/style.css` — row layout (Task 7)
- `MANUAL-TEST.md` — updated background checks (Task 8)

**Deliberately unchanged:** `internal/web/web.go` (`//go:embed all:assets` already covers `img/`), `net/media.js` and `ui/prejoin.js` (they only use `resolveEffectId`, which is unaffected).

---

### Task 1: Assets and provenance

**Files:**
- Create: `internal/web/assets/img/{office-space,space-ghost,star-trek,idiocracy,carina}.webp`
- Create: `internal/web/assets/img/README.md`
- Modify: `internal/web/web_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: five files at `img/<name>.webp`, each 1280x720. Later tasks reference them by the relative URL `img/<name>.webp`.

The source files were already fetched and verified during design. Re-fetch them with the commands in the README below; the SHA-256 values in step 4 are of the *committed WebP*, so if a source host has since changed its file the checksum will not match and that must be raised, not papered over.

- [ ] **Step 1: Write the failing Go test**

Add to `internal/web/web_test.go`:

```go
// The image backgrounds are embedded assets. A missing or truncated file here is
// a picker chip that 404s in the browser and that no JS test would notice, so
// assert each one explicitly — the same reasoning as TestMediaPipeAssetsEmbedded.
func TestImageBackgroundAssetsEmbedded(t *testing.T) {
	for _, name := range []string{
		"img/office-space.webp",
		"img/space-ghost.webp",
		"img/star-trek.webp",
		"img/idiocracy.webp",
		"img/carina.webp",
	} {
		info, err := fs.Stat(Assets, name)
		if err != nil {
			t.Errorf("asset %q not embedded: %v", name, err)
			continue
		}
		if info.Size() < 20*1024 {
			t.Errorf("asset %q is only %d bytes — looks truncated", name, info.Size())
		}
	}
}
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `go test ./internal/web/ -run TestImageBackgroundAssetsEmbedded -v`
Expected: FAIL, five `not embedded` errors (`file does not exist`).

- [ ] **Step 3: Fetch the sources**

```bash
mkdir -p /tmp/bgsrc && cd /tmp/bgsrc
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
curl -sL -A "$UA" -o office.jpg     "https://cinematicfreeze.com/wp-content/uploads/gallery/office-space-1999/Office-Space-Stills-011.jpg"
curl -sL -A "$UA" -o star-trek.jpg  "https://cdn.wallpapersafari.com/92/28/tCxr1v.jpg"
curl -sL -A "$UA" -o idiocracy.jpg  "https://i.pinimg.com/originals/99/aa/f3/99aaf3df8a8533d0ed73350d59624a9e.jpg"
curl -sL -A "$UA" -o carina.jpg     "https://esawebb.org/media/archives/images/screen/weic2205a.jpg"
# Space Ghost: the DeviantArt URL carries an expiring token. If it 403s, re-copy a
# fresh link from https://www.deviantart.com/jsparrow4/art/Space-Ghost-Coast-to-Coast-Set-1004749507
curl -sL -A "$UA" -o spaceghost.jpg "https://images-wixmp-ed30a86b8c4ca887773594c2.wixmp.com/f/a76f6443-7477-4bc8-acbe-2200f0c5faab/deddkk3-15adca3f-de2e-49f6-9921-b810939e6eb2.jpg/v1/fill/w_1024,h_735,q_75,strp/space_ghost_coast_to_coast_set_by_jsparrow4_deddkk3-fullview.jpg?token=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1cm46YXBwOjdlMGQxODg5ODIyNjQzNzNhNWYwZDQxNWVhMGQyNmUwIiwiaXNzIjoidXJuOmFwcDo3ZTBkMTg4OTgyMjY0MzczYTVmMGQ0MTVlYTBkMjZlMCIsIm9iaiI6W1t7ImhlaWdodCI6Ijw9NzM1IiwicGF0aCI6IlwvZlwvYTc2ZjY0NDMtNzQ3Ny00YmM4LWFjYmUtMjIwMGYwYzVmYWFiXC9kZWRka2szLTE1YWRjYTNmLWRlMmUtNDlmNi05OTIxLWI4MTA5MzllNmViMi5qcGciLCJ3aWR0aCI6Ijw9MTAyNCJ9XV0sImF1ZCI6WyJ1cm46c2VydmljZTppbWFnZS5vcGVyYXRpb25zIl19.kEZX3TtP01m3PI40X4oeyamK9vVsGrvO98X29fi0axs"
identify -format "%f %wx%h\n" *.jpg
```

Expected dimensions: `office.jpg 1920x1040`, `spaceghost.jpg 1024x735`, `star-trek.jpg 1600x1051`, `idiocracy.jpg 1200x674`, `carina.jpg 1280x741`. If any differs, the crop geometry in step 4 is wrong for that file — stop and recompute it rather than shipping a bad crop.

- [ ] **Step 4: Crop and encode**

Each source is centre-cropped to exactly 16:9 first, then resized to 1280x720, so nothing is distorted. `carina` gets a `target-size` cap because nebula noise does not compress well and it would otherwise be 165KB.

```bash
cd /tmp/bgsrc
OUT=/home/rohara/Workspace/webrtc-chat/internal/web/assets/img
mkdir -p "$OUT"
convert office.jpg     -gravity center -crop 1849x1040+0+0 +repage -resize 1280x720 -define webp:method=6 "$OUT/office-space.webp"
convert spaceghost.jpg -gravity center -crop 1024x576+0+0  +repage -resize 1280x720 -define webp:method=6 "$OUT/space-ghost.webp"
convert star-trek.jpg  -gravity center -crop 1600x900+0+0   +repage -resize 1280x720 -define webp:method=6 "$OUT/star-trek.webp"
convert idiocracy.jpg  -gravity center -crop 1198x674+0+0   +repage -resize 1280x720 -define webp:method=6 "$OUT/idiocracy.webp"
convert carina.jpg     -gravity center -crop 1280x720+0+0   +repage -define webp:method=6 -define webp:target-size=110000 "$OUT/carina.webp"
identify -format "%f %wx%h %b\n" "$OUT"/*.webp
sha256sum "$OUT"/*.webp
```

All five must report `1280x720`. Sizes should match the Global Constraints table within a few hundred bytes (libwebp is deterministic for a fixed input and version, but a different libwebp would shift them slightly — that is fine, record what you actually get).

- [ ] **Step 5: Write the provenance README**

Create `internal/web/assets/img/README.md`. The byte counts and SHA-256 values below were produced by step 4's exact commands with ImageMagick's libwebp 1.3.2 delegate, so on this machine they should match step 4's output verbatim. **Compare them.** A mismatch means either a source host changed its file or the local libwebp differs — in the first case stop and raise it, in the second replace the values with what you actually got and note the libwebp version.

```markdown
# Background images

Virtual-background assets for the picker's "Scenes" row, embedded into the binary
by `//go:embed all:assets` in `internal/web/web.go`.

All five are 1280x720 WebP. Each was centre-cropped to exactly 16:9 before being
resized, so none is distorted. `-quality` is NOT used: the ImageMagick WebP
delegate here (libwebp 1.3.2) ignores it — q30 and q95 produce byte-identical
output — so `-define webp:method=6` sets the effort and, for `carina.webp`,
`-define webp:target-size` caps the size.

| file | subject | source native | crop | bytes | SHA-256 |
|---|---|---|---|---|---|
| `office-space.webp` | Office Space (1999), cubicle farm | 1920x1040 | 1849x1040 | 61768 | `85bf0ee3b2cb647402db9ee31246a0b5e91070245b019622292831fc4cbdc0cf` |
| `space-ghost.webp` | Space Ghost Coast to Coast, set | 1024x735 | 1024x576 | 49538 | `681dfc3d5fd8f238edf367dc71d79d2aa9d76f4ff4973559e3571ea5cb023be1` |
| `star-trek.webp` | Star Trek: TNG, Enterprise-D bridge | 1600x1051 | 1600x900 | 61038 | `92768843151b4ac3d6088757d3133b6a2c8e5b0adb7a0022e7d11c753e7ae41d` |
| `idiocracy.webp` | Idiocracy (2006), Frito's apartment | 1200x674 | 1198x674 | 47706 | `88c88f407dd6f6d95dc88475175e19ada582d9b8006b48d265b95921d63f08c8` |
| `carina.webp` | Carina Nebula, "Cosmic Cliffs" | 1280x741 | 1280x720 | 127254 | `4a4f1b8557a89b576d75d33ecdeec14bea939c226dc63daaec7b58587e285732` |

`space-ghost.webp` is a 1.25x upscale — 1024x735 is the largest its source offers.

## Sources and licensing

`carina.webp` is from the ESA/Webb archive copy of the JWST "Cosmic Cliffs"
release (`https://esawebb.org/media/archives/images/screen/weic2205a.jpg`), credit
**NASA/ESA/CSA/STScI**. The NASA-hosted copy is public domain but only offered at
1041x603, which would have needed an upscale; the ESA copy is 1280x741 and needs
none. A 14575x8441 master exists at `.../images/large/weic2205a.jpg` if a
higher-resolution version is ever wanted.

The other four are frames from copyrighted film and television — Office Space
(20th Century Fox), Space Ghost Coast to Coast (Cartoon Network / Williams
Street), Star Trek: The Next Generation (Paramount), and Idiocracy (20th Century
Fox) — used here as personal virtual backgrounds, the same way one would set a
Zoom background. They are not licensed assets and are not offered for reuse.

## Regenerating

See the `convert` commands in
`docs/superpowers/plans/2026-07-30-image-backgrounds.md` (Task 1, step 4). Source
URLs are in the table above; the Space Ghost DeviantArt URL carries an expiring
token and will need re-copying from the artwork page.
```

- [ ] **Step 6: Run the Go test to verify it passes**

Run: `go test ./internal/web/ -run TestImageBackgroundAssetsEmbedded -v`
Expected: PASS.

Then the whole suite: `go test ./...` — expected: all packages ok (`internal/sfu` may be slow; that is normal).

- [ ] **Step 7: Commit**

```bash
git add internal/web/assets/img internal/web/web_test.go
git commit -m "feat(web): vendor five image-background assets

Five 1280x720 WebP scenes for the picker's Scenes row, ~339K total, embedded by
the existing //go:embed all:assets. Each is centre-cropped to exactly 16:9 before
resizing so none is distorted.

img/README.md records source, credit, licence, checksum and the exact encode
command per file. Four are copyrighted film/TV frames used as personal virtual
backgrounds and it says so plainly; carina.webp is the ESA/Webb Cosmic Cliffs
release, credit NASA/ESA/CSA/STScI.

-quality is deliberately absent from those commands: this ImageMagick WebP
delegate ignores it (q30 and q95 are byte-identical), so method=6 sets the effort
and carina, whose nebula noise resists compression, gets a target-size cap.

TestImageBackgroundAssetsEmbedded asserts each file is present and not truncated;
a missing asset would otherwise only surface as a 404 in a browser."
```

---

### Task 2: `coverRect` geometry

**Files:**
- Modify: `internal/web/assets/lib/backgrounds.js`
- Test: `internal/web/test/backgrounds.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `export function coverRect(sw, sh, dw, dh)` → `{sx, sy, sw, sh}` or `null`. Returns the source rectangle that fills `dw x dh` completely with a centre crop and no distortion; `null` when any dimension is not a positive number. Task 3 and Task 7 both call it.

- [ ] **Step 1: Write the failing tests**

Append to `internal/web/test/backgrounds.test.js`, and add `coverRect` to the existing import from `../assets/lib/backgrounds.js`:

```js
test("coverRect crops the sides when the source is wider than the target", () => {
  // 16:9 source into a 4:3 frame: full height, sides trimmed, centred.
  assert.deepEqual(coverRect(1280, 720, 640, 480), { sx: 160, sy: 0, sw: 960, sh: 720 });
});

test("coverRect crops top and bottom when the source is taller than the target", () => {
  // A square source into 16:9: full width, top and bottom trimmed, centred.
  assert.deepEqual(coverRect(1024, 1024, 1280, 720), { sx: 0, sy: 224, sw: 1024, sh: 576 });
});

test("coverRect uses the whole source when the aspect ratios match", () => {
  assert.deepEqual(coverRect(1280, 720, 640, 360), { sx: 0, sy: 0, sw: 1280, sh: 720 });
  assert.deepEqual(coverRect(1280, 720, 48, 27), { sx: 0, sy: 0, sw: 1280, sh: 720 });
});

test("coverRect returns null for degenerate dimensions rather than a NaN rect", () => {
  // drawImage throws IndexSizeError on a zero-sized source rect, so callers need a
  // signal to fall back instead of a rect they cannot use.
  for (const args of [[0, 720, 640, 360], [1280, 0, 640, 360], [1280, 720, 0, 360], [1280, 720, 640, 0]]) {
    assert.equal(coverRect(...args), null, `coverRect(${args}) should be null`);
  }
  assert.equal(coverRect(NaN, 720, 640, 360), null);
  assert.equal(coverRect(1280, 720, undefined, 360), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test internal/web/test/backgrounds.test.js`
Expected: FAIL — `coverRect is not a function` (or a SyntaxError about the missing export, depending on Node's resolution order).

- [ ] **Step 3: Implement `coverRect`**

Add to `internal/web/assets/lib/backgrounds.js`, in the painter-helpers section just after `glow`:

```js
// The source rectangle that fills a dw x dh target completely with a centre crop
// and no distortion — the "cover" fit. Needed because the image assets are 16:9
// but a camera frame may be 4:3, and the picker's chip is 48x27.
//
// Returns null for any non-positive or non-finite dimension. A zero-sized source
// rect makes drawImage throw IndexSizeError, so callers need a signal to fall
// back on rather than a rect they cannot use.
export function coverRect(sw, sh, dw, dh) {
  if (!(sw > 0) || !(sh > 0) || !(dw > 0) || !(dh > 0)) return null;
  const scale = Math.max(dw / sw, dh / sh); // whichever axis needs more growth wins
  const cw = Math.min(sw, dw / scale);
  const ch = Math.min(sh, dh / scale);
  return { sx: (sw - cw) / 2, sy: (sh - ch) / 2, sw: cw, sh: ch };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test internal/web/test/backgrounds.test.js`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add internal/web/assets/lib/backgrounds.js internal/web/test/backgrounds.test.js
git commit -m "feat(web): add coverRect, the centre-crop cover fit

Pure geometry: the source rectangle that fills a target completely without
distortion. The image backgrounds are 16:9 but a camera frame may be 4:3 and the
picker chip is 48x27, so both the compositor and the picker need this.

Returns null rather than a zero-sized rect for degenerate input — drawImage throws
IndexSizeError on one, so callers need a signal to fall back on."
```

---

### Task 3: `drawImageBackground`

**Files:**
- Modify: `internal/web/assets/lib/backgrounds.js`
- Test: `internal/web/test/backgrounds.test.js`

**Interfaces:**
- Consumes: `coverRect` from Task 2.
- Produces: `export function drawImageBackground(ctx, bitmap, fallback, w, h)` → `boolean`. Draws `bitmap` cover-fit into `w x h`, or fills with the `fallback` colour when the bitmap is absent or unusable. Returns `true` only if the bitmap was drawn. Task 6 (compositor) and Task 7 (picker) both call it.

Putting the branch here rather than inline in `segmenter.js` is what makes it testable: `segmenter.js` needs a real WebGL-backed canvas, this needs only a recording stub.

- [ ] **Step 1: Write the failing tests**

`fakeCtx` in `backgrounds.test.js` has no `drawImage`, so extend it. Add `drawImage` to the returned `ctx` object, alongside the existing `fillRect`:

```js
    drawImage: (...args) => {
      if (calls.length >= callLimit) throw new Error("unbounded work detected");
      calls.push({ op: "drawImage", args });
    },
```

Then append these tests, adding `drawImageBackground` to the import:

```js
test("drawImageBackground draws the bitmap cover-fit and reports it drew", () => {
  const { ctx, calls } = fakeCtx(640, 480);
  const bitmap = { width: 1280, height: 720 };
  assert.equal(drawImageBackground(ctx, bitmap, "#585454", 640, 480), true);
  assert.deepEqual(calls, [
    // source rect from coverRect(1280,720,640,480), destination the full frame
    { op: "drawImage", args: [bitmap, 160, 0, 960, 720, 0, 0, 640, 480] },
  ]);
});

test("drawImageBackground fills the whole frame with the fallback when there is no bitmap", () => {
  // This is the invariant that matters: until the bitmap decodes, something must
  // cover every pixel, or the raw camera shows through.
  const { ctx, calls } = fakeCtx(640, 480);
  assert.equal(drawImageBackground(ctx, null, "#585454", 640, 480), false);
  assert.deepEqual(calls, [{ op: "fillRect", x: 0, y: 0, w: 640, h: 480 }]);
  assert.equal(ctx.fillStyle, "#585454");
});

test("drawImageBackground falls back for a bitmap with unusable dimensions", () => {
  const { ctx, calls } = fakeCtx(640, 480);
  assert.equal(drawImageBackground(ctx, { width: 0, height: 0 }, "#585454", 640, 480), false);
  assert.deepEqual(calls, [{ op: "fillRect", x: 0, y: 0, w: 640, h: 480 }]);
});

test("drawImageBackground never leaves global canvas state dirty", () => {
  // Same contract the painters are held to: the compositor reuses one context.
  const { ctx } = fakeCtx(640, 480);
  drawImageBackground(ctx, { width: 1280, height: 720 }, "#585454", 640, 480);
  assert.equal(ctx.globalCompositeOperation, "source-over");
  assert.equal(ctx.filter, "none");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test internal/web/test/backgrounds.test.js`
Expected: FAIL — `drawImageBackground is not a function`.

- [ ] **Step 3: Implement `drawImageBackground`**

Add to `internal/web/assets/lib/backgrounds.js`, directly after `coverRect`:

```js
// Draw an image background: the bitmap cover-fit into the frame, or the effect's
// fallback colour when it is not (yet) available. Returns whether the bitmap was
// drawn, so a caller that wants to redraw once it arrives can tell.
//
// The fallback branch is load-bearing, not cosmetic. An image effect is applied
// SYNCHRONOUSLY while its bitmap is still decoding, so for the first frame or two
// this is the only thing standing between the subject and a composited raw camera
// frame. It must fill the entire rect, exactly as a painter must.
export function drawImageBackground(ctx, bitmap, fallback, w, h) {
  const rect = bitmap && coverRect(bitmap.width, bitmap.height, w, h);
  if (!rect) {
    fill(ctx, w, h, fallback);
    return false;
  }
  ctx.drawImage(bitmap, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, w, h);
  return true;
}
```

`fill` is the existing module-local helper; no new one is needed.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test internal/web/test/backgrounds.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/web/assets/lib/backgrounds.js internal/web/test/backgrounds.test.js
git commit -m "feat(web): add drawImageBackground

Draws an image background cover-fit, or fills with the effect's fallback colour
when the bitmap is not yet decoded. Returns whether it drew the bitmap.

Lives in backgrounds.js rather than inline in the compositor so it can be tested
against a recording stub — segmenter.js needs a real WebGL-backed canvas. The
fallback branch is the invariant, not a nicety: an image effect goes live while its
bitmap is still decoding, so for a frame or two this is all that keeps a raw camera
frame out of the composite."
```

---

### Task 4: Catalogue entries and grouping

**Files:**
- Modify: `internal/web/assets/lib/backgrounds.js`
- Test: `internal/web/test/backgrounds.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks (the entries are data).
- Produces:
  - Five `EFFECTS` entries of shape `{id, label, kind: "image", src, fallback}`.
  - `export const GROUPS` — a frozen array of `{id, label, effects}`, where `effects` is a frozen array of catalogue entries. Task 7 iterates it.

- [ ] **Step 1: Write the failing tests**

In `internal/web/test/backgrounds.test.js`: extend the frozen-id test, extend the well-formed test, and append the grouping tests. Add `GROUPS` to the import.

Replace the existing `"the effect id set is frozen"` body with:

```js
test("the effect id set is frozen", () => {
  assert.deepEqual(
    EFFECTS.map((e) => e.id),
    [
      "none", "blur", "blur-strong", "aurora", "dusk", "grid", "depth", "paper",
      "office-space", "space-ghost", "star-trek", "idiocracy", "carina",
    ],
  );
});
```

In `"every effect is well formed for its kind"`, widen the kind whitelist and add the image arm:

```js
    assert.ok(["none", "blur", "paint", "image"].includes(e.kind), `${e.id} has kind ${e.kind}`);
```

```js
    if (e.kind === "image") {
      assert.match(e.src, /^img\/[a-z0-9-]+\.webp$/, `${e.id} src ${e.src} is not an img/ webp`);
      assert.match(e.fallback, /^#[0-9a-fA-F]{6}$/, `${e.id} fallback ${e.fallback} is not a hex colour`);
      assert.equal(e.paint, undefined, `${e.id} is an image and must not carry a painter`);
    }
```

Then append:

```js
test("GROUPS partitions EFFECTS exactly", () => {
  // A new entry added to EFFECTS but not reachable through GROUPS would be
  // selectable from a saved preference yet invisible in the picker.
  const grouped = GROUPS.flatMap((g) => g.effects);
  assert.equal(grouped.length, EFFECTS.length, "an effect is missing from GROUPS or duplicated");
  assert.deepEqual(new Set(grouped), new Set(EFFECTS));
  for (const g of GROUPS) {
    assert.ok(g.id, "a group has no id");
    assert.ok(g.label, `group ${g.id} has no label`);
    assert.ok(g.effects.length > 0, `group ${g.id} is empty`);
  }
});

test("the Scenes group is exactly the image effects", () => {
  const scenes = GROUPS.find((g) => g.id === "scene");
  assert.deepEqual(
    scenes.effects.map((e) => e.id),
    ["office-space", "space-ghost", "star-trek", "idiocracy", "carina"],
  );
  const effects = GROUPS.find((g) => g.id === "effect");
  assert.ok(effects.effects.every((e) => e.kind !== "image"));
});

test("a saved image-background preference resolves", () => {
  assert.equal(resolveEffectId("carina"), "carina");
  assert.equal(effectById("office-space").src, "img/office-space.webp");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test internal/web/test/backgrounds.test.js`
Expected: FAIL — the frozen-id list mismatches (8 ids vs 13 expected) and `GROUPS is not defined`.

- [ ] **Step 3: Add the entries and GROUPS**

In `internal/web/assets/lib/backgrounds.js`, append the five entries inside `EFFECTS`, after `paper`. Use the measured average colours from the Global Constraints table:

```js
  // Photographic scenes. Unlike a painter these are assets: they need decoding
  // before first use, they are not resolution-independent, and `fallback` — the
  // image's own average colour — is what covers the frame until the bitmap lands.
  Object.freeze({ id: "office-space", label: "Office Space", kind: "image", src: "img/office-space.webp", fallback: "#585454" }),
  Object.freeze({ id: "space-ghost", label: "Space Ghost", kind: "image", src: "img/space-ghost.webp", fallback: "#675364" }),
  Object.freeze({ id: "star-trek", label: "Star Trek", kind: "image", src: "img/star-trek.webp", fallback: "#7D705E" }),
  Object.freeze({ id: "idiocracy", label: "Idiocracy", kind: "image", src: "img/idiocracy.webp", fallback: "#3E3524" }),
  Object.freeze({ id: "carina", label: "Carina", kind: "image", src: "img/carina.webp", fallback: "#614E54" }),
```

Then add `GROUPS` immediately after `EFFECTS`:

```js
// The picker's two rows. Derived from `kind` rather than a field on each entry —
// there is exactly one rule ("photos are scenes") and duplicating it per entry
// would just be a second place to get it wrong. A test asserts this partitions
// EFFECTS exactly, so an entry cannot go missing from the UI by being appended to
// EFFECTS alone.
export const GROUPS = Object.freeze([
  Object.freeze({
    id: "effect",
    label: "Effects",
    effects: Object.freeze(EFFECTS.filter((e) => e.kind !== "image")),
  }),
  Object.freeze({
    id: "scene",
    label: "Scenes",
    effects: Object.freeze(EFFECTS.filter((e) => e.kind === "image")),
  }),
]);
```

- [ ] **Step 4: Rewrite the file header**

The header currently argues that images are deliberately *not* shipped. Replace the first paragraph of `internal/web/assets/lib/backgrounds.js` (down to but not including the `// Every painter must:` line) with:

```js
// The background-effect catalogue: the painters that draw the procedural
// backgrounds, and the entries describing the photographic ones.
//
// Two kinds of virtual background live here, with different properties.
//
// PAINTED backgrounds are drawn in code. They cost no bytes in the binary, carry
// no licensing, and are resolution-independent — the same painter fills a 1080p
// frame and a 48x27 picker thumbnail, so a chip is an exact preview of the effect.
//
// IMAGE backgrounds (kind "image") are WebP assets under assets/img/, embedded in
// the binary and described here by `src` plus `fallback`. They give up all three
// of those properties: ~339K of payload, third-party imagery (see
// assets/img/README.md), and a fixed 1280x720 that upscales on a 1080p camera and
// says little at chip size. They buy recognisable scenes, which no painter can.
// The catalogue holds both; only painters are bound by the rules below.
//
// Every painter must:
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test internal/web/test/backgrounds.test.js`
Expected: PASS. The existing painter-purity, coverage, determinism and thumbnail-size tests already filter with `EFFECTS.filter((x) => x.kind === "paint")`, so the new entries are correctly excluded with no change needed there — confirm they still pass rather than assuming it.

Then the whole JS suite: `node --test internal/web/test/` — expected all pass.

- [ ] **Step 6: Commit**

```bash
git add internal/web/assets/lib/backgrounds.js internal/web/test/backgrounds.test.js
git commit -m "feat(web): add the five image entries and the picker's two groups

kind \"image\" carries a src and a fallback colour (the image's own average, so the
pre-decode state reads as a deliberate backdrop). GROUPS derives the picker's
Effects/Scenes split from kind, with a test asserting it partitions EFFECTS
exactly — otherwise an entry appended to EFFECTS alone would be selectable from a
saved preference yet invisible in the picker.

Rewrites the file header, which argued that painting in code exists specifically to
avoid shipping image assets. That is now only true of the painters, and left as-is
it would mislead the next reader; both kinds and what each trades away are now
stated.

The existing painter purity/determinism/coverage tests already filtered on
kind === \"paint\", so they needed no change."
```

---

### Task 5: The image loader

**Files:**
- Create: `internal/web/assets/lib/backgroundImages.js`
- Test: `internal/web/test/backgroundImages.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export function loadBackgroundImage(src)` → `Promise<ImageBitmap|null>`. Memoised per `src`; **never rejects**.
  - `export function _resetImageCacheForTests()` → `void`.

  Task 6 and Task 7 both call `loadBackgroundImage`.

This is a separate module because `backgrounds.js` is pure and its tests enforce that painters are deterministic and side-effect-free; network I/O there would undermine the property those tests protect.

- [ ] **Step 1: Write the failing tests**

Create `internal/web/test/backgroundImages.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadBackgroundImage, _resetImageCacheForTests } from "../assets/lib/backgroundImages.js";

// Node has neither fetch-of-a-blob nor createImageBitmap in the shape we need, so
// both are stubbed. install() also silences console.warn, which the failure path
// uses deliberately, and restores everything after the test.
function install(t, { fetchImpl } = {}) {
  const prev = { fetch: globalThis.fetch, cib: globalThis.createImageBitmap, warn: console.warn };
  const fetches = [];
  globalThis.fetch = (src) => {
    fetches.push(src);
    return fetchImpl ? fetchImpl(src) : Promise.resolve({ ok: true, blob: () => Promise.resolve({ src }) });
  };
  globalThis.createImageBitmap = (blob) => Promise.resolve({ width: 1280, height: 720, of: blob.src });
  console.warn = () => {};
  _resetImageCacheForTests();
  t.after(() => {
    globalThis.fetch = prev.fetch;
    globalThis.createImageBitmap = prev.cib;
    console.warn = prev.warn;
    _resetImageCacheForTests();
  });
  return { fetches };
}

test("a successful load resolves an ImageBitmap", async (t) => {
  install(t);
  const bmp = await loadBackgroundImage("img/carina.webp");
  assert.equal(bmp.width, 1280);
  assert.equal(bmp.of, "img/carina.webp");
});

test("concurrent calls for one src share a single fetch", async (t) => {
  const { fetches } = install(t);
  const [a, b, c] = await Promise.all([
    loadBackgroundImage("img/carina.webp"),
    loadBackgroundImage("img/carina.webp"),
    loadBackgroundImage("img/carina.webp"),
  ]);
  assert.equal(fetches.length, 1, "the loader re-fetched a src already in flight");
  assert.equal(a, b);
  assert.equal(b, c);
});

test("a later call reuses the cached bitmap", async (t) => {
  const { fetches } = install(t);
  const first = await loadBackgroundImage("img/carina.webp");
  const second = await loadBackgroundImage("img/carina.webp");
  assert.equal(fetches.length, 1);
  assert.equal(first, second);
});

test("a rejected fetch resolves null instead of throwing", async (t) => {
  install(t, { fetchImpl: () => Promise.reject(new Error("offline")) });
  // A throw here would reach the compositor's frame loop, where the watchdog would
  // read it as the effect failing and drop the background.
  assert.equal(await loadBackgroundImage("img/carina.webp"), null);
});

test("a non-ok response resolves null", async (t) => {
  install(t, { fetchImpl: () => Promise.resolve({ ok: false, status: 404 }) });
  assert.equal(await loadBackgroundImage("img/missing.webp"), null);
});

test("a decode failure resolves null", async (t) => {
  install(t);
  globalThis.createImageBitmap = () => Promise.reject(new Error("corrupt"));
  assert.equal(await loadBackgroundImage("img/carina.webp"), null);
});

test("a failure is not retried", async (t) => {
  const { fetches } = install(t, { fetchImpl: () => Promise.reject(new Error("offline")) });
  assert.equal(await loadBackgroundImage("img/carina.webp"), null);
  assert.equal(await loadBackgroundImage("img/carina.webp"), null);
  // The compositor asks per effect switch and the picker per render; retrying a
  // dead asset would turn one missing file into a request storm.
  assert.equal(fetches.length, 1, "a failed load was retried");
});

test("an empty src resolves null without fetching", async (t) => {
  const { fetches } = install(t);
  assert.equal(await loadBackgroundImage(""), null);
  assert.equal(await loadBackgroundImage(undefined), null);
  assert.equal(fetches.length, 0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test internal/web/test/backgroundImages.test.js`
Expected: FAIL — cannot resolve `../assets/lib/backgroundImages.js`.

- [ ] **Step 3: Implement the loader**

Create `internal/web/assets/lib/backgroundImages.js`:

```js
// Decoded bitmaps for the photographic backgrounds (backgrounds.js, kind
// "image"), memoised per src.
//
// Kept out of backgrounds.js on purpose: that module is pure, and its tests
// enforce that painters are deterministic and free of side effects. Network I/O
// there would undermine the property those tests exist to protect.
//
// The contract callers depend on: this NEVER rejects. A missing or corrupt asset
// resolves null, the compositor keeps drawing the effect's fallback colour, and
// the call survives with a degraded background instead of a dropped one. A throw
// would surface in the frame loop, where the watchdog reads consecutive failures
// as the effect being broken and turns the background off.

// src -> Promise<ImageBitmap|null>. The PROMISE is cached, not the bitmap, so
// concurrent callers share one in-flight request. A resolved null stays cached:
// the compositor asks on every effect switch and the picker on every render, so
// retrying a dead asset would turn one missing file into a request storm.
const cache = new Map();

export function loadBackgroundImage(src) {
  if (!src) return Promise.resolve(null);
  const cached = cache.get(src);
  if (cached) return cached;
  const pending = fetch(src)
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.blob();
    })
    .then((blob) => createImageBitmap(blob))
    .catch((err) => {
      // Once, not per frame: the cached null means we never get here again for
      // this src.
      console.warn(`background image ${src} could not be loaded:`, err);
      return null;
    });
  cache.set(src, pending);
  return pending;
}

// Tests only: drop every cached bitmap and in-flight request.
export function _resetImageCacheForTests() {
  cache.clear();
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test internal/web/test/backgroundImages.test.js`
Expected: PASS, all 8 tests.

- [ ] **Step 5: Commit**

```bash
git add internal/web/assets/lib/backgroundImages.js internal/web/test/backgroundImages.test.js
git commit -m "feat(web): add the background image loader

Memoises decoded ImageBitmaps per src, caching the promise so concurrent callers
share one request. It never rejects: a missing, 404ing or corrupt asset resolves
null and is not retried, so the compositor keeps drawing the effect's fallback and
one bad file cannot become a per-frame request storm. A throw would instead land in
the frame loop, where the watchdog reads consecutive failures as the effect being
broken and turns the background off.

Separate from backgrounds.js because that module is pure and its tests enforce
painter determinism and freedom from side effects."
```

---

### Task 6: Compositor wiring

**Files:**
- Modify: `internal/web/assets/lib/segmenter.js` (imports at :23, constructor around :87-98, `start` around :142, `setEffect` around :257, `_drawBackground` around :479)

**Interfaces:**
- Consumes: `drawImageBackground` (Task 3), `loadBackgroundImage` (Task 5), the `image` catalogue entries (Task 4).
- Produces: nothing later tasks call.

There is no unit test for this step. `_drawBackground` runs against a real canvas inside a MediaPipe-driven frame loop, which `node --test` cannot host — the same reason the existing compositor has no direct tests (`segmenter.test.js` covers only the `webglAvailable` probe). The branch's actual logic was extracted into `drawImageBackground` in Task 3 precisely so it *is* tested; what remains here is wiring, verified in Task 8.

- [ ] **Step 1: Extend the imports**

At `internal/web/assets/lib/segmenter.js:23`, replace:

```js
import { effectById } from "./backgrounds.js";
```

with:

```js
import { effectById, drawImageBackground } from "./backgrounds.js";
import { loadBackgroundImage } from "./backgroundImages.js";
```

- [ ] **Step 2: Add the bitmap map to the constructor**

Next to the existing `this._painted` / `this._paintedFor` fields (around :98), add:

```js
    // src -> decoded ImageBitmap for the "image" effects. Populated by _warmImage;
    // absent until a decode lands, which is exactly when _drawBackground falls back
    // to the effect's colour. Not a cache — backgroundImages.js owns that — just the
    // resolved handles, so the frame loop never touches a promise.
    this._bitmaps = new Map();
```

- [ ] **Step 3: Add `_warmImage` and call it where the effect is set**

Add the method next to `setEffect`:

```js
  // Kick off the decode for an image effect. Safe to call repeatedly: the loader
  // memoises per src, so redundant calls neither re-fetch nor re-decode. Nothing
  // awaits this — the effect is already live and drawing its fallback, and the
  // bitmap simply starts being used on whichever frame follows the decode.
  _warmImage(effect) {
    if (!effect || effect.kind !== "image") return;
    loadBackgroundImage(effect.src).then((bitmap) => {
      if (bitmap) this._bitmaps.set(effect.src, bitmap);
    });
  }
```

Then call it immediately after each of the two places `this._effect` is assigned from an id:

- in `start`, after `this._effect = effectById(effectId);` (around :142) — add `this._warmImage(this._effect);`
- in `setEffect`, after `this._effect = effectById(effectId);` (around :257) — add `this._warmImage(this._effect);`

Leave the constructor's `this._effect = effectById("none")` alone; "none" is not an image and warming it is a no-op anyway.

- [ ] **Step 4: Add the `image` branch to `_drawBackground`**

In `_drawBackground` (around :479), insert this branch after the `paint` branch's `return` and before the `kind "none"` comment:

```js
    if (effect.kind === "image") {
      // No canvas cache here, unlike the paint branch: re-running a painter every
      // frame is waste, but drawImage from an ImageBitmap is GPU-cheap, and caching
      // it would hold a second full-size copy of every asset. Falls back to the
      // effect's colour until the decode lands (see _warmImage) — the frame is
      // always fully covered, so the raw camera never shows through.
      drawImageBackground(ctx, this._bitmaps.get(effect.src) || null, effect.fallback, w, h);
      return;
    }
```

- [ ] **Step 5: Verify the JS suite still passes**

Run: `node --test internal/web/test/`
Expected: all pass. (No test covers this file's new code; this confirms nothing else broke — in particular that the added import does not create a cycle, which would surface as a module-resolution failure in `segmenter.test.js`.)

- [ ] **Step 6: Commit**

```bash
git add internal/web/assets/lib/segmenter.js
git commit -m "feat(web): composite the image backgrounds

_drawBackground gains an image branch: the decoded bitmap cover-fit, or the
effect's fallback colour until the decode lands. _warmImage starts that decode
wherever the effect is set from an id, and nothing awaits it — the effect is
already live and covered, so the bitmap just starts being used on the next frame.

That is what keeps the switch SYNCHRONOUS. Holding the switch until the image
decoded would add a fourth outcome to the picker's selection/revert/reason
machinery; instead the frame is covered from the first paint and the invariant that
no raw camera frame is composited holds throughout.

No canvas cache, unlike the paint branch: drawImage from an ImageBitmap is
GPU-cheap and caching would hold a second full-size copy of every asset."
```

---

### Task 7: The two-row picker

**Files:**
- Modify: `internal/web/assets/ui/background.js` (header comment, import at :15, `drawThumb` at :38, chip construction at :83-101)
- Modify: `internal/web/assets/style.css` (`.bg-strip` block at :1222-1235)

**Interfaces:**
- Consumes: `GROUPS` (Task 4), `drawImageBackground` (Task 3), `loadBackgroundImage` (Task 5).
- Produces: nothing.

No unit test: `ui/background.js` is DOM-only and the repo has no DOM test harness (matching the convention recorded in `2026-07-24-confirm-kick-ban-design.md`). Verified in Task 8.

- [ ] **Step 1: Extend the import and the header comment**

At `internal/web/assets/ui/background.js:15`, replace:

```js
import { EFFECTS, effectById } from "../lib/backgrounds.js";
```

with:

```js
import { GROUPS, drawImageBackground, effectById } from "../lib/backgrounds.js";
import { loadBackgroundImage } from "../lib/backgroundImages.js";
```

`EFFECTS` is no longer needed here — every entry is reachable through `GROUPS`, which a test guarantees.

Then replace the header's second paragraph (the "Thumbnails are drawn by the SAME painters…" sentence) with:

```js
// Chips are grouped into a labelled row per backgrounds.js GROUPS: the blur and
// painted "Effects", then the photographic "Scenes".
//
// A painted chip is drawn by the SAME painter that draws the real background, at
// 48x27, so it is an exact preview. A scene chip cannot be: it shows a 48x27 crop
// of the asset, which conveys the colour and little else, so its label carries the
// meaning. Scene chips paint the effect's fallback colour immediately and redraw
// when the bitmap decodes — which also warms the cache, so the image is normally
// ready before anyone clicks.
```

- [ ] **Step 2: Add the image branch to `drawThumb`**

In `drawThumb` (at :38), insert after the `ctx.clearRect(...)` line and before the `if (effect.kind === "paint")` line:

```js
  if (effect.kind === "image") {
    // The fallback now, the real image when it decodes. Requesting it here is also
    // what warms the loader's cache before the user picks anything.
    drawImageBackground(ctx, null, effect.fallback, THUMB_W, THUMB_H);
    loadBackgroundImage(effect.src).then((bitmap) => {
      if (!bitmap) return; // a dead asset keeps its fallback colour
      ctx.clearRect(0, 0, THUMB_W, THUMB_H);
      drawImageBackground(ctx, bitmap, effect.fallback, THUMB_W, THUMB_H);
    });
    return;
  }
```

- [ ] **Step 3: Build a row per group**

Replace the chip-construction loop in the constructor (`for (const effect of EFFECTS) { … }`, :83-101) with:

```js
    for (const group of GROUPS) {
      const chips = el("div", { class: "bg-row-chips" });
      for (const effect of group.effects) {
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
        chips.append(chip);
      }
      this.strip.append(
        el("div", { class: "bg-row" }, el("span", { class: "bg-row-label", text: group.label }), chips),
      );
    }
```

`this.chips` stays a flat `id -> chip` map, so `_reflect`, `select`, `restore` and `_disableEffects` need no change — they look chips up by id and never walk the DOM.

- [ ] **Step 4: Update the CSS**

In `internal/web/assets/style.css`, replace the `.bg-strip` and `.bg-picker.compact .bg-strip` blocks (:1222-1235) with:

```css
.bg-strip {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.bg-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0; /* let the chip row scroll rather than stretching the picker */
}

.bg-row-label {
  color: var(--muted);
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

/* The scroll moved from the strip to each row, so Effects and Scenes scroll
   independently and neither pushes the other sideways. */
.bg-row-chips {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  padding-bottom: 4px;
}

/* In the settings popover a scrolling strip is awkward to hit, so wrap instead. */
.bg-picker.compact .bg-row-chips {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  overflow-x: visible;
  padding-bottom: 0;
}
```

- [ ] **Step 5: Verify the JS suite still passes**

Run: `node --test internal/web/test/`
Expected: all pass — this confirms the new `ui/background.js` imports resolve and that dropping `EFFECTS` from its imports did not break `backgrounds.test.js`'s contract tests.

Also confirm nothing else referenced the old flat markup: `grep -rn "bg-strip" internal/web/assets/` should show only `style.css` and `ui/background.js`.

- [ ] **Step 6: Commit**

```bash
git add internal/web/assets/ui/background.js internal/web/assets/style.css
git commit -m "feat(web): group the picker into Effects and Scenes rows

One labelled row per backgrounds.js GROUPS. Scene chips draw the effect's fallback
colour immediately and redraw when the bitmap decodes, which is also what warms the
loader before anyone clicks; a dead asset simply keeps its colour.

The horizontal scroll moves from .bg-strip to each row's chip container so the two
rows scroll independently, and the compact (settings popover) grid moves with it.
this.chips stays a flat id -> chip map, so select/restore/_disableEffects are
untouched — they look chips up by id and never walk the DOM.

A painted chip is still an exact preview. A scene chip cannot be, and the header now
says so: 48x27 of a photo conveys the colour and little else, so the label carries
the meaning."
```

---

### Task 8: Manual verification and test-plan update

**Files:**
- Modify: `MANUAL-TEST.md` (background section, from :217)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Run the full automated suite**

```bash
gofmt -l ./internal/ ./cmd/     # expect no output
go vet ./...                    # expect no output
go test ./... 2>&1 | tail -12
node --test internal/web/test/ 2>&1 | grep -E "^# (tests|pass|fail)"
```

Expected: `gofmt` and `vet` silent, every Go package `ok`, JS `# fail 0`. `internal/sfu` takes ~20s; that is normal.

- [ ] **Step 2: Build and run the app**

```bash
go build -o /tmp/webrtc-chat-img ./cmd/webrtc-chat && ls -l /tmp/webrtc-chat-img
```

Note the binary size and compare against the pre-change binary if one is to hand — the increase should be ~340K, matching the asset total. A much larger jump means something else got embedded.

Then start it and open a room in a browser. (Use the `run` skill if the launch command is not obvious from `README.md`.)

- [ ] **Step 3: Verify by hand**

Check each of these, since none is covered by an automated test:

1. **Two rows.** The lobby's Background control shows an **EFFECTS** row (None, Blur, Blur+, Aurora, Dusk, Grid, Depth, Paper) and a **SCENES** row (Office Space, Space Ghost, Star Trek, Idiocracy, Carina).
2. **Chips show the photos**, not flat colour rectangles. If one stays a flat colour, its asset failed to load — check the console for `background image … could not be loaded` and the network tab for a 404.
3. **Each scene fills the frame.** Pick all five in turn. No camera visible at any edge, no stretching or squashing. Verify at a non-16:9 camera resolution too if your device offers one (4:3), which is what exercises `coverRect`'s crop.
4. **No raw-camera flash.** Switch rapidly between scenes and between a scene and a painted effect. You may briefly see a flat colour; you must never see the unmasked camera background.
5. **Persistence.** Pick Carina in the lobby, join, reload the page. The lobby should come back with Carina selected and the chip highlighted.
6. **In-call switching.** From the settings menu, switch to a scene mid-call and confirm a second browser sees the change.
7. **Compact layout.** The settings-menu picker wraps to a 4-across grid per row, with both row labels visible and the popover not stretched wide.
8. **No WebGL.** If you can launch a browser with WebGL disabled, confirm every chip in both rows is disabled except None, with the existing "unavailable without WebGL" title.

- [ ] **Step 4: Update MANUAL-TEST.md**

In the "Background blur and virtual backgrounds" section (from :217): the **Lobby catalogue** item must describe two labelled rows and all thirteen chips, and the **Virtual backgrounds fill the frame** item currently says "pick each of the 5 procedural backgrounds" — it must cover the five scenes as well. Add these items after the fill-the-frame check:

```markdown
- [ ] **Scene chips show their image** — every chip in the **Scenes** row shows a
      photo, not a flat colour rectangle. A flat chip means that asset failed to
      load: check the console for "background image … could not be loaded".
- [ ] **Scenes fill a non-16:9 frame** — the assets are 16:9. On a device whose
      camera offers 4:3, pick each scene and confirm it still fills the frame with
      no letterboxing and no stretching (it is centre-cropped).
- [ ] **No raw camera during a scene switch** — switch rapidly between scenes, and
      between a scene and a painted effect. A brief flat colour is expected while
      the image decodes; the unmasked camera background must never appear.
- [ ] **A scene survives a reload** — pick a scene in the lobby, join, reload.
      The lobby returns with that scene selected and its chip highlighted.
```

- [ ] **Step 5: Commit**

```bash
git add MANUAL-TEST.md
git commit -m "docs: cover the image backgrounds in the manual test plan

The catalogue and fill-the-frame checks both assumed five procedural backgrounds in
one flat strip. Updates them for the two labelled rows and thirteen chips, and adds
checks for the cases only images have: a chip stuck on its fallback colour (a failed
asset), a 16:9 asset in a 4:3 frame (the centre crop), a raw-camera flash during the
synchronous switch, and a scene surviving a reload."
```

- [ ] **Step 6: Merge to master**

Only after every check in step 3 passes.

```bash
git checkout master
git merge --ff-only feat/image-backgrounds
git branch -d feat/image-backgrounds
git log --oneline -8
git status -sb | head -1
```

Do **not** push. Report that master is ahead of origin by N commits and is not pushed, and leave the push and deploy to the user.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Reversing the prior decision (header rewrite) | 4, step 4 |
| Assets: five WebP, 1280x720, crop table | 1, steps 3-4 |
| Assets: not gzipped | 1 (no gzip step; WebP is already compressed) |
| Provenance README (source, credit, licence, SHA-256, command) | 1, step 5 |
| Catalogue: `kind: "image"` with `src` + `fallback` | 4, step 3 |
| Catalogue: `GROUPS` partition + test | 4, steps 1 and 3 |
| `coverRect` | 2 |
| Loader: memoised, never rejects, no retry | 5 |
| Compositor: image branch, synchronous switch, no canvas cache | 6 |
| Picker: two rows, image thumbs, `disableAll` unchanged | 7 |
| Tests: JS catalogue/coverRect/loader | 2, 3, 4, 5 |
| Tests: Go asset presence | 1, step 1 |
| Risks (binary size, resolution, chip fidelity, third-party) | recorded in 1's README and 4's header; binary size measured in 8, step 2 |

Two deviations from the spec, both deliberate:

1. The spec said the painter purity tests "filter to `kind === "paint"`" as a change to make. They **already** filter that way, so no change is needed — Task 4 step 5 says to confirm rather than edit.
2. The spec did not mention `drawImageBackground`. Task 3 adds it because putting the branch in `backgrounds.js` is the only way to unit-test the fallback invariant; `segmenter.js` needs a real canvas. This strengthens the spec's testing section rather than departing from its design.

**Placeholder scan:** None. Task 1's README carries real byte counts and SHA-256 values, produced by running that task's exact commands during planning and verified reproducible; step 5 tells the implementer to compare rather than trust them, and what to do on a mismatch. No "TBD", no "add error handling", no "similar to Task N" — every code step carries its actual code.

**Type consistency:** `coverRect(sw, sh, dw, dh) → {sx, sy, sw, sh}|null` is defined in Task 2 and consumed in Task 3 only. `drawImageBackground(ctx, bitmap, fallback, w, h) → boolean` is defined in Task 3 and called in Tasks 6 and 7 with that exact arity. `loadBackgroundImage(src) → Promise<ImageBitmap|null>` is defined in Task 5 and called in Tasks 6 and 7. `GROUPS` entries are `{id, label, effects}` in Task 4 and destructured as `group.label` / `group.effects` in Task 7. Entry fields `src` and `fallback` are named identically in Tasks 1, 4, 6 and 7. `this._bitmaps` (Task 6) is keyed by `effect.src`, written in `_warmImage` and read in `_drawBackground`.
