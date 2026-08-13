import { test } from "node:test";
import assert from "node:assert/strict";
import { fitWithin, isSupportedImage, CUSTOM_ID } from "../assets/lib/customBackground.js";

// An uploaded photo is whatever the user's phone produced. Decoded, an ImageBitmap
// is raw RGBA — a 4032x3024 photo is ~48 MB resident, held for the life of the page
// and drawn on every composited frame. Downscaling to the same 1280x720 the shipped
// scenes use is what keeps a custom background from costing an order of magnitude
// more than a built-in one.
test("fitWithin shrinks to the box and keeps the aspect ratio", () => {
  assert.deepEqual(fitWithin(4032, 3024, 1280, 720), { width: 960, height: 720 });
  assert.deepEqual(fitWithin(3000, 1000, 1280, 720), { width: 1280, height: 427 });
  assert.deepEqual(fitWithin(1000, 4000, 1280, 720), { width: 180, height: 720 });
});

// Never scale UP: a small image blown up to 1280x720 costs memory and gains no
// detail, and the compositor's cover-fit already scales it to the frame at draw
// time — from the smaller source, which is cheaper and looks identical.
test("fitWithin never enlarges a small image", () => {
  assert.deepEqual(fitWithin(640, 360, 1280, 720), { width: 640, height: 360 });
  assert.deepEqual(fitWithin(100, 100, 1280, 720), { width: 100, height: 100 });
});

test("fitWithin passes through an image already at the box size", () => {
  assert.deepEqual(fitWithin(1280, 720, 1280, 720), { width: 1280, height: 720 });
});

// Degenerate input must not produce a 0x0 canvas (drawImage into one throws) or a
// NaN dimension. One pixel is the floor.
test("fitWithin never returns a zero or fractional dimension", () => {
  for (const [w, h] of [[1, 100000], [100000, 1], [1, 1], [3, 7]]) {
    const r = fitWithin(w, h, 1280, 720);
    assert.ok(Number.isInteger(r.width) && r.width >= 1, `width ${r.width} for ${w}x${h}`);
    assert.ok(Number.isInteger(r.height) && r.height >= 1, `height ${r.height} for ${w}x${h}`);
  }
});

test("fitWithin rejects unusable dimensions rather than returning NaN", () => {
  for (const args of [[0, 720], [1280, 0], [NaN, 720], [undefined, 720]]) {
    assert.equal(fitWithin(...args, 1280, 720), null, `fitWithin(${args}) should be null`);
  }
});

// The file comes from a native picker, so the type is whatever the OS reported. A
// non-image would reach createImageBitmap and reject, which the pipeline survives
// (black background) but which tells the user nothing — better to refuse it here.
test("isSupportedImage accepts images and refuses everything else", () => {
  assert.equal(isSupportedImage({ type: "image/png", size: 1000 }), true);
  assert.equal(isSupportedImage({ type: "image/jpeg", size: 1000 }), true);
  assert.equal(isSupportedImage({ type: "image/webp", size: 1000 }), true);
  assert.equal(isSupportedImage({ type: "video/mp4", size: 1000 }), false);
  assert.equal(isSupportedImage({ type: "application/pdf", size: 1000 }), false);
  assert.equal(isSupportedImage({ type: "", size: 1000 }), false);
  assert.equal(isSupportedImage(null), false);
  assert.equal(isSupportedImage(undefined), false);
});

// An animated GIF or SVG would decode to a single frame or drag in scriptable
// content; neither is worth supporting for a still backdrop.
test("isSupportedImage refuses SVG", () => {
  assert.equal(isSupportedImage({ type: "image/svg+xml", size: 1000 }), false);
});

test("isSupportedImage refuses an empty or absurd file before decoding it", () => {
  assert.equal(isSupportedImage({ type: "image/png", size: 0 }), false);
  assert.equal(isSupportedImage({ type: "image/png", size: 80 * 1024 * 1024 }), false);
});

// The id is written to localStorage as the selected effect, so it is a contract in
// the same way the built-in ids are.
test("the custom effect id is stable", () => {
  assert.equal(CUSTOM_ID, "custom");
});
