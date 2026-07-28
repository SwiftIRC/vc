import { test } from "node:test";
import assert from "node:assert/strict";
import { FpsGuard, GRACE_MS, WINDOW_MS, MIN_FPS } from "../assets/lib/fpsGuard.js";

// Drive the guard at a steady rate from t=0 to t=untilMs, checking as it goes.
// Returns the timestamp it tripped at, or null if it never did.
function run(guard, fps, untilMs) {
  const step = 1000 / fps;
  for (let t = 0; t <= untilMs; t += step) {
    guard.push(t);
    if (guard.check(t)) return t;
  }
  return null;
}

test("a healthy 30fps feed never trips", () => {
  const g = new FpsGuard();
  assert.equal(run(g, 30, 30000), null);
  assert.equal(g.tripped, false);
});

test("exactly MIN_FPS is acceptable and does not trip", () => {
  const g = new FpsGuard();
  assert.equal(run(g, MIN_FPS, 30000), null);
});

test("a sustained 5fps feed trips", () => {
  const g = new FpsGuard();
  const at = run(g, 5, 30000);
  assert.notEqual(at, null, "should have tripped");
  assert.equal(g.tripped, true);
});

test("the grace period protects a slow start", () => {
  const g = new FpsGuard();
  // Terrible throughput, but only during warm-up: no verdict is possible yet.
  for (let t = 0; t < GRACE_MS; t += 500) {
    g.push(t);
    assert.equal(g.check(t), false, `tripped during grace at t=${t}`);
  }
});

test("no verdict until a full window of post-grace history exists", () => {
  const g = new FpsGuard();
  const boundary = GRACE_MS + WINDOW_MS;
  for (let t = 0; t < boundary; t += 500) {
    g.push(t);
    assert.equal(g.check(t), false, `tripped too early at t=${t}`);
  }
});

test("a total stall trips even though push() stops being called", () => {
  const g = new FpsGuard();
  // A healthy start, then frames stop entirely — the compositor is wedged.
  for (let t = 0; t <= 4000; t += 1000 / 30) g.push(t);
  // check() is driven by a timer, so it keeps running with no frames arriving.
  let tripped = false;
  for (let t = 4000; t <= 20000 && !tripped; t += 1000) tripped = g.check(t);
  assert.equal(tripped, true, "a wedged compositor must be caught");
});

test("it trips at most once", () => {
  const g = new FpsGuard();
  const at = run(g, 2, 30000);
  assert.notEqual(at, null);
  // Every later check is silent — the caller already tore the pipeline down.
  for (let t = at + 1000; t < at + 20000; t += 1000) {
    assert.equal(g.check(t), false, `re-tripped at t=${t}`);
  }
});

test("reset re-arms it for a newly chosen effect", () => {
  const g = new FpsGuard();
  assert.notEqual(run(g, 2, 30000), null);
  g.reset();
  assert.equal(g.tripped, false);
  const g2 = new FpsGuard();
  assert.equal(run(g2, 30, 30000), null, "a fresh guard on a healthy feed is quiet");
});

test("thresholds are overridable so callers can tune without editing the module", () => {
  const g = new FpsGuard({ graceMs: 0, windowMs: 1000, minFps: 50 });
  assert.notEqual(run(g, 30, 10000), null, "30fps is below a 50fps floor");
});
