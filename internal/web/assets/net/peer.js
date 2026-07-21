// Browser side of the WebRTC media plane: one RTCPeerConnection to the SFU,
// driven by perfect negotiation. The client is the POLITE peer; the SFU is
// impolite (it keeps its offer on a glare). On an inbound-offer collision this
// peer rolls its own offer back and answers, which is what makes glare converge
// (see lib/negotiation.js).
//
// No ICE servers are configured: the SFU has a public IP, so host/srflx
// candidates gathered locally are enough — there is no STUN/TURN.
//
// The client conveys each published track's KIND (mic|camera|screen) through the
// MSID *stream id* — pc.addTransceiver(track, {streamIds:[kind]}) — because
// MediaStreamTrack.id is read-only in a browser and cannot carry it. The server
// reads that stream id (remote.StreamID()) to key the forwarded track. Conversely,
// the SFU labels the tracks it forwards to us out-of-band, in a `tracks` message
// mapping each transceiver mid -> {participantId, kind}; ontrack looks the mid up
// there to tell which remote participant/kind a stream belongs to.
//
// Events (CustomEvent):
//   "remote-track" {participantId, kind, stream}  a forwarded remote track, labelled
//   "peer-gone"    {participantId, kind}           a forwarded stream ended
//   "error"        {error, phase}                  a signaling/negotiation step failed
//   "media-failed" (no detail)                     the media transport failed and one
//                                                  ICE restart did not recover it
import { handleRemoteOffer } from "../lib/negotiation.js";

// How long to let a single ICE restart try to reconnect before we give up and tell
// the user. The transport goes failed -> (restart) -> checking -> connected on a
// recovery, so this only needs to cover a fresh gather + connectivity checks.
const ICE_RESTART_GRACE_MS = 6000;

export class Peer extends EventTarget {
  constructor(signaling) {
    super();
    this.signaling = signaling;
    this.pc = new RTCPeerConnection(); // no ICE servers: public-IP SFU

    // Perfect-negotiation state. makingOffer is true only while THIS peer is
    // creating+applying its own offer, so an inbound offer that arrives in that
    // window is recognised as a glare (handleRemoteOffer) and answered politely.
    this.makingOffer = false;

    // ICE candidates that arrived before the remote description was set; applied
    // once setRemoteDescription lands (addIceCandidate rejects otherwise).
    this._pendingCandidates = [];

    // mid -> {participantId, kind} from the server's `tracks` message.
    this._trackInfo = new Map();
    // mid -> {stream, track, emitted, info} captured in ontrack; may arrive before
    // or after the labelling `tracks` message, so the two are joined by mid.
    this._incoming = new Map();
    // kind -> RTCRtpSender for locally published tracks, so unpublish can find it.
    this._senders = new Map();

    // Media-plane health. If the ICE/DTLS transport fails while the signaling
    // socket is still up (NAT rebinding, network change), the call freezes with no
    // recovery. We make exactly ONE ICE-restart attempt, then, if it doesn't heal,
    // emit "media-failed" so the app can prompt a reload. These guard against
    // looping and against emitting twice.
    this._restartedIce = false;
    this._mediaFailedEmitted = false;
    this._iceGraceTimer = null;

    // Trickle each local candidate to the SFU as it is gathered. A null candidate
    // is the end-of-gathering sentinel and carries nothing to send.
    this.pc.onicecandidate = (event) => {
      if (event.candidate) this.signaling.send("candidate", { candidate: event.candidate });
    };

    // Client-initiated renegotiation (screenshare add/remove). Adding or removing a
    // transceiver flags negotiation-needed; the browser fires this once the current
    // task settles. _makeOffer's guard collapses bursts into a single offer.
    this.pc.onnegotiationneeded = () => {
      this._makeOffer().catch((err) => this._emitError(err, "negotiation"));
    };

    this.pc.ontrack = (event) => this._onTrack(event);

    // Media-plane failure detection. connectionState is the aggregate transport
    // health (ICE + DTLS); "failed" is the terminal signal we act on. We also watch
    // iceConnectionState for browsers that surface a hard ICE "failed" there first —
    // both funnel into the same one-shot recovery path.
    this.pc.onconnectionstatechange = () => this._onConnectionStateChange();
    this.pc.oniceconnectionstatechange = () => this._onConnectionStateChange();

    // Inbound signaling. Handlers receive the decoded frame ({type, ...fields}).
    signaling.on("offer", (msg) => this._onRemoteOffer(msg).catch((err) => this._emitError(err, "offer")));
    signaling.on("answer", (msg) => this._onRemoteAnswer(msg).catch((err) => this._emitError(err, "answer")));
    signaling.on("candidate", (msg) => this._onRemoteCandidate(msg).catch((err) => this._emitError(err, "candidate")));
    signaling.on("tracks", (msg) => this._onTracks(msg));
  }

