// Browser media capture and device management. A thin, event-driven wrapper
// over getUserMedia / getDisplayMedia / enumerateDevices.
//
// Responsibilities: acquire the local camera+mic stream, list and switch input
// devices (releasing the replaced hardware), toggle the local mic/camera on and
// off, and start/stop a screen-share stream. The camera+mic tracks live in one
// long-lived MediaStream (`stream`) that callers can bind to a preview <video>
// once; device switches mutate that stream in place so the binding stays valid.
//
// NOT this module's job: WebRTC signaling or track "kind" tagging. peer.js
// (Task 6) owns transceivers and conveys kind via the MSID stream id; browsers
// cannot set track.id, so nothing here touches it. media.js only produces and
// manages MediaStreamTracks and announces when they change.
//
// Events (CustomEvent; detail carries the track where noted):
//   "camera-track" {track|null}  local camera track acquired / replaced / gone
//   "mic-track"    {track|null}  local mic track acquired / replaced / gone,
//                                including the raw<->noise-suppressed swap
//   "screen-start" {track}       screen share began
//   "screen-stop"  {}            screen share ended (stopScreen or browser UI)
//   "error"        {error, phase} a capture call failed; also rejected to caller
//   "background-changed" {effectId, reverted}  the background effect changed;
//                                reverted=true means the frame-rate watchdog
//                                dropped it rather than the user choosing

import { BackgroundSegmenter } from "../lib/segmenter.js";
import { resolveEffectId } from "../lib/backgrounds.js";

export class Media extends EventTarget {
  constructor() {
    super();
    this.stream = null; // owned camera+mic MediaStream (mutated in place)
    this.screenStream = null; // getDisplayMedia stream while sharing
    // True once a camera has been acquired at least once. Turning the camera OFF
    // releases the device (no track), so the UI needs a separate signal to keep the
    // camera toggle usable while off — this is it.
    this.cameraAvailable = false;
    // deviceId of the camera currently/last in use, so re-enabling after an off
    // re-acquires the SAME camera rather than the browser's default (multi-camera
    // users would otherwise silently switch cameras on an in-call off→on).
    this._cameraId = null;

    // Noise-suppression audio graph (opt-in; see setNoiseSuppression). When on,
    // the raw mic feeds a vendored AudioWorklet and the *processed* track is what
    // gets published; the raw track stays in `stream` and keeps feeding the graph.
    this._audioCtx = null; // lazily created; closed in stop()
    this._workletReady = null; // addModule() promise, so the module loads once
    this._nsNodes = null; // { src, ns, dest } while the graph is live
    this._processedTrack = null; // dest.stream's audio track (the published one)
    this._nsOn = false;

    // Background effects (blur / virtual background). The mirror image of the
    // noise-suppression graph above, with one deliberate inversion: for audio the
    // RAW track stays in `stream` and the processed one lives beside it, but for
    // video the COMPOSITED track goes into `stream` and the raw device track is
    // parked here. That is what makes the lobby preview and the self tile show
    // the user their own effect — both bind `stream` once and never rebind.
    this._bgEffect = "none";
    this._segmenter = null;
    this._rawCameraTrack = null; // the device track, parked while an effect is on
  }

  // Current local tracks, or null when not captured / removed. Getters read the
  // live stream so they always reflect the latest device switch. While noise
  // suppression is on, micTrack is the PROCESSED track (what is published and what
  // mute/level indicators should reflect); the raw device track stays in `stream`.
  get micTrack() {
    if (this._nsOn && this._processedTrack) return this._processedTrack;
    return (this.stream && this.stream.getAudioTracks()[0]) || null;
  }

  // Whether the noise-suppression graph is currently active.
  get noiseSuppressionOn() {
    return this._nsOn;
  }

  get cameraTrack() {
    return (this.stream && this.stream.getVideoTracks()[0]) || null;
  }

  get screenTrack() {
    return (this.screenStream && this.screenStream.getVideoTracks()[0]) || null;
  }

