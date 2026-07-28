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
    this._maskImage = null; // the ImageData backing _maskCanvas; can hold multiple MB
    this._painted = null; // cached procedural background, repainted only on resize
    this._paintedFor = null; // the effect id _painted holds, so a switch repaints
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
    // I3: stop() is sticky by design (a load that finishes after cancellation
    // must not resurrect a torn-down instance), but that also makes a
    // *finished* stop() permanent unless cleared here — and
    // none -> blur -> none -> blur is the expected user flow, not an edge case.
    this._stopped = false;
    this._bailed = false;
    this._effect = effectById(effectId);

    try {
      const { vision, fileset } = await loadVision();
      if (this._stopped) return null; // stopped while the runtime was loading

      // C1: assign to a local first. this._segmenter must stay null until we
      // know stop() didn't land during this await — otherwise a stop() that
      // fires mid-load finds this._segmenter still null (its teardown becomes
      // a no-op), and the segmenter that resolves a moment later is leaked:
      // live WASM heap plus a WebGL context that nothing ever closes.
      const segmenter = await vision.ImageSegmenter.createFromOptions(fileset, {
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
      if (this._stopped) {
        try {
          segmenter.close();
        } catch {
          /* already closed */
        }
        return null;
      }
      this._segmenter = segmenter;

      await this._startVideo(rawTrack);
      if (this._stopped) return null;

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
      this.stop();
      throw err;
    }
  }

  // Switch effect without rebuilding the model — the expensive part stays warm.
  // The guard re-arms, so a device that choked on a virtual background still gets
  // a fair try at a cheap blur.
  setEffect(effectId) {
    this._effect = effectById(effectId);
    this._painted = null;
    this._paintedFor = null;
    this._guard.reset();
    this._bailed = false; // a fresh effect deserves a fresh chance to bail (or not)
  }

  // Idempotent teardown. Stops the composited track (not the raw one — the caller
  // owns that), cancels both loops, and releases the model.
  stop() {
    this._stopped = true;
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
      this._renderFrame();
      // I1: push() (and the "we have ever rendered" marker below) stay gated
      // behind a successful render on purpose — a throw means nothing was
      // actually composited to the output canvas, and counting it as a
      // delivered frame would be dishonest telemetry. A PERSISTENT failure
      // (throws on every call, so this line never runs) is instead caught by
      // the wall-clock fallback in _tickGuard, which does not depend on
      // push() ever having been called.
      const now = performance.now();
      this._guard.push(now);
      if (this._firstFrameAt === null) this._firstFrameAt = now;
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
      this.onBail();
      return;
    }
    if (this._guard.check(performance.now())) {
      this._bailed = true;
      console.warn("segmenter: frame rate too low, dropping the background effect");
      // Report only; media.js owns the tracks and performs the revert.
      this.onBail();
    }
  }
}
