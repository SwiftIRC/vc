// Browser side of the WebRTC media plane: one RTCPeerConnection to the SFU,
// driven by perfect negotiation. The client is the POLITE peer; the SFU is
// impolite (it keeps its offer on a glare). On an inbound-offer collision this
// peer rolls its own offer back and answers, which is what makes glare converge
// (see lib/negotiation.js).
//
// No ICE servers are configured: the SFU has a public IP, so host/srflx
// candidates gathered locally are enough — there is no STUN/TURN.
//
// The client conveys each published track's KIND (mic|camera|screen) to the SFU
// OUT-OF-BAND: it publishes the track under its own MediaStream and sends a
// {msid-stream-id -> kind} map alongside every offer (signal.Offer.kinds). A
// browser cannot set an arbitrary MSID stream id — MediaStream.id is read-only and
// random — so the kind cannot ride the stream id itself; instead we read the id
// our MediaStream was assigned and tell the server what it means, and the SFU joins
// its OnTrack's remote.StreamID() to that map. (Without this the SFU can only fall
// back to the RTP media type, which cannot tell a screen share from a camera — both
// VP8 — so the screen would collide with the camera and never reach anyone else.)
// Conversely, the SFU labels the tracks it forwards to us out-of-band too, in a
// `tracks` message mapping each transceiver mid -> {participantId, kind}; ontrack
// looks the mid up there to tell which remote participant/kind a stream belongs to.
//
// Events (CustomEvent):
//   "remote-track" {participantId, kind, stream}  a forwarded remote track, labelled
//   "peer-gone"    {participantId, kind}           a forwarded stream ended
//   "error"        {error, phase}                  a signaling/negotiation step failed
//   "media-failed" (no detail)                     the media transport failed and one
//                                                  ICE restart did not recover it
import { handleRemoteOffer } from "../lib/negotiation.js";
import { qualityTier } from "../lib/quality.js";

// How long to let a single ICE restart try to reconnect before we give up and tell
// the user. The transport goes failed -> (restart) -> checking -> connected on a
// recovery, so this only needs to cover a fresh gather + connectivity checks.
const ICE_RESTART_GRACE_MS = 6000;

// Max send bitrate for a screenshare (bits/sec). Plenty for typical desktop/app
// content, while keeping the stream from saturating the sharer's uplink or a receiver's
// downlink and starving the signaling WebSocket (see _capBitrate).
const SCREEN_MAX_BITRATE = 2_500_000;

// TEMP DEBUG: diagnose "remote camera stays black on join". A remote video only
// attaches when its media (ontrack, keyed by transceiver mid) pairs with the SFU's
// label (the "tracks" message, keyed by mid) — see _emitRemoteTrack. A lingering
// UNPAIRED entry in the dumps below (media-without-label or label-without-media) is
// the black-tile bug. Grep the console for "[track-debug]". Set false / remove once fixed.
const TRACK_DEBUG = true;

export class Peer extends EventTarget {
  constructor(signaling) {
    super();
    this.signaling = signaling;
    this.pc = new RTCPeerConnection(); // no ICE servers: public-IP SFU

    // Perfect-negotiation state. makingOffer is true only while THIS peer is
    // creating+applying its own offer, so an inbound offer that arrives in that
    // window is recognised as a glare (handleRemoteOffer) and answered politely.
    this.makingOffer = false;
    // Set when a renegotiation was needed (screenshare add/remove) but could not be
    // offered because the PC wasn't stable — a rolled-back offer, or a raced server
    // offer. _flushPendingOffer re-sends it the moment we return to stable, so a
    // screenshare toggle can't be silently lost mid-glare.
    this._negotiationPending = false;

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
    // Op-set session video caps ({camera, screen} tier ids); applied to our senders.
    this._quality = { camera: "auto", screen: "auto" };
    // Each published track's KIND is conveyed to the SFU out-of-band, keyed by the
    // MSID stream id of the MediaStream we publish it under (a browser cannot set an
    // arbitrary stream id, but it CAN read the random one it was assigned). Both
    // directions are kept: _kindByStreamId is sent to the server with each offer;
    // _streamIdByKind lets unpublish and re-publish drop the stale mapping.
    this._kindByStreamId = new Map();
    this._streamIdByKind = new Map();

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
    // Recorded so close() can detach them: on a reconnect the media Peer is rebuilt but
    // the Signaling object persists, and stale handlers would run alongside the fresh
    // Peer's (double-answering the SFU) if left registered.
    this._sigHandlers = [
      ["offer", (msg) => this._onRemoteOffer(msg).catch((err) => this._emitError(err, "offer"))],
      ["answer", (msg) => this._onRemoteAnswer(msg).catch((err) => this._emitError(err, "answer"))],
      ["candidate", (msg) => this._onRemoteCandidate(msg).catch((err) => this._emitError(err, "candidate"))],
      ["tracks", (msg) => this._onTracks(msg)],
    ];
    for (const [type, fn] of this._sigHandlers) signaling.on(type, fn);

    // TEMP DEBUG (see TRACK_DEBUG): sample inbound video decode stats every 4s so a
    // black-camera occurrence is captured in the console. Cleared in close().
    this._statsTimer = TRACK_DEBUG ? setInterval(() => this._dumpStats(), 4000) : null;
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
    const existing = this._senders.get(kind);
    if (existing) {
      // Already publishing this kind: swap the track in place rather than adding a
      // SECOND transceiver for it. A duplicate m-line for the same kind (e.g. from a
      // re-publish or a rapid camera-track race) gives two m-lines overlapping demux
      // criteria, which the far side can fail to apply ("demuxer criteria").
      await existing.replaceTrack(track);
      this._applyQuality(kind); // the swapped-in track may have a different resolution
      return;
    }
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
    this._applyQuality(kind); // re-cap: a device switch can change the source resolution
    return true;
  }

