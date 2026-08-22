import { test } from "node:test";
import assert from "node:assert/strict";
import { Peer } from "../assets/net/peer.js";

// Minimal RTCPeerConnection stub. Peer only assigns callback slots on it and calls
// close(); tests drive inbound media by invoking pc.ontrack directly.
class MockPC {
  constructor() {
    this.signalingState = "stable";
    this.connectionState = "new";
    this.iceConnectionState = "new";
    this.closed = false;
  }
  getTransceivers() {
    return [];
  }
  getSenders() {
    return [];
  }
  async getStats() {
    return new Map();
  }
  close() {
    this.closed = true;
    this.connectionState = "closed";
  }
}

// A remote MediaStreamTrack: an EventTarget carrying a kind, so Peer can attach
// its "ended" listener.
class MockTrack extends EventTarget {
  constructor(kind, id) {
    super();
    this.kind = kind;
    this.id = id;
  }
}

// A MediaStream. The SFU forwards ALL of a publisher's tracks under one MSID
// stream id, so every track from a publisher shares one of these — it is the
// object Peer watches for "removetrack".
class MockStream extends EventTarget {
  constructor(tracks = []) {
    super();
    this._tracks = [...tracks];
  }
  getTracks() {
    return [...this._tracks];
  }
  // Test driver: what Chrome does when a forwarded m-line stops receiving.
  fireRemoveTrack(track) {
    this._tracks = this._tracks.filter((t) => t !== track);
    const ev = new Event("removetrack");
    ev.track = track;
    this.dispatchEvent(ev);
  }
}

class MockSignaling {
  constructor() {
    this.handlers = new Map();
    this.sent = [];
  }
  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
  }
  off(type, fn) {
    const fns = this.handlers.get(type) || [];
    const i = fns.indexOf(fn);
    if (i >= 0) fns.splice(i, 1);
  }
  send(type, msg) {
    this.sent.push({ type, msg });
  }
  // Test driver: deliver a decoded frame from the SFU.
  emit(type, msg) {
    for (const fn of [...(this.handlers.get(type) || [])]) fn(msg);
  }
}

// install() swaps in mock browser globals for one test, builds a Peer, and records
// the events it emits. Restores the globals (and stops Peer's debug timer) after.
function install(t) {
  const prev = { pc: globalThis.RTCPeerConnection, ms: globalThis.MediaStream };
  globalThis.RTCPeerConnection = MockPC;
  globalThis.MediaStream = MockStream;
  const signaling = new MockSignaling();
  const peer = new Peer(signaling);
  const events = { track: [], gone: [] };
  peer.addEventListener("remote-track", (e) => events.track.push(e.detail));
  peer.addEventListener("peer-gone", (e) => events.gone.push(e.detail));
  t.after(() => {
    peer.close();
    globalThis.RTCPeerConnection = prev.pc;
    globalThis.MediaStream = prev.ms;
  });
  return { peer, signaling, events };
}

// Label both of a screenshare's forwards and deliver their media, so the peer is
// in the steady "sharing" state every removal test starts from.
function startShare(peer, signaling) {
  const shared = new MockStream();
  const screen = new MockTrack("video", "screen");
  const audio = new MockTrack("audio", "screen-audio");
  signaling.emit("tracks", {
    tracks: [
      { mid: "1", participantId: "p1", kind: "screen" },
      { mid: "2", participantId: "p1", kind: "screen-audio" },
    ],
  });
  peer.pc.ontrack({ transceiver: { mid: "1" }, track: screen, streams: [shared] });
  peer.pc.ontrack({ transceiver: { mid: "2" }, track: audio, streams: [shared] });
  return { shared, screen, audio };
}

test("labelled forwards emit remote-track once media arrives", (t) => {
  const { peer, signaling, events } = install(t);
  startShare(peer, signaling);
  assert.deepEqual(
    events.track.map((d) => d.kind).sort(),
    ["screen", "screen-audio"],
  );
});

// The SFU's `tracks` message is AUTHORITATIVE about what it forwards: it is resent
// after every renegotiation and omits a forward the moment it is dropped. A client
// that only retires media on a browser media event (removetrack/ended) leaves the
// tile orphaned whenever that event does not arrive — the "receivers keep an extra
// sharing pane open after the sharer stops" bug.
test("a forward the SFU no longer lists is retired", (t) => {
  const { peer, signaling, events } = install(t);
  startShare(peer, signaling);

  // p1 stopped sharing: the SFU dropped both forwards and re-labelled. The new
  // list still names another participant's camera, so it is authoritative — an
  // empty one deliberately is not (see the empty-list test below).
  signaling.emit("tracks", { tracks: [{ mid: "9", participantId: "p2", kind: "camera" }] });

  assert.deepEqual(
    events.gone.map((d) => d.kind).sort(),
    ["screen", "screen-audio"],
    "both screen forwards must be retired when the SFU stops listing them",
  );
  assert.deepEqual(events.gone.map((d) => d.participantId), ["p1", "p1"]);
});

