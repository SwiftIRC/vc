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
//   "background-changed" {effectId, reverted, reason}  the background effect
//                                changed; reason is "user" (an explicit user
//                                choice), "failed" (the pipeline could not
//                                start), or "slow" (the frame-rate watchdog
//                                bailed). reverted is true for "failed"/"slow"
//                                — it is the persist/don't-persist signal;
//                                reason exists so the UI can show why

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
    // setBackground, useDevices, and disableCamera can all interleave across the
    // multi-second MediaPipe load inside a build, and nothing about a Promise
    // stops that. _bgGeneration is the guard: setBackground bumps it before any
    // await, and a build only commits if its captured generation still matches
    // when it resumes — otherwise it quietly discards itself. This mirrors the
    // epoch counter already inside BackgroundSegmenter itself (segmenter.js's
    // own `_generation`), one level up.
    this._bgGeneration = 0;
    this._bgPending = null; // the segmenter currently mid-build (pre-commit), or
    // null when idle. Exists so setBackground("none") can cancel an in-flight
    // build instead of no-op'ing — _bgEffect alone can't tell "at rest" from
    // "mid-build", since it only updates on commit.
    this._heldVideo = false; // a video camera-track announcement was withheld
    // (holdVideo) on the assumption a real one would follow shortly. MUST be
    // released — with whatever is actually in `stream` — on every path that is
    // the final word for the build that set it, or remote peers are pinned to
    // {track:null} forever even though a live device track is being sent
    // nowhere. See _releaseHeldVideo.
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
      // Tear down quietly and announce camera-off ourselves. The natural raw
      // announcement (from this teardown, or from the device swap below) would
      // show remote peers the very room this effect exists to hide, for as long
      // as device acquisition and the model reload take (I6) — briefly showing
      // nothing is strictly better than briefly showing the room.
      //
      // This IS a withheld announcement (not just a courtesy null), and MUST be
      // marked as such: if getUserMedia fails below, nothing else will ever
      // correct it (H2) — _releaseHeldVideo in the catch block is what does.
      this._teardownBackground({ emit: false });
      this._bgEffect = "none";
      this._heldVideo = true;
      this.dispatchEvent(new CustomEvent("camera-track", { detail: { track: null } }));
    }
    const wasMuted = rebuildNs && this._processedTrack ? !this._processedTrack.enabled : false;
    let fresh;
    try {
      fresh = await this._getUserMedia(constraints);
    } catch (error) {
      // I4: a failed device switch must not silently drop the effect with no
      // event — without this the picker keeps showing the old chip selected
      // while the room is, in fact, unblurred (or off, per the emit above).
      // H2: and the withheld camera-track above must be released with the OLD
      // raw device (still live, folded back into `stream` by the teardown
      // above) — without this, remote peers are pinned to {track:null} forever
      // even though a live camera is being sent nowhere.
      if (rebuildBg) {
        this._releaseHeldVideo();
        this._emitBackground("none", "failed");
      }
      throw error;
    }
    // _adopt swaps the raw device tracks and emits camera-track; it emits mic-track too
    // UNLESS NS is on, in which case _swapTrack stays silent and we publish the freshly
    // processed track below (the raw device track must never be the published one).
    // holdVideo withholds THIS raw announcement too, for the same I6 reason as above:
    // the effect is about to be rebuilt on the new device a moment later.
    this._adopt(fresh, { holdVideo: rebuildBg });
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
  // A background effect chosen while the camera was off is applied here. Remote
  // peers see camera-off, not the raw room, until the rebuilt composite is ready
  // (holdVideo, I6) — the raw camera is never announced to them at all in that case.
  async enableCamera(deviceId = this._cameraId) {
    if (this.cameraTrack) return this.cameraTrack;
    const video = deviceId ? { deviceId: { exact: deviceId } } : true;
    const fresh = await this._getUserMedia({ video });
    const pendingEffect = this._bgEffect !== "none";
    this._adopt(fresh, { holdVideo: pendingEffect }); // swaps the new video track into `stream`
    if (pendingEffect) {
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

  // True while a background build is in flight. Callers that are about to PUBLISH
  // the camera use this to hold off: during a build `cameraTrack` is still the raw
  // device track, and publishing it would show remote peers the very room the user
  // turned an effect on to hide.
  get backgroundPending() {
    return this._bgPending !== null;
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
  //
  // setBackground/useDevices/disableCamera can all interleave across the
  // multi-second MediaPipe load a build goes through. _bgGeneration is bumped
  // here, before any await, and is the single mechanism that keeps that race
  // from corrupting state: a build started by an earlier call finds its
  // captured generation stale when it resumes and quietly abandons itself
  // instead of committing on top of (or being torn down by) whatever a later
  // call already did. See _buildBackground.
  async setBackground(effectId) {
    const wanted = resolveEffectId(effectId);
    // A no-op only AT REST. While a build is in flight (_bgPending), _bgEffect
    // still reads as the PRE-build value, so this guard must not swallow a
    // request that is actually asking to cancel that build (I7) — e.g. picking
    // "blur", then clicking back to "none" before the model finishes loading.
    if (wanted === this._bgEffect && !this._bgPending) return this._bgEffect;

    const gen = ++this._bgGeneration; // supersede/cancel anything already in flight

    if (!this.cameraTrack && !this._rawCameraTrack) {
      this._bgEffect = wanted; // remembered; enableCamera applies it
      this._emitBackground(wanted, "user");
      return wanted;
    }

    if (wanted === "none") {
      this._teardownBackground();
      this._bgEffect = "none";
      // H1/H5: cancelling to "none" can be the FINAL word for a build that
      // started under a hold (I7 makes this reachable — cancelling a pending
      // rebuild before it ever commits a segmenter, so _teardownBackground
      // above is a no-op and emits nothing itself). Release it now or remote
      // peers are pinned to the {track:null} substitute forever.
      this._releaseHeldVideo();
      this._emitBackground("none", "user");
      return "none";
    }

    // Already running: swap the effect without rebuilding the model.
    if (this._segmenter) {
      this._segmenter.setEffect(wanted);
      this._bgEffect = wanted;
      this._emitBackground(wanted, "user");
      return wanted;
    }

    try {
      const committed = await this._buildBackground(wanted, gen);
      // Superseded or abandoned mid-build: _buildBackground already left
      // everything untouched (or another call already reflects the truth).
      // Nothing to report — reporting here could clobber a winner's outcome.
      if (!committed) return this._bgEffect;
      this._bgEffect = wanted;
      this._emitBackground(wanted, "user");
      return wanted;
    } catch (error) {
      if (gen !== this._bgGeneration) return this._bgEffect; // superseded; not our call to report
      // Leave the raw camera streaming — the user must never be left with a dead
      // video track because an effect failed to load.
      this._teardownBackground();
      this._bgEffect = "none";
      // H4: this build's own announcement may have been withheld by a caller
      // (see enableCamera/useDevices' `holdVideo`) on the assumption the
      // composite would replace it a moment later. It didn't: release the hold
      // now so remote peers learn about the raw track, rather than being stuck
      // on the {track:null} substitute forever. A no-op when nothing was held.
      this._releaseHeldVideo();
      this._emitError(error, "background");
      this._emitBackground("none", "failed");
      return "none";
    }
  }

  // Build the pipeline on the current device track and swap the composited track
  // into `stream`. Resolves `true` on a real commit; `false` if the attempt was
  // abandoned WITHOUT touching `stream`/`_segmenter`/`_rawCameraTrack` — either
  // superseded by a newer setBackground() call, or the device track died mid-load
  // (disableCamera, a device switch, or stop() all stop tracks without bumping
  // `_bgGeneration`; the readyState check below catches those). Throws, with
  // nothing committed, only on a genuine pipeline failure.
  async _buildBackground(effectId, gen) {
    const raw = this._rawCameraTrack || this.cameraTrack;
    if (!raw) throw new Error("no camera to process");

    const segmenter = new BackgroundSegmenter({ onBail: () => this._onBackgroundBail(segmenter) });
    this._bgPending = segmenter; // a build is now in flight; see setBackground's no-op guard
    let processed;
    try {
      processed = await segmenter.start(raw, effectId);
    } finally {
      // Only clear if we're still the current pending build: a newer build may
      // have already overwritten this with its OWN segmenter while we were
      // still awaiting (see setBackground), and that marker is not ours to touch.
      if (this._bgPending === segmenter) this._bgPending = null;
    }

    // Superseded while we were awaiting — a newer setBackground() call already
    // owns (or is about to own) `stream`/`_segmenter`/`_rawCameraTrack`.
    // Touching any of them here would clobber whatever it already did.
    if (gen !== this._bgGeneration) {
      segmenter.stop();
      return false;
    }
    // The device this pipeline was built on may have been stopped while we
    // waited (C3): disableCamera(), a device switch's _swapTrack, and stop()'s
    // full-stream teardown all stop tracks without touching _bgGeneration.
    // Committing on a dead device would resurrect an effect the user already
    // turned off and republish a stale frame to remote peers.
    if (raw.readyState !== "live") {
      segmenter.stop();
      return false;
    }
    if (!processed) {
      segmenter.stop();
      throw new Error("background pipeline produced no track");
    }

    this._segmenter = segmenter;
    this._rawCameraTrack = raw;
    // Mirror the noise-suppression graph: capture the pre-existing mute state
    // for the published track, THEN force the raw device track fully enabled
    // so the compositor is never starved — a soft-muted camera must not starve
    // the segmenter, or a later unmute would still publish nothing.
    processed.enabled = raw.enabled;
    raw.enabled = true;
    // Swap directly rather than via _swapTrack: that helper STOPS the outgoing
    // track, which here is the raw device feeding the pipeline.
    const current = this.stream.getVideoTracks()[0] || null;
    if (current && current !== processed) this.stream.removeTrack(current);
    this.stream.addTrack(processed);
    // This IS the release of any hold this build started under: a real
    // announcement just fired, so there is nothing left to correct later.
    this._heldVideo = false;
    this.dispatchEvent(new CustomEvent("camera-track", { detail: { track: processed } }));
    return true;
  }

  // Tear the pipeline down and put the raw device track back in `stream`. Safe to
  // call when no effect is running. Emits "camera-track" only when the published
  // track actually changed, unless `emit` is false. `{emit:false}` is for callers
  // that perform this same teardown quietly and issue their own event for
  // whatever replaces it — see _swapTrack (C1) and useDevices (I6).
  _teardownBackground({ emit = true } = {}) {
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
      if (emit) this.dispatchEvent(new CustomEvent("camera-track", { detail: { track: raw } }));
    } else {
      // The device went away while the effect was running (unplugged, or a
      // disableCamera race). Report camera-off rather than a dead track.
      if (emit) this.dispatchEvent(new CustomEvent("camera-track", { detail: { track: null } }));
    }
  }

  // The frame-rate watchdog gave up. Revert to the raw camera and tell the UI it
  // was automatic, so the picker can show a notice AND — importantly — not
  // persist "none" as though the user had chosen it. `segmenter` identifies WHICH
  // pipeline bailed (C2): a build that lost the generation race can still be
  // running its own watchdog after losing, and its bail must not tear down
  // whatever pipeline actually won — only the CURRENT `_segmenter` may act.
  _onBackgroundBail(segmenter) {
    if (segmenter !== this._segmenter) return; // an orphaned/superseded build; not the live one
    this._teardownBackground();
    this._bgEffect = "none";
    this._emitBackground("none", "slow");
  }

  // reason is "user" (an explicit user choice), "failed" (the pipeline could not
  // start), or "slow" (the watchdog bailed). reverted, derived from it, is the
  // persist/don't-persist signal Task 8 reads; reason exists so the picker can
  // show why. Note for Task 8: an effect chosen while the camera is off emits
  // this event TWICE — once recording the choice (setBackground's no-camera
  // branch), once when enableCamera actually applies it. Both carry reason
  // "user" and the same effectId; harmless, but don't be surprised by it.
  _emitBackground(effectId, reason) {
    const reverted = reason !== "user";
    this.dispatchEvent(new CustomEvent("background-changed", { detail: { effectId, reverted, reason } }));
  }

  // Release a video announcement withheld by `holdVideo` (I6), announcing
  // whatever is ACTUALLY in `stream` right now — the composite, the raw
  // device, or null. A no-op when nothing is currently held.
  //
  // This must be called from every path that is the FINAL WORD for a build
  // that started under a hold: a genuine pipeline failure (H4), and cancelling
  // back to "none" (H1/H5, in setBackground and useDevices respectively). A
  // successful commit releases inline (see _buildBackground) rather than
  // through here, since its own "here's the composite" emit already IS the
  // release. Deliberately NOT called when a build is merely SUPERSEDED by
  // ANOTHER effect build (H3) or abandoned because its device died — in both
  // cases a different in-flight (or already-fired) call is the new final word
  // and will release the hold itself; calling this there would emit a spurious
  // intermediate announcement moments before the real one.
  _releaseHeldVideo() {
    if (!this._heldVideo) return;
    this._heldVideo = false;
    this.dispatchEvent(new CustomEvent("camera-track", { detail: { track: this.cameraTrack } }));
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
  // switch); untouched kinds are left streaming. `holdVideo` withholds the raw
  // video track's "camera-track" announcement (substituting {track:null}) when a
  // background rebuild is about to replace it a moment later — see enableCamera,
  // useDevices, and I6.
  _adopt(fresh, { holdVideo = false } = {}) {
    if (!this.stream) this.stream = new MediaStream();
    const video = fresh.getVideoTracks()[0] || null;
    const audio = fresh.getAudioTracks()[0] || null;
    if (video) this._swapTrack("video", video, { holdVideo });
    if (audio) this._swapTrack("audio", audio);
  }

  // Replace the current `kind` ("video"/"audio") track in `stream` with `next`,
  // preserving the old track's mute (enabled) state, stopping and removing the
  // old track so its device is freed, and emitting the matching change event.
  // `holdVideo` (video only) emits {track:null} instead of `next` — see _adopt.
  _swapTrack(kind, next, { holdVideo = false } = {}) {
    const isVideo = kind === "video";
    // A background effect keeps the true device track PARKED outside `stream`
    // (see the constructor comment) while the COMPOSITED track sits in `stream`
    // as `prev`. Swapping `prev` for `next` below, on its own, would silently
    // ORPHAN the parked track: still live, still capturing, with nothing left
    // holding a reference to stop it — two cameras "on", only one of them
    // visible anywhere, and a later disableCamera() would stop the wrong one
    // (C1). Tearing the pipeline down first — quietly, since this method emits
    // its own event below — folds the parked track back into `stream` as
    // `prev`, so the ordinary swap logic beneath stops it like any other
    // replaced track. No effect running means this is a no-op.
    if (isVideo && this._segmenter) {
      this._teardownBackground({ emit: false });
      // Q: this can be the ONLY place a committed effect ever gets torn down —
      // a device switch that raced past a rebuild without itself knowing an
      // effect was active (useDevices' own top-level rebuildBg bookkeeping
      // only sees `_bgEffect` at ITS OWN call time; a DIFFERENT call's rebuild
      // can commit one after that). Without this, `_bgEffect` keeps reporting
      // the dropped effect (e.g. "blur") with `_segmenter` now null and the
      // raw camera published — the picker shows the chip selected while the
      // room is, in fact, unblurred, and nothing ever fires to correct it.
      this._bgEffect = "none";
      this._emitBackground("none", "failed");
    }
    const prev = (isVideo ? this.stream.getVideoTracks() : this.stream.getAudioTracks())[0] || null;
    if (prev === next) return;
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
    const held = isVideo && holdVideo;
    if (held) this._heldVideo = true; // must be released — see _releaseHeldVideo
    const track = held ? null : next;
    this.dispatchEvent(new CustomEvent(event, { detail: { track } }));
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