  // Add the initial local tracks and send the first offer. localTracks is an
  // iterable of {track, kind}. The client must offer to establish the PC — the SFU
  // only answers — so this is what brings the connection up.
  async start(localTracks = []) {
    for (const { track, kind } of localTracks) this._addLocal(track, kind);
    await this._makeOffer();
  }

  // Publish a track mid-call (e.g. a screenshare). Adding the transceiver fires
  // onnegotiationneeded, which renegotiates via _makeOffer. If that offer glares
  // with a concurrent server offer, the polite inbound-offer path rolls our offer
  // back and answers the server's — then re-offers explicitly (see _onRemoteOffer),
  // so the still-pending screen transceiver reliably reaches the SFU on the retry
  // rather than depending on the browser to re-fire negotiation-needed after a
  // rollback (which it does not do dependably).
  async publish(track, kind) {
    this._addLocal(track, kind);
  }

  // Swap the media on an already-published kind WITHOUT renegotiation. The sender
  // for `kind` was recorded in _addLocal (keyed off the MSID stream id), so this
  // finds it and calls sender.replaceTrack(newTrack). replaceTrack needs no
  // offer/answer for a same-kind track (e.g. raw mic <-> noise-suppressed mic): it
  // changes what flows on the existing m-line in place. Returns true if a sender
  // was found and swapped, false if that kind isn't currently published.
  async replaceTrack(kind, newTrack) {
    const sender = this._senders.get(kind);
    if (!sender) return false;
    await sender.replaceTrack(newTrack);
    return true;
  }

  // Remove a published track (kind) and renegotiate it away. removeTrack clears the
  // sender and flags negotiation-needed, so onnegotiationneeded re-offers without
  // the track.
  unpublish(kind) {
    const sender = this._senders.get(kind);
    if (!sender) return;
    this._senders.delete(kind);
    this.pc.removeTrack(sender);
  }

  // Tear down the peer connection.
  close() {
    if (this._iceGraceTimer) {
      clearTimeout(this._iceGraceTimer);
      this._iceGraceTimer = null;
    }
    this.pc.close();
  }

  // --- outbound negotiation ---

  _addLocal(track, kind) {
    // sendonly + streamIds:[kind]: the stream id is how the SFU learns the kind.
    const transceiver = this.pc.addTransceiver(track, { direction: "sendonly", streamIds: [kind] });
    this._senders.set(kind, transceiver.sender);
    return transceiver;
  }

  // Create and send one offer, guarded so overlapping triggers (start + the queued
  // onnegotiationneeded, or a burst of publishes) collapse into a single offer and
  // never fire while an offer/answer is already in flight.
  async _makeOffer() {
    if (this.makingOffer || this.pc.signalingState !== "stable") return;
    try {
      this.makingOffer = true;
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.signaling.send("offer", { sdp: this.pc.localDescription.sdp });
    } finally {
      this.makingOffer = false;
    }
  }

  // --- inbound signaling ---

  // A server-initiated offer (renegotiation). Ask lib/negotiation whether this
  // collides with an offer of our own; the polite peer rolls its own offer back
  // first, then answers either way. Rolling back discards our local offer but keeps
  // any transceiver we had added (notably a screenshare) — that transceiver is now
  // on the PC but absent from the negotiated description, so the SFU cannot see it.
  // We therefore re-offer EXPLICITLY once we are back to stable rather than relying
  // on onnegotiationneeded to re-fire after the rollback: browsers do not re-fire it
  // dependably in that case, and without the re-offer the screen track would sit
  // unpublished and never reach the other participants.
  async _onRemoteOffer(msg) {
    const { action } = handleRemoteOffer({
      makingOffer: this.makingOffer,
      signalingState: this.pc.signalingState,
    });
    const rolledBack = action === "rollback-then-answer";
    if (rolledBack) {
      await this.pc.setLocalDescription({ type: "rollback" });
    }
    await this.pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
    await this._drainCandidates();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.signaling.send("answer", { sdp: this.pc.localDescription.sdp });
    // Glare recovery: we just discarded our own in-flight offer. Re-run _makeOffer so
    // any transceiver added while that offer was pending (screenshare) is offered
    // again. _makeOffer is guarded (only offers from a stable state, never while one
    // is already in flight) and createOffer reflects the live transceiver set, so this
    // reliably re-publishes the pending track and is a harmless no-op when there is
    // nothing new to negotiate.
    if (rolledBack) this._makeOffer().catch((err) => this._emitError(err, "negotiation"));
  }

  // Our own offer was accepted; complete the exchange.
  async _onRemoteAnswer(msg) {
    await this.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
    await this._drainCandidates();
  }

  // A remote ICE candidate. addIceCandidate throws if no remote description is set
  // yet, so buffer until one is (candidates can outrun the offer/answer).
  async _onRemoteCandidate(msg) {
    const candidate = msg.candidate;
    if (!candidate) return; // end-of-candidates sentinel
    if (!this.pc.remoteDescription) {
      this._pendingCandidates.push(candidate);
      return;
    }
    await this.pc.addIceCandidate(candidate);
  }