  // Remove a published track (kind) and renegotiate it away. removeTrack clears the
  // sender and flags negotiation-needed, so onnegotiationneeded re-offers without
  // the track.
  unpublish(kind) {
    const sender = this._senders.get(kind);
    if (!sender) return;
    this._senders.delete(kind);
    const streamId = this._streamIdByKind.get(kind);
    if (streamId) {
      this._streamIdByKind.delete(kind);
      this._kindByStreamId.delete(streamId);
    }
    this.pc.removeTrack(sender);
  }

  // Tear down the peer connection. Detaches our Signaling handlers first so a Peer
  // rebuilt on the same (persistent) Signaling doesn't leave this one answering too.
  close() {
    for (const [type, fn] of this._sigHandlers) this.signaling.off(type, fn);
    this._sigHandlers = [];
    if (this._iceGraceTimer) {
      clearTimeout(this._iceGraceTimer);
      this._iceGraceTimer = null;
    }
    if (this._statsTimer) {
      clearInterval(this._statsTimer);
      this._statsTimer = null;
    }
    this.pc.close();
  }

  // --- outbound negotiation ---

  _addLocal(track, kind) {
    // Publish under a dedicated MediaStream so the outgoing SDP carries a real MSID
    // stream id (a=msid:<stream.id> <trackid>). We read that id — which we cannot
    // choose — and map it to the kind; _makeOffer sends the map so the SFU can tell
    // this track's kind (it cannot distinguish camera from screen otherwise).
    const stream = new MediaStream([track]);
    const transceiver = this.pc.addTransceiver(track, { direction: "sendonly", streams: [stream] });
    const prev = this._streamIdByKind.get(kind);
    if (prev) this._kindByStreamId.delete(prev); // re-publishing a kind mints a fresh stream id
    this._streamIdByKind.set(kind, stream.id);
    this._kindByStreamId.set(stream.id, kind);
    this._senders.set(kind, transceiver.sender);
    this._applyQuality(kind); // resolution/framerate cap (+ screenshare bitrate cap)
    return transceiver;
  }

  // Apply the op-set session video caps to our outgoing senders. Stored so a track that
  // is later (re)published or device-switched picks up the current cap automatically.
  setQuality(camera, screen) {
    this._quality = { camera: camera || "auto", screen: screen || "auto" };
    this._applyQuality("camera");
    this._applyQuality("screen");
  }

  // Constrain one video sender to its tier: scale the encode down to the tier's height
  // (never up; capture is untouched) and cap the framerate. Screenshares also keep a
  // bitrate ceiling — the SFU forwards a publisher's stream to every subscriber
  // unchanged, so an uncapped share can flood the sharer's uplink and a receiver's
  // downlink, starving the signaling WebSocket that shares the link (a spurious
  // reconnect). All in ONE setParameters so the caps don't race each other's transaction.
  _applyQuality(kind) {
    if (kind !== "camera" && kind !== "screen") return;
    const sender = this._senders.get(kind);
    if (!sender || !sender.track) return;
    const tier = qualityTier(this._quality && this._quality[kind]);
    let params;
    try {
      params = sender.getParameters();
    } catch {
      return; // getParameters unsupported — best effort
    }
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
    const enc = params.encodings[0];
    const h = (sender.track.getSettings && sender.track.getSettings().height) || 0;
    enc.scaleResolutionDownBy = tier.height && h ? Math.max(1, h / tier.height) : 1;
    if (tier.fps) enc.maxFramerate = tier.fps;
    else delete enc.maxFramerate;
    if (kind === "screen") enc.maxBitrate = SCREEN_MAX_BITRATE;
    sender.setParameters(params).catch(() => {});
  }

