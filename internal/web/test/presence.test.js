import { test } from "node:test";
import assert from "node:assert/strict";
import { Presence } from "../assets/lib/presence.js";

// A controllable timer stand-in so the deferred "drop" chime is deterministic: nothing
// fires until flush() runs the callbacks whose grace has elapsed.
function fakeTimers() {
  let seq = 0;
  const pending = new Map(); // id -> fn
  return {
    setTimeout: (fn) => {
      const id = ++seq;
      pending.set(id, fn);
      return id;
    },
    clearTimeout: (id) => pending.delete(id),
    flush() {
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) fn();
    },
    pendingCount: () => pending.size,
  };
}

function make(graceMs = 6000) {
  const timers = fakeTimers();
  const chimes = [];
  const p = new Presence({
    onJoinChime: () => chimes.push("join"),
    onDropChime: () => chimes.push("drop"),
    graceMs,
    timers,
  });
  return { p, timers, chimes };
}

test("a genuinely new peer rings the join chime", () => {
  const { p, chimes } = make();
  p.joined("refX");
  assert.deepEqual(chimes, ["join"]);
});

test("a real departure rings the drop chime after the grace", () => {
  const { p, timers, chimes } = make();
  p.joined("refX");
  p.left("refX");
  assert.deepEqual(chimes, ["join"], "drop must be deferred, not immediate");
  timers.flush();
  assert.deepEqual(chimes, ["join", "drop"]);
});

test("a reconnect (left then quickly rejoined) rings neither chime", () => {
  const { p, timers, chimes } = make();
  p.seed([{ ref: "refX" }]); // already present from the roster (no join chime)
  p.left("refX"); // old socket drops — drop is deferred
  p.joined("refX"); // same ref rejoins within the grace — cancels the deferred drop
  timers.flush();
  assert.deepEqual(chimes, [], "a reconnect must be silent");
  assert.equal(timers.pendingCount(), 0, "the deferred drop must have been cancelled");
});

test("join-before-left ordering (new socket beats old socket's death) is silent", () => {
  const { p, timers, chimes } = make();
  p.seed([{ ref: "refX" }]);
  p.joined("refX"); // reconnect's NEW socket arrives first (ref already present) -> silent
  p.left("refX"); // reconnect's OLD socket finally drops; another session still present -> silent
  timers.flush();
  assert.deepEqual(chimes, []);
});

test("a distinct new peer still chimes while another is reconnecting", () => {
  const { p, timers, chimes } = make();
  p.seed([{ ref: "refX" }]);
  p.left("refX"); // refX reconnecting (deferred drop)
  p.joined("refY"); // a genuinely different member joins -> chime
  assert.deepEqual(chimes, ["join"]);
  p.joined("refX"); // refX comes back -> cancels its drop, silent
  timers.flush();
  assert.deepEqual(chimes, ["join"]);
});

test("an empty ref is untrackable and always chimes", () => {
  const { p, timers, chimes } = make();
  p.joined(""); // no session nonce -> treat as new
  p.left(""); // -> immediate drop, not deferred
  assert.deepEqual(chimes, ["join", "drop"]);
  assert.equal(timers.pendingCount(), 0, "an empty-ref drop is immediate, never deferred");
});

test("clear cancels a deferred drop so it never fires after teardown", () => {
  const { p, timers, chimes } = make();
  p.joined("refX");
  p.left("refX");
  p.clear();
  timers.flush();
  assert.deepEqual(chimes, ["join"], "the pending drop must be cancelled by clear()");
});

test("seed cancels deferred drops and reseeds presence", () => {
  const { p, timers, chimes } = make();
  p.joined("refX");
  p.left("refX"); // deferred drop pending
  p.seed([{ ref: "refX" }]); // authoritative roster: refX is present again, drop cancelled
  timers.flush();
  assert.deepEqual(chimes, ["join"]);
  // refX is present per the seed, so its next join reads as a reconnect (silent).
  p.joined("refX");
  assert.deepEqual(chimes, ["join"]);
});