// The asymmetry actually observed: the audio half of a share was retired (its
// volume slider vanished) while the video half was not, leaving the pane open. A
// removal signal that depends on a per-track media event can retire one half and
// miss the other; the server's list covers both.
test("a media event for one half still retires the other half", (t) => {
  const { peer, signaling, events } = install(t);
  const { shared, audio } = startShare(peer, signaling);

  shared.fireRemoveTrack(audio); // only the audio track's removetrack fires
  signaling.emit("tracks", { tracks: [{ mid: "9", participantId: "p2", kind: "camera" }] });

  assert.deepEqual(
    events.gone.map((d) => d.kind).sort(),
    ["screen", "screen-audio"],
    "the video half must be retired even though only the audio fired removetrack",
  );
});

// The one input that could blank a whole call. An empty list is not evidence that
// every forward went away — it is equally what a momentarily-empty server view
// looks like, and the server now sends this map on every answer as well as every
// offer, so there are more chances to catch one. Real departures arrive by
// peer-left (which removes the tile outright) and by removetrack per track, so
// declining to act here costs nothing and removes the worst failure mode.
test("an empty tracks list retires nothing", (t) => {
  const { peer, signaling, events } = install(t);
  startShare(peer, signaling);

  signaling.emit("tracks", { tracks: [] });

  assert.deepEqual(events.gone, [], "an empty list tore down live forwards");
});

// Retiring nothing is only half of it. The label map is the OTHER half of every
// pairing, and an empty frame used to wipe it too — so media that arrived afterwards
// had a mid the client could no longer name, and nothing ever paired them: a mid is
// only re-emitted by its own ontrack or by a later list that names it, and a settled
// call may never produce another list. That is the "no camera" signature — a tile
// that never renders, and `!! UNPAIRED media-without-label` in the track debug.
test("an empty tracks list does not strand media that arrives after it", (t) => {
  const { peer, signaling, events } = install(t);

  // The SFU labels the forward...
  signaling.emit("tracks", { tracks: [{ mid: "1", participantId: "p1", kind: "camera" }] });
  // ...then sends a frame with nothing to report (peerTrackInfos skips a transceiver
  // whose mid is not assigned yet, so a map computed mid-negotiation can come out
  // empty)...
  signaling.emit("tracks", { tracks: [] });
  // ...and only then does the media turn up.
  const cam = new MockTrack("video", "camera");
  peer.pc.ontrack({ transceiver: { mid: "1" }, track: cam, streams: [new MockStream([cam])] });

  assert.deepEqual(
    events.track.map((d) => `${d.kind}@${d.participantId}`),
    ["camera@p1"],
    "media arriving after an empty frame never paired with the label it already had",
  );
});

test("a list that still names some forwards retires only the missing ones", (t) => {
  const { peer, signaling, events } = install(t);
  startShare(peer, signaling);

  // Not empty, so it IS authoritative: mid 2 is gone, mid 1 survives.
  signaling.emit("tracks", { tracks: [{ mid: "1", participantId: "p1", kind: "screen" }] });

  assert.deepEqual(events.gone.map((d) => d.kind), ["screen-audio"]);
});

// Retirement must be idempotent: a media event and the server's list both reporting
// the same departure must not emit peer-gone twice (a duplicate would tear down a
// tile the publisher has since re-created).
test("media event and tracks message do not double-retire", (t) => {
  const { peer, signaling, events } = install(t);
  const { shared, screen, audio } = startShare(peer, signaling);

  shared.fireRemoveTrack(screen);
  shared.fireRemoveTrack(audio);
  signaling.emit("tracks", { tracks: [{ mid: "9", participantId: "p2", kind: "camera" }] });

  assert.equal(events.gone.length, 2, "each forward retires exactly once");
});

// A forward that is still listed must never be retired: a renegotiation that only
// adds or removes OTHER forwards resends the full list, and the surviving entries
// must keep their media.
test("forwards still listed survive a renegotiation", (t) => {
  const { peer, signaling, events } = install(t);
  startShare(peer, signaling);

  // The share continues; only the screen-audio half went away.
  signaling.emit("tracks", { tracks: [{ mid: "1", participantId: "p1", kind: "screen" }] });

  assert.deepEqual(events.gone.map((d) => d.kind), ["screen-audio"]);
});