  // Create and send one offer, guarded so overlapping triggers (start + the queued
  // onnegotiationneeded, or a burst of publishes) collapse into a single offer and
  // never fire while an offer/answer is already in flight.
  async _makeOffer() {
    if (this.makingOffer || this.pc.signalingState !== "stable") {
      // Can't offer right now (an exchange is in flight). Remember that we still owe
      // one; _flushPendingOffer re-tries when we're stable again. Without this, a
      // screenshare add/remove that raced a server offer would be dropped silently.
      this._negotiationPending = true;
      return;
    }
    this._negotiationPending = false;
    try {
      this.makingOffer = true;
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      // Send the kind map with the offer so the SFU can label each published track
      // (it reads remote.StreamID() and looks it up here). Harmless when empty.
      this.signaling.send("offer", {
        sdp: this.pc.localDescription.sdp,
        kinds: Object.fromEntries(this._kindByStreamId),
      });
    } finally {
      this.makingOffer = false;
    }
  }

  // Re-send an offer that was deferred (see _makeOffer) or discarded by a rollback,
  // once the PC is back to stable. Only fires when WE explicitly deferred an offer —
  // a plain browser-deferred negotiationneeded leaves _negotiationPending false and
  // re-fires on its own, so this never double-offers.
  _flushPendingOffer() {
    if (this._negotiationPending) this._makeOffer().catch((err) => this._emitError(err, "negotiation"));
  }

  // --- inbound signaling ---

  // A server-initiated offer (renegotiation). Ask lib/negotiation whether this
  // collides with an offer of our own. On collision the polite peer yields via
  // IMPLICIT rollback: a bare setRemoteDescription(offer) while we hold a local offer
  // rolls ours back atomically (the WebRTC perfect-negotiation pattern) and applies
  // the server's in one operation. We deliberately do NOT do a manual
  // setLocalDescription({type:"rollback"}) first: that two-step reshuffles m-lines —
  // a send transceiver we just added (a screenshare) gets re-associated with the
  // server's freshly forwarded m-line, so our next offer's m-line order no longer
  // matches the last answer and the peer wedges ("The order of m-lines ... doesn't
  // match ..."). Rolling back still keeps the added transceiver on the PC but out of
  // the negotiated description, so we re-offer EXPLICITLY once stable (browsers don't
  // dependably re-fire onnegotiationneeded after a rollback) — otherwise the screen
  // track would sit unpublished.
  async _onRemoteOffer(msg) {
    const { action } = handleRemoteOffer({
      makingOffer: this.makingOffer,
      signalingState: this.pc.signalingState,
    });
    const rolledBack = action === "rollback-then-answer";
    // Implicit rollback: no manual rollback step — SRD(offer) does it when we're not stable.
    try {
      await this.pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
    } catch (err) {
      // "The order of m-lines ... doesn't match ..." lands here. The failed SRD did not
      // apply, so localDescription is still our last negotiated answer — dump the m-line
      // order of BOTH (compact, then full SDPs) so the reordered line is obvious.
      const order = (sdp) => (sdp || "").split(/\r?\n/).filter((l) => l.startsWith("m=") || l.startsWith("a=mid:")).join("  ");
      const layout = this.pc.getTransceivers().map((t) => `${t.mid}:${t.direction}>${t.currentDirection || "-"}`).join(" ");
      console.error(
        "[peer] offer setRemoteDescription failed:", String(err),
        "\ntransceivers:", layout,
        "\nLAST-NEGOTIATED m-lines:", order(this.pc.localDescription && this.pc.localDescription.sdp),
        "\nFAILED-OFFER   m-lines:", order(msg.sdp),
        "\n--- LAST LOCAL DESCRIPTION (our answer) ---\n" + (this.pc.localDescription ? this.pc.localDescription.sdp : "(none)"),
        "\n--- FAILED SERVER OFFER ---\n" + msg.sdp,
      );
      throw err;
    }
    await this._drainCandidates();
    const answer = await this.pc.createAnswer();
    try {
      await this.pc.setLocalDescription(answer);
    } catch (err) {
      // Applying the answer can fail with "Failed to apply demuxer criteria" when two
      // m-lines carry indistinguishable RTP (same payload type, conflicting SSRC/MID).
      // That's a renegotiation-shape problem — dump the m-line layout and the SDPs so
      // the offending pair is diagnosable, then let the error propagate as usual.
      const layout = this.pc.getTransceivers().map((t) => `${t.mid}:${t.direction}>${t.currentDirection || "-"}`).join(" ");
      console.error("[peer] answer setLocalDescription failed:", String(err), "\ntransceivers:", layout, "\n--- SERVER OFFER ---\n" + msg.sdp + "\n--- OUR ANSWER ---\n" + answer.sdp);
      throw err;
    }
    this.signaling.send("answer", { sdp: this.pc.localDescription.sdp });
    // A rollback discarded our own in-flight offer; the transceivers it carried
    // (a screenshare) are still on the PC but unnegotiated, so we owe a fresh offer.
    // Flush that (and any offer deferred while we weren't stable) now — AFTER the
    // answer above, so ordering with the server is preserved. _makeOffer is guarded
    // and reflects the live transceiver set, so it re-publishes the pending track and
    // is a harmless no-op when nothing new needs negotiating.
    if (rolledBack) this._negotiationPending = true;
    this._flushPendingOffer();
  }