  // The screen share's AUDIO track, or null — present only when the user opted to
  // share tab/system audio in the browser's picker (getDisplayMedia audio:true).
  get screenAudioTrack() {
    return (this.screenStream && this.screenStream.getAudioTracks()[0]) || null;
  }

  // Acquire the initial camera+mic stream with a single permission prompt. The
  // optional { cameraId, micId } prefers the last-selected devices; each is applied
  // as an `ideal` (not `exact`) deviceId, so a since-removed device falls back to the
  // browser default instead of failing the capture. Resolves with the owned stream;
  // rejects (and emits "error") on failure.
  async start({ cameraId, micId } = {}) {
    // Request the mic and camera SEPARATELY (two getUserMedia calls) rather than one
    // {audio, video} request. A combined request rejects wholesale if either device is
    // blocked or absent — so a covered/denied camera would also cost you the mic. Asking
    // separately lets the user grant one and deny the other, and keeps whichever they
    // grant. Only if BOTH fail does start() reject (and emit "error") so the lobby can
    // fall back to its join-anyway state.
    const grab = async (constraints) => {
      try {
        return await navigator.mediaDevices.getUserMedia(constraints);
      } catch {
        return null; // a denied/absent device must not block the other
      }
    };
    const micStream = await grab({ audio: micId ? { deviceId: { ideal: micId } } : true });
    if (micStream) this._adopt(micStream);
    const camStream = await grab({ video: cameraId ? { deviceId: { ideal: cameraId } } : true });
    if (camStream) this._adopt(camStream);
    if (!this.stream) {
      const err = new Error("microphone and camera are both unavailable");
      this._emitError(err, "getUserMedia");
      throw err;
    }
    return this.stream;
  }

