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
import { effectById, drawImageBackground } from "./backgrounds.js";
import { loadBackgroundImage } from "./backgroundImages.js";

const VENDOR_BASE = "/vendor/mediapipe";
const MODEL_PATH = `${VENDOR_BASE}/selfie_segmenter.tflite`;
const OUTPUT_FPS = 24;
// How often the watchdog renders a verdict. Frame-driven checks alone cannot
// catch a total stall, because a stalled compositor stops calling push().
const GUARD_TICK_MS = 1000;

// How many consecutive frames may throw before we conclude the pipeline is dead
// rather than hiccupping. At ~24fps this is well under a second of bad frames.
const MAX_CONSECUTIVE_FRAME_ERRORS = 30;

// Can this page actually get a WebGL context right now?
//
// This exists because MediaPipe will NOT tell us. Emscripten's GL.createContext
// returns the handle 0 when getContext() yields null, and makeContextCurrent(0)
// returns `!(contextHandle && !GLctx)` — which is `true` for handle 0. A failed
// acquisition is therefore reported as SUCCESS with the module-global GLctx left
// undefined, so createFromOptions({delegate:"GPU"}) resolves and the failure only
// appears as a per-frame TypeError deep inside the WASM. Asking the browser
// directly is the only way to choose the delegate honestly.
//
// The probe context is explicitly released: browsers cap live WebGL contexts
// (~16 in Chrome), and silently consuming one per pipeline build to answer a
// yes/no question would be its own bug.
//
// `createCanvas` is injectable so this can be unit tested without a DOM.
export function webglAvailable(createCanvas = () => document.createElement("canvas")) {
  try {
    const canvas = createCanvas();
    const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
    if (!gl) return false;
    // Best-effort release; absent on some implementations, and harmless if so.
    const lose = gl.getExtension && gl.getExtension("WEBGL_lose_context");
    if (lose) lose.loseContext();
    return true;
  } catch {
    // getContext can throw outright where WebGL is disabled by policy.
    return false;
  }
}

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
    this._maskImage = null; // the ImageData backing _maskCanvas; can hold multiple MB
    this._painted = null; // cached procedural background, repainted only on resize
    this._paintedFor = null; // the effect id _painted holds, so a switch repaints
    // src -> decoded ImageBitmap for the "image" effects. Populated by _warmImage;
    // absent until a decode lands, which is exactly when _drawBackground falls back
    // to the effect's colour. Not a cache — backgroundImages.js owns that — just the
    // resolved handles, so the frame loop never touches a promise.
    this._bitmaps = new Map();
    this._stream = null;
    this._track = null;
    this._cancelFrame = null; // cancels the pending rVFC/rAF callback
    this._guard = new FpsGuard();
    this._guardTimer = null;
    this._metadataTimer = null; // the 10s "camera never delivered metadata" timeout
    this._metadataSettle = null; // lets stop() unblock a pending metadata wait cleanly
    this._onVisibilityChange = null;
    this._pipelineStartedAt = null; // wall clock for the "zero frames ever" fallback
    this._firstFrameAt = null;
    this._bailed = false; // latches onBail() to at most one call per armed guard
    this._frameErrors = 0; // consecutive throwing frames; reset by any good frame
    this._stopped = false;
    this._generation = 0; // bumped by start() and stop(); see the comment in start()
  }

  get track() {
    return this._track;
  }

  // Bring the pipeline up on `rawTrack` and resolve with the composited track.
  // Rejects if the model or the first camera frame cannot be obtained, leaving
  // nothing running — the caller keeps publishing the raw track.
  async start(rawTrack, effectId) {
    if (!rawTrack) throw new Error("no camera track to process");
    // NEW-1: an epoch, not a boolean, for the resume checkpoints below. A
    // checkpoint captured by an in-flight start() needs to know whether THIS
    // call was invalidated — by its own stop(), or by a newer start()
    // superseding it — not just whether the instance is *currently* stopped.
    // A boolean can't express that: this call resetting _stopped = false
    // (see I3, below) would make an EARLIER, still-suspended start() read
    // "not stopped" and resurrect after its own stop() had already torn it
    // down. stop() also bumps this (see stop()), so a plain
    // start()-then-stop() with no restart is still caught even though
    // _generation doesn't change again after that.
    this._generation += 1;
    const gen = this._generation;
    // I3: stop() is sticky by design (a load that finishes after cancellation
    // must not resurrect a torn-down instance), but that also makes a
    // *finished* stop() permanent unless cleared here — and
    // none -> blur -> none -> blur is the expected user flow, not an edge case.
    this._stopped = false;
    this._bailed = false;
    this._effect = effectById(effectId);

    // WebGL is a hard precondition, not a preference. MediaPipe's vision
    // GraphRunner is GL-based no matter what `delegate` says — `delegate` only
    // selects where TFLite INFERENCE runs. On a browser with no WebGL the graph
    // still reports "Graph successfully started running" and then throws
    // "Cannot read properties of undefined (reading 'activeTexture')" from
    // glActiveTexture on every single frame, on CPU and GPU alike. Observed in
    // production alongside MediaPipe's own "Couldn't create webGL 1 context".
    //
    // Checking first is the only honest option, because MediaPipe will not tell
    // us: emscripten's GL.createContext returns handle 0 when getContext()
    // yields null, and makeContextCurrent(0) returns `!(contextHandle && !GLctx)`
    // — `true` for handle 0 — so a FAILED acquisition is reported as SUCCESS
    // with the module-global GLctx left undefined. createFromOptions resolves,
    // and nothing rejects for a .catch() to catch.
    if (!webglAvailable()) {
      const err = new Error("background effects need WebGL, which this browser cannot provide");
      err.code = "no-webgl"; // media.js maps this to the "unsupported" notice
      throw err;
    }

    // Only warm the image decode once WebGL is confirmed present: this call is
    // about to throw and abandon the pipeline build on a browser without it, and
    // starting a fetch/decode it is about to abandon would waste both.
    this._warmImage(this._effect);

    try {
      const { vision, fileset } = await loadVision();
      if (gen !== this._generation) return null; // superseded while the runtime was loading

      // C1: assign to a local first. this._segmenter must stay null until we
      // know this start() wasn't superseded during this await — otherwise a
      // stop() (or a newer start()) that lands mid-load finds this._segmenter
      // still null (its teardown becomes a no-op), and the segmenter that
      // resolves a moment later is leaked: live WASM heap plus a WebGL
      // context that nothing ever closes.
      const segmenter = await vision.ImageSegmenter.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: MODEL_PATH,
          // GPU keeps the TFLite inference off the main thread's CPU budget.
          // Note this only selects where INFERENCE runs — see the WebGL
          // precondition above; the graph itself is GL-based either way.
          delegate: "GPU",
        },
        runningMode: "VIDEO",
        // A CONFIDENCE mask, not a category mask: the soft probability edge is what
        // keeps hair and shoulders from looking die-cut.
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      }).catch(async (err) => {
        // A GPU that passed the WebGL precondition can still fail to initialise
        // TFLite's GPU delegate. Inference falls back to CPU; the graph keeps
        // using the WebGL context we already confirmed exists.
        console.warn("segmenter: GPU inference delegate failed, running inference on the CPU", err);
        return vision.ImageSegmenter.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_PATH, delegate: "CPU" },
          runningMode: "VIDEO",
          outputConfidenceMasks: true,
          outputCategoryMask: false,
        });
      });
      if (gen !== this._generation) {
        try {
          segmenter.close();
        } catch {
          /* already closed */
        }
        return null;
      }
      this._segmenter = segmenter;

      await this._startVideo(rawTrack);
      if (gen !== this._generation) return null;

      this._buildCanvases();
      this._stream = this._out.captureStream(OUTPUT_FPS);
      this._track = this._stream.getVideoTracks()[0] || null;
      if (!this._track) throw new Error("compositor produced no video track");

      this._guard.reset();
      // I1: the wall clock backing the "no frame ever rendered" fallback in
      // _tickGuard — independent of the guard's own push()-driven clock, which
      // never starts if push() is never reached at all.
      this._pipelineStartedAt = performance.now();
      this._firstFrameAt = null;
      // I2: a hidden tab starves rVFC/rAF, not the effect. Re-arm on wake so
      // the post-wakeup ramp is judged against a fresh window, not one the
      // hidden period emptied out.
      this._onVisibilityChange = () => {
        if (document.hidden) return;
        this._guard.reset();
        this._pipelineStartedAt = performance.now();
        this._firstFrameAt = null;
      };
      document.addEventListener("visibilitychange", this._onVisibilityChange);
      this._guardTimer = setInterval(() => this._tickGuard(), GUARD_TICK_MS);
      this._scheduleFrame();
      return this._track;
    } catch (err) {
      // C2: leave nothing running on a failed start, per this method's own
      // contract. Without this, the two reachable rejections (the metadata
      // timeout, and "compositor produced no video track") left a live
      // segmenter and a hidden <video> decoding camera frames forever.
      //
      // R1: but only tear down if THIS start() is still the current one. A
      // superseded run (stopped, or replaced by a newer start() that is
      // already up and running) must not call stop() on its successor just
      // because its own, now-irrelevant, promise chain finally rejects — the
      // caller still needs to learn that ITS call to start() failed, so this
      // still rethrows either way.
      if (gen === this._generation) this.stop();
      throw err;
    }
  }

  // Switch effect without rebuilding the model — the expensive part stays warm.
  // The guard re-arms, so a device that choked on a virtual background still gets
  // a fair try at a cheap blur.
  setEffect(effectId) {
    this._effect = effectById(effectId);
    this._warmImage(this._effect);
    this._painted = null;
    this._paintedFor = null;
    this._bailed = false; // a fresh effect deserves a fresh chance to bail (or not)
    // NEW-2/R2: re-arm all three of the guard's clocks together, deliberately
    // identical to the visibility-wake path in start()'s _onVisibilityChange.
    // Resetting only _guard and _pipelineStartedAt (leaving a stale non-null
    // _firstFrameAt from the PREVIOUS effect) routed _tickGuard into the
    // _guard.check() branch instead of the wall-clock branch — and
    // _guard.check() can never fire on a guard that was just reset (its
    // _start stays null until a push() arrives), so a newly-picked effect
    // that never composites a single frame could never be bailed on at all.
    // Clearing _firstFrameAt too sends it back through the wall-clock branch
    // instead, which does not depend on push() ever having been called.
    this._guard.reset();
    this._pipelineStartedAt = performance.now();
    this._firstFrameAt = null;
  }

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

  // Idempotent teardown. Stops the composited track (not the raw one — the caller
  // owns that), cancels both loops, and releases the model.
  stop() {
    this._stopped = true;
    // NEW-1: bump the epoch so any start() still awaiting a checkpoint knows
    // it is stale even if no later start() ever runs. See the generation
    // comment at the top of start().
    this._generation += 1;
    if (this._cancelFrame) {
      this._cancelFrame();
      this._cancelFrame = null;
    }
    if (this._guardTimer) {
      clearInterval(this._guardTimer);
      this._guardTimer = null;
    }
    // I4: unblock a pending metadata wait immediately with a clean resolve,
    // rather than leaving the 10s timeout to reject long after the caller
    // already cancelled — that would surface as a spurious error even though
    // nothing actually went wrong.
    if (this._metadataSettle) {
      this._metadataSettle();
    }
    if (this._onVisibilityChange) {
      document.removeEventListener("visibilitychange", this._onVisibilityChange);
      this._onVisibilityChange = null;
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
    this._maskCanvas = this._maskCtx = this._maskImage = this._painted = null;
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
      const cleanup = () => {
        video.removeEventListener("loadedmetadata", onMetadata);
        if (this._metadataTimer) {
          clearTimeout(this._metadataTimer);
          this._metadataTimer = null;
        }
        this._metadataSettle = null;
      };
      const onMetadata = () => {
        cleanup();
        resolve();
      };
      // A camera that never delivers metadata would hang start() forever.
      this._metadataTimer = setTimeout(() => {
        cleanup();
        reject(new Error("camera frame timed out"));
      }, 10000);
      // I4: stop() calls this to unblock the wait immediately with a clean
      // resolve instead of leaving the timer above to reject spuriously after
      // the caller has already cancelled. See stop().
      this._metadataSettle = () => {
        cleanup();
        resolve();
      };
      video.addEventListener("loadedmetadata", onMetadata, { once: true });
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
  }

  _onFrame() {
    if (this._stopped) return;
    try {
      // I1/NEW-3: push() (and the "we have ever rendered" marker below) stay
      // gated behind an ACTUAL composite on purpose — a throw, a missing
      // video/segmenter/videoWidth, or an empty mask result all mean nothing
      // was drawn to the output canvas, and counting any of them as a
      // delivered frame would be dishonest telemetry that reports a
      // never-painted canvas as healthy. A PERSISTENT failure to composite
      // (every call takes one of these no-draw paths) is instead caught by
      // the wall-clock fallback in _tickGuard, which does not depend on
      // push() ever having been called.
      if (this._renderFrame()) {
        const now = performance.now();
        this._guard.push(now);
        if (this._firstFrameAt === null) this._firstFrameAt = now;
        this._frameErrors = 0; // a good frame clears a run of bad ones
      }
    } catch (err) {
      // Log ONCE per run of failures. A dead GL context throws on every frame,
      // and logging each one buries the actual first error under thousands of
      // identical lines.
      if (this._frameErrors === 0) console.error("segmenter: frame failed", err);
      this._frameErrors += 1;
      if (this._frameErrors >= MAX_CONSECUTIVE_FRAME_ERRORS && !this._bailed) {
        // Every frame since the last good one has thrown. This is not a slow
        // device — it is a broken pipeline. start() rules out "no WebGL at all",
        // so the usual cause here is a context that went away underneath us (a
        // lost GPU process). Bail with a reason that says so: telling the user
        // their device "couldn't keep up" would be a wrong diagnosis for a
        // machine that is not even being asked to do the work.
        console.error(`segmenter: ${this._frameErrors} consecutive frame failures, dropping the effect`);
        this._bailed = true;
        this.onBail("broken");
        return; // do not reschedule; the pipeline is being torn down
      }
    }
    this._scheduleFrame();
  }

  // Returns true only if a frame was actually composited to _out.
  _renderFrame() {
    const video = this._video;
    const seg = this._segmenter;
    if (!video || !seg || !video.videoWidth) return false;

    // The camera can change resolution mid-call (a device switch, or a browser
    // adapting to bandwidth); follow it rather than compositing at a stale size.
    if (this._out.width !== video.videoWidth || this._out.height !== video.videoHeight) {
      this._out.width = this._scratch.width = video.videoWidth;
      this._out.height = this._scratch.height = video.videoHeight;
      this._painted = null; // the cached background is now the wrong size
    }

    let composited = false;
    seg.segmentForVideo(video, performance.now(), (result) => {
      try {
        composited = this._composite(result);
      } finally {
        // MediaPipe results hold GPU/WASM memory that is not garbage collected.
        // Leaking one per frame exhausts the heap within a minute.
        if (result && typeof result.close === "function") result.close();
      }
    });
    return composited;
  }

  // Returns true only if a frame was actually composited to _out.
  _composite(result) {
    const masks = result && result.confidenceMasks;
    if (!masks || !masks.length) return false;
    // The selfie segmenter emits person confidence LAST: a single-mask model
    // emits it alone, a two-mask model emits background then person. Taking the
    // last entry is correct for both shapes.
    const mask = masks[masks.length - 1];
    const w = this._out.width;
    const h = this._out.height;

    this._drawBackground(w, h);
    this._drawMaskedPerson(mask, w, h);
    this._outCtx.drawImage(this._scratch, 0, 0);
    return true;
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
    if (effect.kind === "image") {
      // No canvas cache here, unlike the paint branch: re-running a painter every
      // frame is waste, but drawImage from an ImageBitmap is GPU-cheap, and caching
      // it would hold a second full-size copy of every asset. Falls back to the
      // effect's colour until the decode lands (see _warmImage) — the frame is
      // always fully covered, so the raw camera never shows through.
      drawImageBackground(ctx, this._bitmaps.get(effect.src) || null, effect.fallback, w, h);
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
      // M1: blur() bleeds transparency in from outside the source rect, so
      // this filtered draw does not fully cover (0, 0, w, h) — without this
      // clear, the previous frame's pixels persist as a ghost border at the
      // edges (roughly 38px at blur-strong on 720p). The downscale fallback
      // below and the paint path already cover the rect fully and need no
      // clear.
      ctx.clearRect(0, 0, w, h);
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
    if (this._stopped || this._bailed) return;
    // I2: a hidden tab starves rVFC/rAF, so push() stops arriving — that is
    // the browser pausing the render loop, not the effect failing. Judging it
    // here would drop the effect on every tab switch. The stream freezing
    // while hidden is an accepted trade-off; only the verdict is suppressed.
    if (document.hidden) return;
    if (this._firstFrameAt === null) {
      // I1: a total stall — video.play() rejected, rVFC/rAF never fires, or
      // _renderFrame throws on every call — means push() is never reached, so
      // the guard's own clock (armed by push()) never starts and its windowed
      // check can never fire. Judge total silence against wall time instead,
      // using the same grace+window the guard would apply to a first frame,
      // so a permanently blank canvas doesn't ship to the room forever.
      const elapsed = performance.now() - this._pipelineStartedAt;
      if (elapsed < this._guard.graceMs + this._guard.windowMs) return;
      this._bailed = true;
      console.warn("segmenter: no frame ever rendered, dropping the background effect");
      // "broken", not "slow": zero frames across the whole grace+window is a
      // pipeline that never worked, not a device struggling to keep up.
      this.onBail("broken");
      return;
    }
    if (this._guard.check(performance.now())) {
      this._bailed = true;
      console.warn("segmenter: frame rate too low, dropping the background effect");
      // Report only; media.js owns the tracks and performs the revert. This is
      // the one genuinely "the device can't keep up" case.
      this.onBail("slow");
    }
  }
}
