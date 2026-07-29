# Image backgrounds

Adds five photographic virtual backgrounds — recognisable film/TV sets plus one
astronomy image — alongside the existing blur and procedurally-painted effects,
and splits the picker into two labelled rows.

Builds directly on [2026-07-28-virtual-backgrounds-design.md](2026-07-28-virtual-backgrounds-design.md);
everything there about the segmenter, the watchdog, and the WebGL precondition is
unchanged and assumed here.

## Goals

- Ship five image backgrounds selectable from the existing picker.
- Keep the catalogue's single source of truth: one entry per effect, one id space,
  one saved-preference gate.
- Preserve the pipeline's governing invariant — the worst outcome is "no effect",
  never "no camera", and never a frame of raw camera leaking to the wire.
- Leave the picker's state machine untouched. It is delicate (see the reverted /
  reason / `_settle` history) and an async effect switch would be a new failure mode.

## Non-goals

- User-uploaded or user-supplied backgrounds. The catalogue stays fixed at build time.
- Per-image tuning (brightness, blur-behind, mirroring).
- Animated or video backgrounds.
- Replacing any existing painted effect. All eight current entries survive.

## Reversing a prior decision

`lib/backgrounds.js` currently opens by explaining that backgrounds are painted in
code *specifically* to avoid shipping image files:

> Backgrounds are drawn in code rather than shipped as image files. That keeps the
> binary from carrying photo assets, sidesteps image licensing entirely, and stays
> sharp at any resolution — the same painter fills a 1080p frame and a 48x27 picker
> thumbnail, so a chip is always an exact preview of the effect.

All three claims stop being true for the new entries. That is an accepted, deliberate
trade, but the comment must be rewritten rather than left to mislead the next reader:
painters keep their properties, image entries do not, and the file now holds both.

The resolution-independence point is the one with teeth. A painter is an exact preview
at any size; an image is not, and a 1280x720 asset is an upscale on a 1080p camera.
Accepted — see Risks.

## Assets

Five WebP files at 1280x720, quality 80, in `internal/web/assets/img/`. The existing
`//go:embed all:assets` picks them up with no change to `web.go`.

| file | subject | source native | crop to 16:9 |
|---|---|---|---|
| `office-space.webp` | Office Space cubicle farm | 1920x1040 | crop width to 1849, downscale |
| `space-ghost.webp` | Space Ghost Coast to Coast set | 1024x735 | crop height to 576, upscale 1.25x |
| `star-trek.webp` | TNG Enterprise-D bridge | 1600x1051 | crop height to 900, downscale |
| `idiocracy.webp` | Frito's apartment | 1200x674 | crop to 1198x674, upscale 1.07x |
| `carina.webp` | Carina Nebula ("Cosmic Cliffs") | 1280x741 | crop height to 720, no resize |

Cropping happens offline, once, so the framing is chosen rather than left to a
centre-crop at runtime. Each file is produced by a recorded ImageMagick command of
the form:

```
convert <src> -gravity center -crop <W>x<H>+0+0 +repage \
        -resize 1280x720 -quality 80 <out>.webp
```

**Not gzipped.** WebP is already compressed; the pre-compressed serving path exists
for the MediaPipe `.wasm`/`.tflite` binaries and gains nothing here.

`space-ghost.webp` is a 1.25x upscale — 1024x735 is the largest the source offers.
It is a low-detail CG set, so the upscale is not very visible, but it is the softest
of the five.

### Provenance

`internal/web/assets/img/README.md` records, per file: source URL, credit line,
licence, SHA-256 of the committed file, and the exact command above — so a re-fetch
is reproducible and a substituted file is detectable. This mirrors
`vendor/mediapipe/README.md`.

`carina.webp` derives from the ESA/Webb archive copy of the Webb "Cosmic Cliffs"
release and is credited NASA/ESA/CSA/STScI. The original NASA-hosted copy is public
domain but only available at 1041x603, which would have required a 1.23x upscale;
the ESA copy is 1280x741 and needs none.

The other four are third-party studio frames from Office Space, Space Ghost Coast to
Coast, Star Trek: The Next Generation, and Idiocracy, used as personal virtual
backgrounds. The README states that plainly rather than implying they are licensed
assets.

## Catalogue

`lib/backgrounds.js` gains a third kind alongside `blur` and `paint`:

```js
Object.freeze({
  id: "office-space",
  label: "Office Space",
  kind: "image",
  src: "img/office-space.webp",
  fallback: "#4a4438",   // illustrative; the image's average colour, computed offline
})
```

`fallback` is what the compositor and the picker draw until the bitmap decodes, and
what they keep drawing if it never does. Using the image's own average colour makes
that state read as a deliberate backdrop rather than a broken one. The values are
computed offline and recorded in `img/README.md` alongside the checksums.

`EFFECTS` stays the flat, frozen list backing `resolveEffectId` and `effectById`;
five entries are appended. Ids are a localStorage contract, so the existing
"the effect id set is frozen" test is updated deliberately, as a review checkpoint.

### Grouping

A new export partitions the catalogue for the two-row picker:

```js
export const GROUPS = Object.freeze([
  Object.freeze({ id: "effect", label: "Effects", effects: /* non-image */ }),
  Object.freeze({ id: "scene",  label: "Scenes",  effects: /* image */ }),
]);
```