  async _drainCandidates() {
    const pending = this._pendingCandidates;
    this._pendingCandidates = [];
    for (const candidate of pending) {
      try {
        await this.pc.addIceCandidate(candidate);
      } catch (err) {
        this._emitError(err, "candidate");
      }
    }
  }

  // The SFU's labelling for the tracks it forwards: mid -> {participantId, kind}.
  // Sent (and resent as the set changes) after each renegotiation. Rebuild the map
  // from scratch and try to emit any track already received on those mids — ontrack
  // and this message race, and either can arrive first.
  _onTracks(msg) {
    this._trackInfo = new Map();
    for (const info of msg.tracks || []) {
      this._trackInfo.set(info.mid, { participantId: info.participantId, kind: info.kind });
      this._emitRemoteTrack(info.mid);
    }
  }

  // --- inbound media ---

  _onTrack(event) {
    const mid = event.transceiver.mid;
    const stream = event.streams[0] || null;
    this._incoming.set(mid, { stream, track: event.track, emitted: false, info: null });
    this._emitRemoteTrack(mid);

    // A forwarded stream ends when the publisher leaves and the SFU renegotiates
    // the sender away: the receiver track fires "ended", or the stream drops it.
    const gone = () => this._onStreamGone(mid);
    event.track.addEventListener("ended", gone);
    if (stream) stream.addEventListener("removetrack", gone);
  }

  // Emit "remote-track" once BOTH the media (ontrack) and its label (tracks
  // message) are known for a mid; idempotent so whichever arrives second triggers
  // exactly one emission.
  _emitRemoteTrack(mid) {
    const info = this._trackInfo.get(mid);
    const rec = this._incoming.get(mid);
    if (!info || !rec || rec.emitted) return;
    rec.emitted = true;
    rec.info = info;
    this.dispatchEvent(
      new CustomEvent("remote-track", {
        detail: { participantId: info.participantId, kind: info.kind, stream: rec.stream },
      }),
    );
  }

  _onStreamGone(mid) {
    const rec = this._incoming.get(mid);
    if (!rec) return;
    this._incoming.delete(mid);
    const info = rec.info || this._trackInfo.get(mid) || {};
    this._trackInfo.delete(mid);
    this.dispatchEvent(
      new CustomEvent("peer-gone", { detail: { participantId: info.participantId, kind: info.kind } }),
    );
  }

  // --- media-plane health ---

  // Fired for both connectionState and iceConnectionState transitions. A recovery
  // (our ICE restart landing, or a transient blip clearing) shows up as "connected";
  // drop any pending grace timer so we don't warn about a link that came back. A
  // hard "failed" on either state machine kicks off the one-shot recovery.
  _onConnectionStateChange() {
    if (this.pc.connectionState === "connected") {
      if (this._iceGraceTimer) {
        clearTimeout(this._iceGraceTimer);
        this._iceGraceTimer = null;
      }
      return;
    }
    if (this.pc.connectionState === "failed" || this.pc.iceConnectionState === "failed") {
      this._handleMediaFailure();
    }
  }

  // One cheap recovery attempt, then surrender to the user. restartIce() flags the
  // next negotiation as an ICE restart; onnegotiationneeded then re-offers through
  // the normal perfect-negotiation path (the polite peer still yields on glare), so
  // it composes with the existing flow rather than bypassing it. If the restart
  // doesn't reconnect within the grace window — or the browser lacks restartIce, or
  // it already ran and failed again — we emit "media-failed" once. We never loop.
  _handleMediaFailure() {
    if (this._mediaFailedEmitted) return;
    // A single ICE failure drives BOTH iceConnectionState and connectionState to
    // "failed" as separate events. While a restart is in flight (grace timer
    // armed), let only that timer decide — otherwise the sibling event would
    // fall through to _emitMediaFailed() and warn instantly, skipping the grace.
    if (this._iceGraceTimer) return;
    if (!this._restartedIce && typeof this.pc.restartIce === "function") {
      this._restartedIce = true;
      try {
        this.pc.restartIce();
      } catch (err) {
        this._emitError(err, "ice-restart");
      }
      if (this._iceGraceTimer) clearTimeout(this._iceGraceTimer);
      this._iceGraceTimer = setTimeout(() => {
        this._iceGraceTimer = null;
        if (this.pc.connectionState !== "connected") this._emitMediaFailed();
      }, ICE_RESTART_GRACE_MS);
      return;
    }
    this._emitMediaFailed();
  }

  _emitMediaFailed() {
    if (this._mediaFailedEmitted) return;
    this._mediaFailedEmitted = true;
    if (this._iceGraceTimer) {
      clearTimeout(this._iceGraceTimer);
      this._iceGraceTimer = null;
    }
    this.dispatchEvent(new CustomEvent("media-failed"));
  }

  _emitError(error, phase) {
    this.dispatchEvent(new CustomEvent("error", { detail: { error, phase } }));
  }
}
