import { test } from "node:test";
import assert from "node:assert/strict";
import { qualityTier } from "../assets/lib/quality.js";
import { encodingCaps } from "../assets/lib/quality.js";

// scaleResolutionDownBy is a DIVISOR applied to the source, not a target height, so
// it has to be derived from what the camera is actually producing. Getting this
// backwards is invisible in code review and produces a picture that never changes.
test("a tier below the source scales it down by the right divisor", () => {
  assert.deepEqual(encodingCaps(qualityTier("low"), 720), { scaleResolutionDownBy: 2, maxFramerate: 15 });
  assert.deepEqual(encodingCaps(qualityTier("medium"), 960), { scaleResolutionDownBy: 2, maxFramerate: 24 });
  assert.deepEqual(encodingCaps(qualityTier("high"), 1080), { scaleResolutionDownBy: 1.5, maxFramerate: 30 });
});

// Never upscale. A 480p camera asked for 1080p must send 480p, not a divisor below
// 1 — which browsers reject or ignore, and which would gain nothing regardless.
test("a tier above the source never enlarges it", () => {
  assert.deepEqual(encodingCaps(qualityTier("ultra"), 480), { scaleResolutionDownBy: 1, maxFramerate: 30 });
  assert.deepEqual(encodingCaps(qualityTier("high"), 360), { scaleResolutionDownBy: 1, maxFramerate: 30 });
});

// Auto means no cap at all: divisor 1 and the framerate limit REMOVED, not set to
// zero. maxFramerate:0 would be a request for no frames.
test("auto removes every cap", () => {
  const caps = encodingCaps(qualityTier("auto"), 720);
  assert.equal(caps.scaleResolutionDownBy, 1);
  assert.equal(caps.maxFramerate, undefined, "auto must clear the limit, never set 0");
});

// The published camera track is a canvas capture whenever a background effect is
// running, and a canvas track need not report dimensions. With no source height the
// framerate cap must still apply — dropping both because one is unknown is what
// makes a tier change look like it did nothing.
test("an unknown source height still applies the framerate cap", () => {
  for (const h of [0, undefined, null, NaN]) {
    const caps = encodingCaps(qualityTier("low"), h);
    assert.equal(caps.scaleResolutionDownBy, 1, `h=${h} must not guess a divisor`);
    assert.equal(caps.maxFramerate, 15, `h=${h} dropped the framerate cap too`);
  }
});

test("an unknown tier is treated as auto rather than throwing", () => {
  const caps = encodingCaps(qualityTier("nonsense"), 720);
  assert.equal(caps.scaleResolutionDownBy, 1);
  assert.equal(caps.maxFramerate, undefined);
});

// The divisor is a float; browsers accept non-integers, but a NaN or Infinity would
// make setParameters reject and take the framerate cap down with it.
test("the divisor is always a usable finite number >= 1", () => {
  for (const [tier, h] of [["low", 1], ["ultra", 100000], ["medium", 361], ["high", 720]]) {
    const { scaleResolutionDownBy: s } = encodingCaps(qualityTier(tier), h);
    assert.ok(Number.isFinite(s) && s >= 1, `${tier}@${h} produced ${s}`);
  }
});
