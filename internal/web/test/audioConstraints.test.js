import { test } from "node:test";
import assert from "node:assert/strict";
import { micConstraints } from "../assets/lib/audioConstraints.js";

// The point of this file: echo cancellation must be REQUESTED, not inherited. It
// was previously left to the browser default at both acquisition sites, so nothing
// in the codebase said a call needs it and nothing would notice if a browser
// changed its mind.
test("echo cancellation and gain control are always requested", () => {
  for (const c of [micConstraints(), micConstraints("dev-1"), micConstraints("dev-1", { exact: true })]) {
    assert.equal(c.echoCancellation, true);
    assert.equal(c.autoGainControl, true);
  }
});

// Deliberate, and the reason is in the module comment: this app runs its own
// RNNoise worklet, so pinning the browser's suppressor on would double-process and
// pinning it off would strip suppression from anyone who disables the worklet.
// Neither is defensible without measurement, so the browser default stands.
test("noiseSuppression is left to the browser", () => {
  assert.equal("noiseSuppression" in micConstraints(), false);
  assert.equal("noiseSuppression" in micConstraints("dev-1"), false);
});

test("no device id means no deviceId constraint at all", () => {
  for (const id of [undefined, null, ""]) {
    assert.equal("deviceId" in micConstraints(id), false, `id ${JSON.stringify(id)} produced a deviceId`);
  }
});

// ideal for the initial capture (a since-removed device falls back to the default
// rather than failing), exact for a deliberate switch (silently landing on a
// different device would be a bug, not a fallback).
test("a device id is ideal by default and exact on request", () => {
  assert.deepEqual(micConstraints("dev-1").deviceId, { ideal: "dev-1" });
  assert.deepEqual(micConstraints("dev-1", { exact: true }).deviceId, { exact: "dev-1" });
});

test("the result is a fresh object each call", () => {
  const a = micConstraints("dev-1");
  const b = micConstraints("dev-1");
  assert.notEqual(a, b, "callers mutate constraints objects; sharing one would leak between captures");
  assert.deepEqual(a, b);
});
