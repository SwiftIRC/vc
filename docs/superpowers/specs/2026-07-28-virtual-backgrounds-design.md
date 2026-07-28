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
renegotiation, no signaling message, and no change to any Go production file
(`//go:embed all:assets` picks up the new asset directory on its own). The only
Go edits are the additive tests below.

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
larger binary. While the ~3.3 MB is loading, the chosen chip shows a pending
state and the picker is disabled, mirroring how the noise-suppression button
handles its ~2 MB worklet load.

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
@mediapipe/tasks-vision`:

- `vision_bundle.mjs` — the ESM entry point
- `vision_wasm_internal.js` / `.wasm` — SIMD build
- `vision_wasm_nosimd_internal.js` / `.wasm` — fallback build
- `selfie_segmenter.tflite` — the model

Roughly 3.3 MB total, taking the binary from ~18.7 MB to ~22 MB (about 18%).

No `static.go` change is needed: `//go:embed all:assets` already covers new
subdirectories, and `http.ServeContent` returns `application/wasm` for `.wasm`
(verified), so streaming compilation works. `.tflite` has no registered MIME type
and is sniffed as `application/octet-stream`, which is correct — MediaPipe
fetches it as an `ArrayBuffer`.

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
- `internal/server/static_test.go` — assert `.wasm` is served with
  `Content-Type: application/wasm`.

**Manual, on-device — reported as pending, not claimed as verified:**

Segmentation quality (hair edges, low light, glasses), and the mobile thermal
behaviour the watchdog exists to catch, cannot be verified from the test suite.
A MANUAL-TEST.md section covers both, following the precedent set by the iOS call
sounds work.

## Risks

- **Binary grows ~18%.** Accepted; the noise-suppression worklet already set this
  precedent at 1.9 MB.
- **Output quality depends on a model, not on code we control.** This is the
  first such feature in the app. If MediaPipe's segmenter does poorly in a given
  user's lighting, that is tuning, not a fixable bug.
- **CPU cost on low-end devices.** Mitigated by the watchdog rather than by
  refusing the feature to mobile users, some of whom have hardware that handles
  it comfortably.
