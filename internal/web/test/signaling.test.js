import { test } from "node:test";
import assert from "node:assert/strict";
import { Signaling } from "../assets/net/signaling.js";
import { encode } from "../assets/lib/protocol.js";

// Minimal mock WebSocket. Records every constructed instance, records sent
// frames, and lets a test drive the socket lifecycle by firing the events
// signaling.js registers via addEventListener ("open"/"message"/"close").
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = MockWebSocket.CONNECTING;
    this.sent = [];
    this.closed = false;
    this._listeners = { open: [], message: [], close: [], error: [] };
    MockWebSocket.instances.push(this);
  }

  addEventListener(type, fn) {
    (this._listeners[type] ||= []).push(fn);
  }

  send(frame) {
    this.sent.push(frame);
  }

  close() {
    this.closed = true;
    this.readyState = MockWebSocket.CLOSED;
    // A real browser fires "close" asynchronously after close(); signaling's
    // stop() nulls this.ws before calling close(), so tests fire it explicitly.
  }

  // --- test drivers -------------------------------------------------------
  _fire(type, event) {
    for (const fn of this._listeners[type] || []) fn(event);
  }
  fireOpen() {
    this.readyState = MockWebSocket.OPEN;
    this._fire("open");
  }
  fireMessage(data) {
    this._fire("message", { data });
  }
  fireClose() {
    this.readyState = MockWebSocket.CLOSED;
    this._fire("close");
  }
}

// install() swaps in mock globals for the duration of one test and restores
// them in t.after. Returns handles onto the recorded WebSocket instances and
// the captured (never-actually-scheduled) reconnect timers.
function install(t, { protocol = "http:", host = "example.com" } = {}) {
  const saved = {
    WebSocket: globalThis.WebSocket,
    location: globalThis.location,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    random: Math.random,
  };

  MockWebSocket.instances = [];
  const instances = MockWebSocket.instances;
  const timers = [];
  let nextId = 1;

  globalThis.WebSocket = MockWebSocket;
  globalThis.location = { protocol, host };
  // Capture, do not wait: record the callback + delay so the test can fire it.
  globalThis.setTimeout = (fn, delay) => {
    const timer = { id: nextId++, fn, delay, cleared: false };
    timers.push(timer);
    return timer.id;
  };
  globalThis.clearTimeout = (id) => {
    const timer = timers.find((x) => x.id === id);
    if (timer) timer.cleared = true;
  };
  // Deterministic jitter: 0, so a reconnect delay equals the pure backoff.
  Math.random = () => 0;

  t.after(() => {
    globalThis.WebSocket = saved.WebSocket;
    globalThis.location = saved.location;
    globalThis.setTimeout = saved.setTimeout;
    globalThis.clearTimeout = saved.clearTimeout;
    Math.random = saved.random;
  });

  return { instances, timers };
}

test("send before open queues frames and flushes them FIFO on open", (t) => {
  const { instances } = install(t);
  const sig = new Signaling("/ws/room1");
  sig.connect();
  sig.send("join", { name: "alice" });
  sig.send("chat", { text: "hi" });

  const ws = instances[0];
  assert.equal(ws.sent.length, 0, "nothing is sent before the socket opens");

  ws.fireOpen();
  assert.deepEqual(
    ws.sent,
    [encode("join", { name: "alice" }), encode("chat", { text: "hi" })],
    "queued frames flush in FIFO order on open",
  );

  // Once open, a subsequent send goes straight through (no re-queue).
  sig.send("chat", { text: "there" });
  assert.equal(ws.sent.length, 3);
  assert.equal(ws.sent[2], encode("chat", { text: "there" }));
});

test("on() dispatches decoded frames to the type handler and the catch-all", (t) => {
  const { instances } = install(t);
  const sig = new Signaling("/ws/room1");
  const chat = [];
  const all = [];
  sig.on("chat", (m) => chat.push(m));
  sig.on("*", (m) => all.push(m));
  sig.connect();

  const ws = instances[0];
  ws.fireOpen();
  ws.fireMessage(encode("chat", { from: "a", text: "hi" }));
  assert.deepEqual(chat, [{ type: "chat", from: "a", text: "hi" }]);
  assert.deepEqual(all, [{ type: "chat", from: "a", text: "hi" }]);

  // A non-matching type reaches only the catch-all.
  ws.fireMessage(encode("join", { name: "b" }));
  assert.equal(chat.length, 1, "type handler not fired for a different type");
  assert.equal(all.length, 2, "catch-all fires for every message");
});