  // List available camera/microphone inputs and audio outputs as {cameras, mics,
  // speakers} arrays of MediaDeviceInfo. Labels are only populated after permission
  // is granted, so call this after start() to get named entries.
  async enumerate() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter((d) => d.kind === "videoinput");
    const mics = devices.filter((d) => d.kind === "audioinput");
    const speakers = devices.filter((d) => d.kind === "audiooutput");
    // A camera EXISTS even if the default one failed to open (busy/in use by another
    // app). Mark it available so the camera toggle stays enabled — otherwise a failed
    // default would disable the toggle and leave the user unable to pick a working
    // camera from the list. Only "no camera hardware at all" leaves this false.
    if (cameras.length > 0) this.cameraAvailable = true;
    return { cameras, mics, speakers };
  }

  // Switch to the given camera and/or mic. Only the requested kinds are
  // re-acquired, so switching the camera does not glitch ongoing audio (and
  // vice versa). The replaced track is stopped to free the old device; the new
  // track inherits the old one's mute (enabled) state. Resolves with the stream.
  async useDevices({ cameraId, micId } = {}) {
    const constraints = {};
    // Truthy, not != null: an empty deviceId (a device with no label/id because
    // permission was never granted) would become {exact:""} and fail the whole call.
    if (cameraId) constraints.video = { deviceId: { exact: cameraId } };
    if (micId) constraints.audio = { deviceId: { exact: micId } };
    if (!constraints.video && !constraints.audio) return this.stream;
    // While NS is on the mute state lives on the PROCESSED track (micTrack), not the
    // raw device track; remember it so a mic switch keeps the same mute state.
    const rebuildNs = !!micId && this._nsOn;
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
    const wasMuted = rebuildNs && this._processedTrack ? !this._processedTrack.enabled : false;
    const fresh = await this._getUserMedia(constraints);
    // _adopt swaps the raw device tracks and emits camera-track; it emits mic-track too
    // UNLESS NS is on, in which case _swapTrack stays silent and we publish the freshly
    // processed track below (the raw device track must never be the published one).
    this._adopt(fresh);
    if (rebuildNs) {
      const raw = (this.stream && this.stream.getAudioTracks()[0]) || null;
      if (raw) {
        try {
          // The NS graph was fed by the OLD (now stopped) raw mic; rebuild it on the
          // new device and publish the new processed track.
          const processed = await this._buildNoiseGraph(raw);
          processed.enabled = !wasMuted; // carry the mute state onto the new processed track
          raw.enabled = true; // raw must always feed the graph
          this._processedTrack = processed;
          this.dispatchEvent(new CustomEvent("mic-track", { detail: { track: processed } }));
        } catch (error) {
          // Rebuild failed: fall back to the raw mic so the user is never left with a
          // dead mic, and drop NS state to match reality.
          this._teardownNoiseGraph();
          this._nsOn = false;
          this._processedTrack = null;
          raw.enabled = !wasMuted;
          this.dispatchEvent(new CustomEvent("mic-track", { detail: { track: raw } }));
          this._emitError(error, "noise-suppression");
        }
      }
    }
    if (rebuildBg) {
      // A rebuild failure leaves the raw camera published rather than a dead
      // track; setBackground already reports and degrades to "none".
      await this.setBackground(wantedBg);
    }
    return this.stream;
  }

  // Flip the local mic track between enabled (unmuted) and disabled (muted).
  // Returns the new enabled state; false when there is no mic track.
  toggleMic() {
    return this._toggle(this.micTrack);
  }

  // Set the mic to a specific muted/live state (used by push-to-talk). Returns the
  // resulting enabled state, or false when there is no mic.
  setMic(enabled) {
    const t = this.micTrack;
    if (!t) return false;
    t.enabled = !!enabled;
    return t.enabled;
  }

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

  // Begin screen sharing. Resolves with the screen video track and emits
  // "screen-start" with it. Any prior share is stopped first. The user can end
  // the share from the browser's own "Stop sharing" UI, which fires the track's
  // "ended" event; we route that through stopScreen() so state stays in sync.
  async startScreen() {
    let stream;
    try {
      // audio:true makes the browser OFFER to share tab/system audio (a checkbox in
      // its picker). If the user declines, the stream simply has no audio track, so
      // audio stays optional and this degrades gracefully where it's unsupported.
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    } catch (error) {
      this._emitError(error, "getDisplayMedia");
      throw error;
    }
    this._stopScreenStream();
    this.screenStream = stream;
    const track = this.screenTrack;
    if (track) track.addEventListener("ended", () => this.stopScreen(), { once: true });
    this.dispatchEvent(new CustomEvent("screen-start", { detail: { track, audioTrack: this.screenAudioTrack } }));
    return track;
  }

  // Share tab/system audio WITHOUT video. getDisplayMedia always needs a surface (so
  // the user still picks one and ticks "share audio"), but we immediately drop the
  // video track and keep only the audio. Emits "screen-start" with track:null. Rejects
  // if the user shared no audio (nothing to send). "screen-stop" ends it like a normal
  // share, since it reuses screenStream.
  async startScreenAudioOnly() {
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    } catch (error) {
      this._emitError(error, "getDisplayMedia");
      throw error;
    }
    for (const t of stream.getVideoTracks()) {
      t.stop();
      stream.removeTrack(t); // audio only — release the captured surface's video
    }
    const audio = stream.getAudioTracks()[0] || null;
    if (!audio) {
      for (const t of stream.getTracks()) t.stop();
      const err = new Error("no audio was shared");
      this._emitError(err, "getDisplayMedia");
      throw err;
    }
    this._stopScreenStream();
    this.screenStream = stream;
    audio.addEventListener("ended", () => this.stopScreen(), { once: true });
    this.dispatchEvent(new CustomEvent("screen-start", { detail: { track: null, audioTrack: audio } }));
    return audio;
  }

  // Stop screen sharing and emit "screen-stop". Idempotent: a redundant call
  // (e.g. the "ended" handler racing an explicit stop) is a no-op and emits
  // nothing, so downstream never sees a duplicate stop.
  stopScreen() {
    if (!this.screenStream) return;
    this._stopScreenStream();
    this.dispatchEvent(new CustomEvent("screen-stop"));
  }

  // Release all local capture (camera, mic, and any screen share) and the noise-
  // suppression audio graph. Use on teardown, e.g. when leaving the room, so no
  // device stays lit and no AudioContext/worklet is leaked.
  stop() {
    this.stopScreen();
    this._teardownBackground();
    this._bgEffect = "none";
    this._teardownNoiseGraph();
    this._nsOn = false;
    if (this._audioCtx) {
      const ctx = this._audioCtx;
      this._audioCtx = null;
      this._workletReady = null;
      ctx.close().catch(() => {}); // async; nothing to await on teardown
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
  }

  // --- noise suppression ---

  // Turn the vendored noise-suppressor AudioWorklet on or off. Returns the track
  // that should now be published for kind "mic" (the processed track when on, the
  // raw device track when off) and emits "mic-track" with it so the peer can
  // sender.replaceTrack() without renegotiation. Idempotent for the current state;
  // a no-op when there is no mic to process.
  //
  // On failure to enable (e.g. the ~2MB worklet fails to load) the raw mic is left
  // in place untouched — the user is never left with a dead mic — and the error is
  // both emitted ("error") and rejected to the caller.
  async setNoiseSuppression(on) {
    on = !!on;
    const raw = (this.stream && this.stream.getAudioTracks()[0]) || null;
    if (!raw) {
      // No mic at all: cannot process. Keep state coherent and publish nothing new.
      this._teardownNoiseGraph();
      this._nsOn = false;
      return null;
    }
    if (on === this._nsOn) return this.micTrack; // already in the requested state

    if (on) {
      let processed;
      try {
        processed = await this._buildNoiseGraph(raw);
      } catch (error) {
        // Leave the raw mic streaming; do not emit mic-track (published track is
        // unchanged). Surface the error to listeners and the caller.
        this._teardownNoiseGraph();
        this._nsOn = false;
        this._emitError(error, "noise-suppression");
        throw error;
      }
      // Mute now lives on the PROCESSED (dest) track: toggleMic/onMuted operate on
      // micTrack, which is the processed track while NS is on. Carry the current
      // mute over, then force the raw track fully enabled so it always feeds the
      // graph — otherwise a muted-at-enable raw track would starve the worklet and
      // a later unmute of the dest track would still emit silence.
      processed.enabled = raw.enabled;
      raw.enabled = true;
      this._processedTrack = processed;
      this._nsOn = true;
      this.dispatchEvent(new CustomEvent("mic-track", { detail: { track: processed } }));
      return processed;
    }

    // Turning off: carry the current mute state back onto the raw track, tear the
    // graph down (keeping the AudioContext for reuse), and republish the raw track.
    if (this._processedTrack) raw.enabled = this._processedTrack.enabled;
    this._teardownNoiseGraph();
    this._nsOn = false;
    this.dispatchEvent(new CustomEvent("mic-track", { detail: { track: raw } }));
    return raw;
  }

  // Build src -> NoiseSuppressorWorklet -> dest and return dest's audio track.
  // Reuses one AudioContext and loads the worklet module exactly once.
  async _buildNoiseGraph(rawTrack) {
    const ctx = await this._ensureAudioContext();
    await this._ensureWorkletModule(ctx);
    // Tear down any prior graph first so we never stack nodes on a re-enable.
    this._teardownNoiseGraph();
    const src = ctx.createMediaStreamSource(new MediaStream([rawTrack]));
    // Minimal construction: the vendored worklet takes no required options. If
    // future tuning params are needed they go in the 3rd AudioWorkletNode arg.
    const ns = new AudioWorkletNode(ctx, "NoiseSuppressorWorklet");
    const dest = ctx.createMediaStreamDestination();
    src.connect(ns).connect(dest);
    // Created after Join (a user gesture), so resuming a suspended context is fine.
    await ctx.resume();
    this._nsNodes = { src, ns, dest };
    const track = dest.stream.getAudioTracks()[0] || null;
    if (!track) throw new Error("noise-suppressor produced no audio track");
    return track;
  }

  async _ensureAudioContext() {
    if (this._audioCtx) return this._audioCtx;
    let ctx;
    try {
      // RNNoise-style worklets expect 48kHz. Prefer forcing it.
      ctx = new AudioContext({ sampleRate: 48000 });
    } catch (error) {
      // Some browsers reject a forced sampleRate; fall back to the default rate.
      this._emitError(error, "audiocontext-samplerate");
      ctx = new AudioContext();
    }
    if (ctx.sampleRate !== 48000) {
      // Non-fatal: report the mismatch (the worklet may still run acceptably).
      this._emitError(new Error(`AudioContext sampleRate is ${ctx.sampleRate}, expected 48000`), "audiocontext-samplerate");
    }
    this._audioCtx = ctx;
    return ctx;
  }

  // addModule() once. The stored promise both guards against a double-add and lets
  // concurrent enables await the same load; a failure clears it so a later enable
  // can retry.
  _ensureWorkletModule(ctx) {
    if (this._workletReady) return this._workletReady;
    const ready = ctx.audioWorklet.addModule("/vendor/noise-suppressor-worklet.min.js");
    this._workletReady = ready;
    ready.catch(() => {
      if (this._workletReady === ready) this._workletReady = null;
    });
    return ready;
  }

  // Disconnect and drop the graph nodes and stop the processed track. Keeps the
  // AudioContext alive (reused on the next enable); stop() closes it.
  _teardownNoiseGraph() {
    const nodes = this._nsNodes;
    this._nsNodes = null;
    if (this._processedTrack) {
      this._processedTrack.stop();
      this._processedTrack = null;
    }
    if (nodes) {
      try { nodes.src.disconnect(); } catch { /* already gone */ }
      try { nodes.ns.disconnect(); } catch { /* already gone */ }
      try { nodes.dest.disconnect(); } catch { /* already gone */ }
    }
  }

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

  // --- internals ---

  async _getUserMedia(constraints) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (error) {
      this._emitError(error, "getUserMedia");
      throw error;
    }
  }

  // Move each track of `fresh` into the owned `stream`, replacing the same-kind
  // track already present. `fresh` may carry only some kinds (a partial device
  // switch); untouched kinds are left streaming.
  _adopt(fresh) {
    if (!this.stream) this.stream = new MediaStream();
    const video = fresh.getVideoTracks()[0] || null;
    const audio = fresh.getAudioTracks()[0] || null;
    if (video) this._swapTrack("video", video);
    if (audio) this._swapTrack("audio", audio);
  }

  // Replace the current `kind` ("video"/"audio") track in `stream` with `next`,
  // preserving the old track's mute (enabled) state, stopping and removing the
  // old track so its device is freed, and emitting the matching change event.
  _swapTrack(kind, next) {
    const isVideo = kind === "video";
    const prev = (isVideo ? this.stream.getVideoTracks() : this.stream.getAudioTracks())[0] || null;
    if (prev === next) return;
    // The parked raw camera track is NOT in `stream` while an effect runs, so it
    // can never be `prev` here. The background paths swap tracks themselves for
    // exactly this reason: this helper stops whatever it replaces, which would
    // kill the device feeding the compositor.
    if (prev) {
      if (next) next.enabled = prev.enabled;
      this.stream.removeTrack(prev);
      prev.stop();
    }
    if (next) this.stream.addTrack(next);
    if (isVideo && next) {
      this.cameraAvailable = true;
      this._cameraId = next.getSettings().deviceId || this._cameraId; // remember for re-enable
    }
    // While NS is on the published audio is the PROCESSED track; a raw-device swap
    // (mic change) must not publish the raw track. useDevices rebuilds the graph and
    // emits the processed mic-track instead. (NS is off at start()/enableCamera time,
    // so this only suppresses the emit during an in-call mic switch.)
    if (!isVideo && this._nsOn) return;
    const event = isVideo ? "camera-track" : "mic-track";
    this.dispatchEvent(new CustomEvent(event, { detail: { track: next } }));
  }

  _toggle(track) {
    if (!track) return false;
    track.enabled = !track.enabled;
    return track.enabled;
  }

  _stopScreenStream() {
    if (!this.screenStream) return;
    for (const track of this.screenStream.getTracks()) track.stop();
    this.screenStream = null;
  }

  _emitError(error, phase) {
    this.dispatchEvent(new CustomEvent("error", { detail: { error, phase } }));
  }
}
