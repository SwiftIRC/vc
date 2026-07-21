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
//   "mic-track"    {track|null}  local mic track acquired / replaced / gone
//   "screen-start" {track}       screen share began
//   "screen-stop"  {}            screen share ended (stopScreen or browser UI)
//   "error"        {error, phase} a capture call failed; also rejected to caller
export class Media extends EventTarget {
  constructor() {
    super();
    this.stream = null; // owned camera+mic MediaStream (mutated in place)
    this.screenStream = null; // getDisplayMedia stream while sharing
  }

  // Current local tracks, or null when not captured / removed. Getters read the
  // live stream so they always reflect the latest device switch.
  get micTrack() {
    return (this.stream && this.stream.getAudioTracks()[0]) || null;
  }

  get cameraTrack() {
    return (this.stream && this.stream.getVideoTracks()[0]) || null;
  }

  get screenTrack() {
    return (this.screenStream && this.screenStream.getVideoTracks()[0]) || null;
  }

  // Acquire the initial camera+mic stream with a single permission prompt.
  // Resolves with the owned stream; rejects (and emits "error") on failure.
  async start() {
    const fresh = await this._getUserMedia({ audio: true, video: true });
    this._adopt(fresh);
    return this.stream;
  }

  // List available camera and microphone inputs as {cameras, mics} arrays of
  // MediaDeviceInfo. Labels are only populated after permission is granted, so
  // call this after start() to get named entries.
  async enumerate() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return {
      cameras: devices.filter((d) => d.kind === "videoinput"),
      mics: devices.filter((d) => d.kind === "audioinput"),
    };
  }

  // Switch to the given camera and/or mic. Only the requested kinds are
  // re-acquired, so switching the camera does not glitch ongoing audio (and
  // vice versa). The replaced track is stopped to free the old device; the new
  // track inherits the old one's mute (enabled) state. Resolves with the stream.
  async useDevices({ cameraId, micId } = {}) {
    const constraints = {};
    if (cameraId != null) constraints.video = { deviceId: { exact: cameraId } };
    if (micId != null) constraints.audio = { deviceId: { exact: micId } };
    if (!constraints.video && !constraints.audio) return this.stream;
    const fresh = await this._getUserMedia(constraints);
    this._adopt(fresh);
    return this.stream;
  }

  // Flip the local mic track between enabled (unmuted) and disabled (muted).
  // Returns the new enabled state; false when there is no mic track.
  toggleMic() {
    return this._toggle(this.micTrack);
  }

  // Flip the local camera track between enabled and disabled (camera off).
  // Returns the new enabled state; false when there is no camera track.
  toggleCamera() {
    return this._toggle(this.cameraTrack);
  }

  // Begin screen sharing. Resolves with the screen video track and emits
  // "screen-start" with it. Any prior share is stopped first. The user can end
  // the share from the browser's own "Stop sharing" UI, which fires the track's
  // "ended" event; we route that through stopScreen() so state stays in sync.
  async startScreen() {
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    } catch (error) {
      this._emitError(error, "getDisplayMedia");
      throw error;
    }
    this._stopScreenStream();
    this.screenStream = stream;
    const track = this.screenTrack;
    if (track) track.addEventListener("ended", () => this.stopScreen(), { once: true });
    this.dispatchEvent(new CustomEvent("screen-start", { detail: { track } }));
    return track;
  }

  // Stop screen sharing and emit "screen-stop". Idempotent: a redundant call
  // (e.g. the "ended" handler racing an explicit stop) is a no-op and emits
  // nothing, so downstream never sees a duplicate stop.
  stopScreen() {
    if (!this.screenStream) return;
    this._stopScreenStream();
    this.dispatchEvent(new CustomEvent("screen-stop"));
  }

  // Release all local capture (camera, mic, and any screen share). Use on
  // teardown, e.g. when leaving the room, so no device stays lit.
  stop() {
    this.stopScreen();
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
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
    if (prev) {
      if (next) next.enabled = prev.enabled;
      this.stream.removeTrack(prev);
      prev.stop();
    }
    if (next) this.stream.addTrack(next);
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