  // Our own offer was accepted; complete the exchange.
  async _onRemoteAnswer(msg) {
    try {
      await this.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
    } catch (err) {
      // "Failed to set SSL role for the transport" lands here when the answer's DTLS role
      // conflicts with the established transport (a role flip across renegotiation). The
      // failed SRD did not apply. Dump the a=setup/a=fingerprint of BOTH our offer and the
      // server's answer so a recurrence is diagnosable — that's the pair that disagrees.
      const dtls = (sdp) => (sdp || "").split(/\r?\n/).filter((l) => l.startsWith("m=") || l.startsWith("a=mid:") || l.startsWith("a=setup:") || l.startsWith("a=fingerprint:")).join("  ");
      console.error(
        "[peer] answer setRemoteDescription failed:", String(err),
        "\nOUR-OFFER    setup:", dtls(this.pc.localDescription && this.pc.localDescription.sdp),
        "\nSERVER-ANSWER setup:", dtls(msg.sdp),
        "\n--- OUR LOCAL DESCRIPTION (our offer) ---\n" + (this.pc.localDescription ? this.pc.localDescription.sdp : "(none)"),
        "\n--- FAILED SERVER ANSWER ---\n" + msg.sdp,
      );
      throw err;
    }
    await this._drainCandidates();
    // Back to stable — send any offer that was deferred while this one was in flight.
    this._flushPendingOffer();
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
  //
  // The list is also AUTHORITATIVE about what the SFU still forwards: it is built
  // from the live senders on the server's PeerConnection, so a mid we hold media for
  // that is no longer listed is a forward the server has dropped (the publisher
  // stopped a screenshare, or left). Retire those here rather than relying solely on
  // a media event.
  //
  // This is a SAFETY NET, not the main path: removetrack/ended only fires once the
  // browser applies an offer whose m-line stopped receiving, so a renegotiation that
  // never reaches us — dropped on send overflow, or lost to a server-side race —
  // leaves the tile orphaned for the rest of the call, which is how a stopped
  // screenshare stayed on every receiver's screen. This message rides the same
  // renegotiation but is also the last thing sent, so it closes that gap.
  // _onStreamGone is idempotent: whichever signal arrives first wins.
  _onTracks(msg) {
    const next = new Map();
    for (const info of msg.tracks || []) {
      next.set(info.mid, { participantId: info.participantId, kind: info.kind });
    }
    // Retire departed forwards BEFORE swapping the map in, so _onStreamGone can
    // still fall back to the old label for a track that never paired with media.
    for (const mid of [...this._incoming.keys()]) {
      if (!next.has(mid)) this._onStreamGone(mid);
    }
    this._trackInfo = next;
    for (const mid of next.keys()) this._emitRemoteTrack(mid);
    this._dumpPairing("onTracks");
  }

  // --- inbound media ---

  _onTrack(event) {
    const mid = event.transceiver.mid;
    // The SFU forwards ALL of a publisher's tracks (mic, camera, screen) under one
    // MSID stream id, so event.streams[0] bundles them into a single MediaStream —
    // and a <video> bound to a stream with two video tracks (camera + screen) shows
    // an arbitrary one, which made the screen tile display the camera. Wrap just
    // THIS track so each element renders exactly its own track. Gone-detection still
    // watches the shared stream's removetrack (filtered to this track) plus "ended".
    const stream = new MediaStream([event.track]);
    const shared = event.streams[0] || null;
    this._incoming.set(mid, { stream, track: event.track, emitted: false, info: null });
    this._emitRemoteTrack(mid);
    this._dumpPairing(`onTrack mid=${mid} rtpKind=${event.track.kind}`);

    // A forwarded track ends when the publisher leaves/unpublishes and the SFU
    // renegotiates the sender away: the receiver track fires "ended", or the shared
    // stream drops it (removetrack fires for whichever track was removed).
    const gone = () => this._onStreamGone(mid);
    event.track.addEventListener("ended", gone);
    if (shared) shared.addEventListener("removetrack", (e) => { if (e.track === event.track) gone(); });
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
    if (TRACK_DEBUG) console.info(`[track-debug] ATTACH mid=${mid} ${info.kind}@${info.participantId}`);
    this.dispatchEvent(
      new CustomEvent("remote-track", {
        detail: { participantId: info.participantId, kind: info.kind, stream: rec.stream },
      }),
    );
  }

  // TEMP DEBUG (see TRACK_DEBUG): dump the mid-pairing state after a media/label event
  // and flag any track whose media (ontrack) and label (tracks message) haven't paired.
  // A persistent UNPAIRED entry for a camera mid is the black-tile-on-join signature:
  //   media-without-label -> RTP/ontrack arrived on a mid the SFU never labelled (or
  //     labelled on a different mid) — a mid-mismatch on the client side.
  //   label-without-media -> the SFU labelled a mid whose RTP/ontrack never arrived —
  //     the SFU isn't forwarding it (cross-check chrome://webrtc-internals bytesReceived).
  _dumpPairing(where) {
    if (!TRACK_DEBUG) return;
    const incoming = [...this._incoming.keys()];
    const labels = [...this._trackInfo.entries()].map(([mid, i]) => `${mid}=${i.kind}@${i.participantId}`);
    const mediaNoLabel = incoming.filter((mid) => !this._trackInfo.has(mid));
    const labelNoMedia = [...this._trackInfo.keys()].filter((mid) => !this._incoming.has(mid));
    let line = `[track-debug ${where}] incomingMids=[${incoming.join(",")}] labels=[${labels.join(" ")}]`;
    if (mediaNoLabel.length) line += ` !! UNPAIRED media-without-label mids=[${mediaNoLabel.join(",")}]`;
    if (labelNoMedia.length) line += ` !! UNPAIRED label-without-media mids=[${labelNoMedia.join(",")}]`;
    console.info(line);
  }

  // TEMP DEBUG (see TRACK_DEBUG): periodically dump inbound VIDEO decode stats so a
  // black-camera-on-join occurrence is captured. Read-only (getStats). Reading the fields:
  //   recv climbing but dec/key staying 0 -> no decodable keyframe reached this receiver
  //   high lost + climbing pli/nack       -> keyframe packets lost on the link
  //   dec climbing + nonzero size but tile black -> client render/element stall
  async _dumpStats() {
    if (!TRACK_DEBUG || !this.pc || !this._incoming) return;
    if (this.pc.connectionState === "closed") return;
    let stats;
    try {
      stats = await this.pc.getStats();
    } catch {
      return;
    }
    const trackToMid = new Map();
    for (const [mid, rec] of this._incoming) if (rec && rec.track) trackToMid.set(rec.track.id, mid);
    const lines = [];
    stats.forEach((r) => {
      if (r.type !== "inbound-rtp" || r.kind !== "video") return;
      const mid = trackToMid.get(r.trackIdentifier);
      const info = mid != null && this._trackInfo ? this._trackInfo.get(mid) : null;
      const who = info ? `${info.kind}@${info.participantId}` : `ssrc=${r.ssrc}`;
      lines.push(
        `${who} mid=${mid ?? "?"} recv=${r.framesReceived ?? 0} dec=${r.framesDecoded ?? 0} key=${r.keyFramesDecoded ?? 0} drop=${r.framesDropped ?? 0} pli=${r.pliCount ?? 0} nack=${r.nackCount ?? 0} lost=${r.packetsLost ?? 0} bytes=${r.bytesReceived ?? 0} ${r.frameWidth ?? 0}x${r.frameHeight ?? 0} fps=${r.framesPerSecond ?? 0}`,
      );
    });
    if (lines.length) console.info("[track-debug stats]\n  " + lines.join("\n  "));
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