test("off() removes a handler so it stops receiving frames (peer rebuild on reconnect)", (t) => {
  const { instances } = install(t);
  const sig = new Signaling("/ws/room1");
  const stale = [];
  const fresh = [];
  const onStale = (m) => stale.push(m);
  const onFresh = (m) => fresh.push(m);
  sig.on("offer", onStale);
  sig.connect();
  const ws = instances[0];
  ws.fireOpen();

  ws.fireMessage(encode("offer", { sdp: "a" }));
  assert.equal(stale.length, 1, "handler receives while registered");

  // Rebuild: detach the stale handler, attach a fresh one — only the fresh one fires.
  sig.off("offer", onStale);
  sig.on("offer", onFresh);
  ws.fireMessage(encode("offer", { sdp: "b" }));
  assert.equal(stale.length, 1, "detached handler no longer fires");
  assert.deepEqual(fresh, [{ type: "offer", sdp: "b" }], "fresh handler fires");

  // off() for an unknown handler/type is a harmless no-op.
  assert.doesNotThrow(() => sig.off("offer", () => {}));
  assert.doesNotThrow(() => sig.off("nope", onFresh));
});

test("a malformed inbound frame is ignored, not dispatched, and does not throw", (t) => {
  const { instances } = install(t);
  const sig = new Signaling("/ws/room1");
  let dispatched = 0;
  sig.on("*", () => dispatched++);
  sig.connect();

  const ws = instances[0];
  ws.fireOpen();
  assert.doesNotThrow(() => ws.fireMessage("not json"));
  assert.doesNotThrow(() => ws.fireMessage('{"no":"type"}'));
  assert.equal(dispatched, 0, "no handler runs for undecodable frames");
});

test("an unexpected close schedules a reconnect that opens a new socket", (t) => {
  const { instances, timers } = install(t);
  const sig = new Signaling("/ws/room1");
  sig.connect();

  const ws = instances[0];
  ws.fireOpen();
  assert.equal(instances.length, 1);

  ws.fireClose(); // unexpected drop
  assert.equal(timers.length, 1, "a reconnect timer is scheduled");
  assert.equal(timers[0].delay, 500, "first reconnect uses backoff(0) + zero jitter");
  assert.equal(instances.length, 1, "no new socket until the timer fires");

  timers[0].fn(); // simulate the timer firing
  assert.equal(instances.length, 2, "reconnect constructs a fresh socket");
  assert.equal(instances[1].url, "ws://example.com/ws/room1");
});

test("stop() closes the socket and suppresses any further reconnect", (t) => {
  const { instances, timers } = install(t);
  const sig = new Signaling("/ws/room1");
  sig.connect();

  const ws = instances[0];
  ws.fireOpen();
  sig.stop();
  assert.equal(ws.closed, true, "stop() closes the live socket");

  // A close event arriving after stop() must NOT schedule a reconnect.
  ws.fireClose();
  assert.equal(timers.length, 0, "no reconnect scheduled after stop()");
  assert.equal(instances.length, 1);

  // connect() after stop() is a no-op.
  sig.connect();
  assert.equal(instances.length, 1, "connect() is inert once stopped");
});

// Load-bearing case for ban enforcement: a reconnect timer is already pending
// when stop() is called. stop() must cancel it, and even if that captured
// callback fires anyway (a lost race), it must open NO new socket.
test("stop() cancels a pending reconnect timer; firing it opens no socket", (t) => {
  const { instances, timers } = install(t);
  const sig = new Signaling("/ws/room1");
  sig.connect();

  const ws = instances[0];
  ws.fireOpen();
  ws.fireClose(); // unexpected close -> reconnect timer pending
  assert.equal(timers.length, 1);
  assert.equal(timers[0].cleared, false);

  sig.stop(); // must clearTimeout the pending reconnect
  assert.equal(timers[0].cleared, true, "stop() clears the pending reconnect timer");

  // Fire the captured callback anyway (as if the timer had already elapsed).
  timers[0].fn();
  assert.equal(
    instances.length,
    1,
    "no new socket: connect() short-circuits because stopped is set",
  );
});

test("https page resolves a wss:// URL to /ws/<room>", (t) => {
  const { instances } = install(t, { protocol: "https:", host: "chat.example:8443" });
  new Signaling("/ws/roomA").connect();
  assert.equal(instances[0].url, "wss://chat.example:8443/ws/roomA");
});

test("http page resolves a ws:// URL to /ws/<room>", (t) => {
  const { instances } = install(t, { protocol: "http:", host: "localhost:8080" });
  new Signaling("/ws/roomB").connect();
  assert.equal(instances[0].url, "ws://localhost:8080/ws/roomB");
});

test("an already-absolute ws(s) URL is left unchanged", (t) => {
  const { instances } = install(t, { protocol: "http:", host: "ignored" });
  new Signaling("wss://other.example/ws/x").connect();
  assert.equal(instances[0].url, "wss://other.example/ws/x");
});