The picker renders one labelled row per group and needs no knowledge of kinds. A
test asserts `GROUPS` partitions `EFFECTS` exactly — every effect in exactly one
group, nothing invented — so a future entry cannot go missing from the UI by being
added to `EFFECTS` alone.

### `coverRect`

```js
export function coverRect(sw, sh, dw, dh) // -> {sx, sy, sw, sh}
```

Pure. Returns the source rectangle that, drawn into `dw x dh`, fills it completely
with a centre crop and no distortion. Needed because the assets are 16:9 but a
camera frame may not be (4:3 is common), and because the picker's chip is 48x27.
Lives in `backgrounds.js` with the other pure geometry, shared by the compositor and
the picker, and unit-tested directly rather than through a canvas.

## Loading — `lib/backgroundImages.js`

New module:

```js
export function loadBackgroundImage(src)  // -> Promise<ImageBitmap|null>
export function _resetImageCacheForTests()
```

- Memoised by `src`; concurrent callers share one in-flight promise.
- **Never rejects.** A fetch or decode failure logs once, caches `null`, and resolves
  `null`. The compositor then keeps drawing `fallback` — degraded, but still an
  effect, and still not the raw camera.
- A cached `null` is not retried. Retrying per frame would turn a missing asset into
  a request storm.
- `fetch(src)` -> `blob()` -> `createImageBitmap()`. `ImageBitmap` is the form
  `drawImage` consumes most cheaply.

It is a separate module because `backgrounds.js` is pure and its tests enforce that
painters are deterministic and side-effect-free. Network I/O there would undermine
the property those tests exist to protect.

## Compositor

`segmenter.js` `_drawBackground` gains an `image` branch:

```
bitmap = cached bitmap for effect.src
if bitmap:  drawImage(bitmap, ...coverRect(bitmap.w, bitmap.h, w, h), 0, 0, w, h)
else:       fill(w, h, effect.fallback)
```

No canvas caching. The `paint` branch caches into `_painted` because re-running a
painter every frame is wasteful; `drawImage` from an `ImageBitmap` is GPU-cheap and
needs no such cache, and skipping it avoids a second copy of every asset in memory.

**The effect switch stays synchronous.** `setEffect` and `start` kick off
`loadBackgroundImage` and return immediately; the effect is considered active at
once. This is the central design choice:

- The picker's state machine — selection, revert, reason, the saved-background
  restore — is unchanged. An async switch would need a fourth outcome ("selected but
  not yet showing") threaded through all of it.
- The invariant holds from the first frame: `fallback` covers the whole frame, so
  the raw camera is never composited even for one frame.
- The cost is that a first-ever selection may show a solid colour for a frame or two.
  The asset is same-origin, embedded, and ~50KB, and the picker warms every image
  when it renders its chips, so in practice the bitmap is ready before the first
  composite.

## Picker

`ui/background.js` renders one labelled row per `GROUPS` entry instead of a single
flat strip. `drawThumb` gains an image branch — bitmap cover-fit into 48x27 if
loaded, else `fallback` — and re-draws when the load resolves, so chips fill in
rather than staying flat.

Rendering the chips calls `loadBackgroundImage` for every image entry, which is what
warms the cache before any click.

`disableAll()` (the no-WebGL path) is unchanged: every chip but "None" is disabled,
now across both rows.

## Testing

### JS (`node --test`)

`backgrounds.test.js`, extended:

- The frozen id list gains the five new ids — updated deliberately, since ids are a
  localStorage contract.
- The `kind` whitelist gains `"image"`.
- Every image entry has a `src` under `img/` and a `fallback` matching `#rrggbb`.
- `GROUPS` partitions `EFFECTS` exactly: the union is `EFFECTS`, the intersection is
  empty, group labels are non-empty.
- The painter purity/coverage tests filter to `kind === "paint"`; image entries have
  no `paint` function and must not be fed to the fake context.

`coverRect`, new cases: source wider than destination (crops sides), source taller
(crops top/bottom), exact aspect match (full source, no crop), square into wide, and
degenerate zero width/height (returns something drawable rather than NaN).

`backgroundImages.test.js`, new, with a stubbed `fetch`/`createImageBitmap`:

- Two concurrent calls for one src produce exactly one fetch.
- A rejected fetch resolves `null` and does not throw.
- A second call after a failure does not re-fetch.
- A successful load is cached and returned on subsequent calls.

### Go

`web_test.go` gains a test asserting each of the five `img/*.webp` files is embedded
and over a minimum size, mirroring `TestMediaPipeAssetsEmbedded`. Without it a
missing or truncated asset only surfaces as a 404 in a browser, which no test would
catch.

## Risks

- **Binary size.** Roughly +250KB. Small next to the vendored MediaPipe runtime, but
  it is the first photo payload in the binary and sets the precedent.
- **Resolution.** 1280x720 assets upscale on a 1080p camera. Painters do not. Judged
  acceptable: the background sits behind a subject and is rarely the focus. Ships at
  720p rather than 1080p because doubling the bytes for a background is a poor trade.
- **Chips are no longer exact previews.** A 48x27 crop of a photo conveys little.
  Accepted; the label carries the meaning for scenes in a way it did not for washes.
- **Third-party imagery.** Four of the five are studio frames. Recorded honestly in
  `img/README.md`; this is ordinary personal virtual-background use, not asset
  redistribution.
