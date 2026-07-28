# Virtual and blurred backgrounds

Let a participant replace or blur what is behind them, chosen in the pre-join
lobby and changeable mid-call. Client-only: no server, protocol, or signaling
change.

## Goals

- **Blur** the real background, at two strengths.
- **Replace** it with one of five backgrounds drawn procedurally in code.
- Choose in the **lobby** (with live preview) and in the **in-call ☰ menu**.
- Persist the choice across visits, like the existing mic/camera preferences.
- **Degrade honestly** on a device that cannot keep up, rather than shipping a
  stuttering feed to the room.

## Non-goals

- User-uploaded background images. No upload UI, no IndexedDB, no quota
  handling. The catalogue is fixed and code-drawn.
- Photographic backgrounds. Nothing ships as an image file (see
  [Procedural backgrounds](#procedural-backgrounds)).
- Any server-side awareness. The SFU forwards whatever track it is given; it
  neither knows nor cares that frames were composited.
- Segmentation for anything but the camera. Screen shares are never processed.

## Constraint: vanilla JS

Everything written for this feature is hand-written vanilla ES modules,
consistent with the rest of `internal/web/assets/`: no framework, no bundler, no
transpile step, no `node_modules` at runtime.

The single exception is MediaPipe's own minified bundle, vendored under
`assets/vendor/mediapipe/` and imported as a plain ES module. This is the same
bargain already struck by `vendor/noise-suppressor-worklet.min.js` — a
third-party blob doing one job, behind a small wrapper we own. `npm pack` is
used only as a download mechanism to obtain the files; it adds no runtime
dependency.

## Architecture

The noise-suppression graph is the model to follow, with one deliberate
inversion.

```
camera device track ──► hidden <video> ──► ImageSegmenter ──► person mask
       (parked)               │                                   │
                              └──────► canvas compositor ◄────────┘
                                              │
                                      captureStream(24) ──► processed track
                                              │
                                       INTO media.stream
```

For audio, the **raw** mic track stays in `media.stream` and the processed track
lives beside it in `Media._processedTrack`. For video the opposite holds: the
**processed** track goes into `media.stream` and the raw device track is parked
outside it.

That inversion is what makes the feature nearly free downstream, because both
consumers bind the stream exactly once and never rebind:

- `ui/prejoin.js:251` — `this.video.srcObject = this.media.stream`
- `ui/grid.js:529` — `tile.cameraVideo.srcObject = this.media.stream`

So the user sees their own effect in the lobby preview and the self tile with no
change to either file. And because `Media.cameraTrack` still returns
`stream.getVideoTracks()[0]`, the existing listener at `app.js:374` publishes the
processed track through the `replaceTrack("camera", …)` path it already has — no
renegotiation and no signaling message. The only Go production change is
pre-compressed asset serving in `static.go` (see [Assets](#assets));
`//go:embed all:assets` picks up the new asset directory on its own.

### Modules

| File | Purpose | Unit tested |
|---|---|---|
| `lib/backgrounds.js` | Effect catalogue and the procedural painters. Pure data plus `ctx`-drawing functions. | yes (new) |
| `lib/fpsGuard.js` | Frame-rate watchdog as a pure state machine. | yes (new) |
| `lib/segmenter.js` | MediaPipe lifecycle, canvas compositor, render loop. Browser-only. | no |
| `ui/background.js` | The `BackgroundPicker` component, used by both the lobby and the ☰ menu. | no |
| `net/media.js` | Gains `setBackground()` and parked-raw-track bookkeeping. | no (existing) |

`ui/background.js` is a separate file rather than more of `ui/controls.js`
because that file is already 1,233 lines, and because the picker has two
consumers.

### Changes to `net/media.js`

New state: `_bgEffect` (the selected effect id), `_segmenter` (the live pipeline
or null), `_rawCameraTrack` (the device track, parked while an effect is on).

New method `setBackground(effectId)`: builds, swaps, or tears down the pipeline
and emits `camera-track` with whatever track should now be published. Returns the
effect actually in force, so a caller that requested one and got `"none"` back
knows the build failed. Idempotent for the current state; when the camera is off
it records the choice and returns without building anything.

Four existing methods must learn about the parked track. Each maps onto something
`useDevices` already does for noise suppression at `media.js:134`:

- `disableCamera()` — stop **both** the processed and the parked raw track. The
  device indicator light must go out; stopping only the processed track would
  leave the camera lit with no visible video, which is worse than either state.
- `enableCamera()` — re-acquire the device, then re-apply `_bgEffect`.
- `useDevices({cameraId})` — rebuild the pipeline onto the new device, mirroring
  `rebuildNs`. On rebuild failure, fall back to the raw camera rather than
  leaving a dead video track.
- `stop()` — tear the segmenter down and release its canvases.

`_swapTrack` must **not** stop the parked raw track, so the effect path swaps
tracks explicitly rather than routing through it.

## The compositor

`ImageSegmenter` in `runningMode: "VIDEO"` with `outputConfidenceMasks: true`.
A confidence mask, not a category mask: the soft probability edge is what keeps
hair and shoulders from looking die-cut. Delegate `GPU`, falling back to `CPU` if
WebGL initialisation throws. The model resizes internally to 256×256, so the
video element is fed directly rather than pre-scaled.

Render loop on `video.requestVideoFrameCallback` where present,
`requestAnimationFrame` otherwise (Firefox shipped rVFC only recently). Per
frame, across two canvases:

1. Paint the background — the blurred video, or the cached procedural canvas.
2. On a scratch canvas: draw the frame, then `globalCompositeOperation =
   "destination-in"` with the mask, yielding the alpha-cut person.
3. Draw the scratch canvas over the background.

The mask is feathered by a small blur before step 2, so the composite edge is not
a hard cutout.

Output is `canvas.captureStream(24)`.

**Mask conversion is the CPU hot path.** With a 2D-canvas compositor the mask
arrives as a `Float32Array` and must be widened into an `ImageData` alpha channel
(~65k elements per frame) before it can be drawn. This is the first thing to
measure if the guard trips on hardware that should cope. The escape hatch — a
WebGL compositor consuming `mask.getAsWebGLTexture()` directly — is deliberately
**not** built now; it roughly doubles the compositor's size and complexity for a
problem we have not yet observed.

The exact index of the person mask within `result.confidenceMasks` is confirmed
against the vendored model during implementation rather than assumed here.

### Blur

`ctx.filter = "blur(Npx)"` when supported, with a progressive downscale-upscale
fallback for Safari < 17, which lacks `CanvasRenderingContext2D.filter`. The same
helper feathers the mask; where the fallback path is in use the feather is
skipped, giving a slightly harder edge rather than no blur at all.

Radius is a fraction of frame width, not a pixel constant, so a given strength
looks the same at 480p and 1080p: roughly 1.2% for **Blur** and 3% for **Blur+**.

### Procedural backgrounds

Five painters with the signature `(ctx, w, h) => void`, drawing from the palette
already in `style.css` (`--bg #14161a`, `--panel #1d2026`, `--accent #4c8dff`):

- **Aurora** — multi-stop radial wash, indigo to violet to teal
- **Dusk** — vertical gradient, warm horizon
- **Grid** — faint dot grid on the app's dark ground
- **Depth** — accent-tinted radial vignette
- **Paper** — soft light neutral, for a bright room

Each is deterministic — no per-frame randomness, which would shimmer — and is
painted **once** into an offscreen canvas, reused every frame, repainted only on
resize. Regenerating a gradient 24 times a second would be pure waste.

Because painters are ordinary functions of a canvas context, the picker's
thumbnails are produced by calling the same painters into a 48×27 canvas. A chip
is therefore always an exact preview of what the effect produces, and adding an
effect means adding one catalogue entry rather than an entry plus an image file.

## The watchdog

`lib/fpsGuard.js` is a pure state machine. `push(timestampMs)` is called per
composited frame; the guard holds no clock of its own, so `node --test` can drive
it with synthetic timestamps and assert exactly when it trips.

- **Grace period** — the first ~3s after start is ignored. Model warm-up and
  first-frame shader compilation would otherwise trip it immediately.
- **Trip condition** — sustained throughput below ~12 fps across a 5s window.
- **One-shot** — it trips at most once, and re-arms when a new effect is chosen.

**Ownership of the trip.** The guard decides *whether* to bail; it does not act.
`lib/segmenter.js` calls `push()` from its render loop and, on a trip, invokes an
`onBail` callback supplied at construction. `net/media.js` supplies that callback
and performs the revert, because it is the only module that owns the tracks.
`ui/background.js` is notified in turn so it can reset the chip and show the
notice. Keeping the decision, the track surgery, and the UI in three separate
modules means the guard stays a pure function of timestamps and remains testable.

On trip, in order: the segmenter stops, the raw camera track swaps back into
`media.stream`, `camera-track` fires and republishes the unprocessed camera, the
picker resets to None, and an inline notice appears in the picker row.

**The reverted value is not persisted.** This follows the reasoning already
recorded at `controls.js:775` about noise suppression: writing a state the user
did not choose means reading it back forever after as a deliberate preference. A
phone that overheated once must not silently lose the feature for good.

### Accepted regression: backgrounded tabs

`requestAnimationFrame` and `requestVideoFrameCallback` both stop in a
backgrounded tab, so `captureStream` freezes and remote peers see a still frame.
Today, with no effect active, the camera keeps sending live video.

This is accepted. It affects only users who have chosen an effect *and* tabbed
away; Meet's and Zoom's web clients behave the same; and both alternatives are
worse. Republishing the raw track while hidden would flash the user's real room
to everyone in the call — the exact thing they turned the feature on to prevent.
A `setTimeout`-driven loop is throttled to roughly 1 fps in background tabs, which
is not meaningfully better than frozen.

## UI

`ui/background.js` exports `BackgroundPicker`: a strip of thumbnail chips — None,
Blur, Blur+, then the five procedural effects. It is mounted in two places:

- **Lobby** — a row in the pre-join form, below the camera and microphone
  selects, so the choice can be checked against the live preview before anyone
  sees it.
- **In-call** — `_settingsRow("Background", picker)` in the ☰ menu. This variant
  wraps to a 4-per-row grid so the popover does not become excessively wide.

The MediaPipe bundle is **lazy-loaded on first picker interaction**, not on page
load. A user who never touches backgrounds pays nothing at runtime beyond the
larger binary. While the ~3.4 MB (gzipped) is loading, the chosen chip shows a
pending state and the picker is disabled, mirroring how the noise-suppression
button handles its ~2 MB worklet load.

## Persistence

One new key on the existing `saveMediaPrefs` merge:

```
background: "none" | "blur" | "blur-strong" | "aurora" | "dusk" | "grid" | "depth" | "paper"
```

The lobby restores it in `_applyMediaPrefs()`, alongside the mic and camera state
already restored there. A returning user with a saved effect pays the bundle load
on lobby mount, overlapping the camera warm-up. If the camera is off, the choice
is stored and applied whenever the camera comes back on.

An unrecognised stored value (a rename, a downgrade) falls back to `"none"`
rather than throwing.

## Assets

Vendored under `assets/vendor/mediapipe/`, obtained via `npm pack
@mediapipe/tasks-vision` (measured, version 1.0.0):

| File | Raw | Stored (gzip) |
|---|---|---|
| `vision_wasm_internal.wasm` | 11.5 MB | 3.38 MB |
| `vision_wasm_internal.js` | 323 KB | ~80 KB |
| `vision_bundle.mjs` | 155 KB | ~40 KB |
| `selfie_segmenter.tflite` | 250 KB | 212 KB |
| **Total** | **~12.2 MB** | **~3.7 MB** |

Taking the binary from ~18.7 MB to roughly **22.4 MB (about +20%)**.

**SIMD-only.** The `vision_wasm_nosimd_internal.*` fallback build (another
11.1 MB raw) is deliberately not vendored. WASM SIMD is available in Chrome 91+,
Firefox 89+, and Safari 16.4+, which covers every browser this app otherwise
targets; carrying a second copy of the runtime to serve older ones is not worth
doubling the payload.

**The model is a separate download.** Unlike the legacy package, tasks-vision
does not bundle a `.tflite`. `selfie_segmenter.tflite` is fetched once from
Google's model CDN at vendoring time and committed into the tree — it is never
fetched at runtime, so the deployed binary stays self-contained and no user's
browser is sent to a Google endpoint.

### Pre-compressed serving

Assets are stored **gzipped** in the embed and served with `Content-Encoding:
gzip`. This is the difference between +20% and +65% binary growth, and it cuts a
user's first-load download from 11.5 MB to 3.4 MB. Browsers decompress in the
stream, so `WebAssembly.instantiateStreaming` still works.

`static.go` gains a small pre-compressed branch: when the requested path has a
`.gz` sibling in the embed and the request carries `Accept-Encoding: gzip`, serve
the sibling with the **original** path's `Content-Type` plus `Content-Encoding:
gzip`. Notes:

- Content type must be derived from the original name, never from `.gz`, or the
  browser gets `application/gzip` and refuses to compile the module.
- This path uses `io.Copy` rather than `http.ServeContent`: byte ranges over a
  content-encoded body are more trouble than they are worth here, so `Accept-Ranges`
  is not advertised for it.
- A client that does not send `Accept-Encoding: gzip` is not served the raw file
  from a fallback path — the raw file is not embedded at all, so that would be a
  404. `serveEmbeddedGzip` decompresses the stored `.gz` on the fly instead and
  serves that, so behaviour is unchanged (a correct, uncompressed response) for a
  client that cannot or will not accept gzip.
- `http.ServeContent` already returns `application/wasm` for `.wasm` (verified),
  and `.tflite` has no registered MIME type so it is sniffed as
  `application/octet-stream` — correct, since MediaPipe fetches it as an
  `ArrayBuffer`.

## Testing

**JS (`node --test`), following the existing pure-logic-in-`lib/` convention:**

- `test/fpsGuard.test.js` — grace period, trip threshold, one-shot behaviour,
  re-arm on a new selection. Fully deterministic; the guard takes timestamps as
  arguments precisely so this is possible.
- `test/backgrounds.test.js` — catalogue invariants (unique ids, every entry has
  a label and a painter or blur radius) and a **frozen id set**. A rename would
  silently orphan every saved preference and nothing else would catch it.
- `test/prefs.test.js` — extend for the `background` key round-trip, including
  the unrecognised-value fallback.

**Go:**

- `internal/web/web_test.go` — assert the vendored WASM and `.tflite` are present
  in the embedded FS. A missing model is a feature dead on arrival that no JS
  test would notice.
- `internal/server/static_test.go` — for a gzip-accepting request, assert the
  response carries `Content-Encoding: gzip` **and** `Content-Type:
  application/wasm` (not `application/gzip`), and that the decompressed body
  begins with the WASM magic bytes `\0asm`. Also assert a request *without*
  `Accept-Encoding: gzip` still gets a usable uncompressed response.

**Manual, on-device — reported as pending, not claimed as verified:**

Segmentation quality (hair edges, low light, glasses), and the mobile thermal
behaviour the watchdog exists to catch, cannot be verified from the test suite.
A MANUAL-TEST.md section covers both, following the precedent set by the iOS call
sounds work.

## Mechanisms added during implementation

The four items below were not anticipated by the design above. Each is now
load-bearing — removing it reintroduces a real defect — but none has a design
record anywhere else, so it goes here rather than staying implicit in code
comments.

**The `holdVideo` / `_heldVideo` withheld-announcement protocol
(`net/media.js`).** This spec's own goal — "degrade honestly," and more
pointedly the privacy motivation for the whole feature — turns out to require
withholding an announcement, not just making one. Several paths rebuild the
pipeline on a live call: a mid-call camera switch (`useDevices`), turning the
camera back on with an effect already chosen (`enableCamera`), and — as of the
F1 fix below — the very first publish on join. In every one of these, the raw
device track becomes briefly current in `media.stream` before the rebuilt
composite replaces it, and the natural `camera-track` announcement for that raw
track would show remote peers the exact room the user turned an effect on to
hide. `holdVideo` (an option to `_adopt`/`_swapTrack`, media.js:785,797)
substitutes `{track: null}` for that one announcement instead, and sets
`_heldVideo` so the substitution is remembered as a debt, not just a courtesy
null. `_releaseHeldVideo` (media.js:762) pays that debt with whatever is
actually in `stream` by the time the triggering build reaches a final state
(commit, cancel, or failure) — every such path is required to call it, or a
remote peer would stay pinned to camera-off forever despite a live track being
sent nowhere. The join-time case added by finding F1 (`app.js`'s initial
publish skipping the camera while `media.backgroundPending` is true, gated
through a new `Media.backgroundPending` getter) is the same protocol applied to
one more caller: the lobby's saved-background restore is deliberately
unawaited (see [Persistence](#persistence)), so a fast Join click can otherwise
land before the composite exists.

**`_swapTrack` emitting `background-changed {reason: "failed"}` on a raced
device switch (`net/media.js:797`, around the `_teardownBackground({emit:
false})` call).** `_swapTrack` is the low-level track-replacement primitive
underneath `_adopt`; it can be reached by a device switch's own rebuild logic
losing a race to a DIFFERENT call's rebuild that commits first. When that
happens the first call's bookkeeping (`_bgEffect`) is stale: it still names the
dropped effect while `_segmenter` is now null and the raw camera is what's
actually published. Without this emit, the picker chip keeps showing the old
effect selected — the same "chip lies" failure mode that F2/F3 fixes on the
restore path, but here from a completely different race. `_swapTrack` corrects
`_bgEffect` to `"none"` and emits the same event `setBackground`'s own failure
path emits, so the picker's existing listener repaints the chip and shows the
same notice a build failure would.

**Watchdog verdicts suppressed while `document.hidden`, all three clocks
re-armed on wake (`lib/segmenter.js`).** This refines rather than contradicts
the [Accepted regression: backgrounded tabs](#accepted-regression-backgrounded-tabs)
section above. That section is still accurate about frames freezing in a
hidden tab; what it does not anticipate is what the watchdog should conclude
from a frozen frame rate. `rAF`/`rVFC` stalling in the background would read,
to `fpsGuard`, as the device failing to keep up — and trip a revert the user
never asked for and would not observe until switching back to a tab that has
silently lost its effect. `segmenter.js` checks `document.hidden` before
acting on a guard verdict (segmenter.js:495, inside `_tickGuard`) and, on `visibilitychange`
waking back up, re-arms all three clocks the guard's trip decision depends on
together — the guard's own `push()`-driven window, the "zero frames ever"
wall-clock fallback, and the first-frame timestamp — so a genuinely struggling
device still gets a fair, freshly-timed trial after the tab regains focus
rather than being judged on stale pre-hidden timings (segmenter.js:167-171).

**ETag/304 revalidation on gzip-served assets (`internal/server/static.go`,
`serveEmbeddedGzip`).** `embed.FS` reports a zero modtime for every file, which
defeats the timestamp-based conditional-GET machinery `http.ServeContent`
otherwise gets for free (see the file-level comment at static.go:20-23) — every
load would re-fetch the ~3.4 MB runtime with no way for the browser to ask "has
this changed?". `serveEmbeddedGzip` sets an explicit `ETag` derived from
`assetsVersion` (itself a content hash of the whole embedded asset set, so it
changes exactly when the bytes do) and answers a matching `If-None-Match` with
a bare 304. This is what makes the "immutable" caching story in
[Pre-compressed serving](#pre-compressed-serving) actually work for the
MediaPipe assets specifically, rather than only for version-stamped URLs.

## Risks

- **Binary grows ~20%** (~18.7 MB to ~22.4 MB). Accepted; the noise-suppression
  worklet already set the vendored-blob precedent at 1.9 MB. Note this figure
  depends on the gzip-serving work landing — without it the same feature costs
  +65%.
- **Output quality depends on a model, not on code we control.** This is the
  first such feature in the app. If MediaPipe's segmenter does poorly in a given
  user's lighting, that is tuning, not a fixable bug.
- **CPU cost on low-end devices.** Mitigated by the watchdog rather than by
  refusing the feature to mobile users, some of whom have hardware that handles
  it comfortably.
