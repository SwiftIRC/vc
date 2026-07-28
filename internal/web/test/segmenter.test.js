import { test } from "node:test";
import assert from "node:assert/strict";
import { webglAvailable } from "../assets/lib/segmenter.js";

// Regression tests for a real production failure: on a browser with no usable
// WebGL context, the background effect threw
//   "Cannot read properties of undefined (reading 'activeTexture')"
// once per frame, forever.
//
// Two things made it hard to see. First, MediaPipe will not report it:
// emscripten's GL.createContext returns handle 0 when getContext() yields null,
// and makeContextCurrent(0) returns `!(contextHandle && !GLctx)` — `true` for
// handle 0 — so a FAILED acquisition is reported as SUCCESS with GLctx left
// undefined. createFromOptions resolves and nothing rejects.
//
// Second, `delegate: "CPU"` does NOT avoid it. That setting only selects where
// TFLite inference runs; MediaPipe's vision GraphRunner is GL-based either way,
// so the CPU delegate throws from glActiveTexture just the same. Verified in
// production: "30 consecutive frame failures on the CPU delegate", alongside
// MediaPipe's own "Couldn't create webGL 1 context".
//
// So WebGL is a hard precondition, and webglAvailable() is how start() checks it
// before building anything. The canvas factory is injectable precisely so this
// is testable without a DOM.

function fakeCanvas(contexts) {
  return { getContext: (name) => contexts[name] || null };
}

test("reports available when webgl2 is obtainable", () => {
  const gl = { getExtension: () => null };
  assert.equal(webglAvailable(() => fakeCanvas({ webgl2: gl })), true);
});

test("falls back to webgl1 when webgl2 is unavailable", () => {
  const gl = { getExtension: () => null };
  assert.equal(webglAvailable(() => fakeCanvas({ webgl: gl })), true);
});

// This is the production failure exactly: the user's console reported
// "webgl2: false | webgl: false".
test("reports unavailable when no context can be obtained", () => {
  assert.equal(webglAvailable(() => fakeCanvas({})), false);
});

test("a getContext that throws is treated as unavailable, not propagated", () => {
  // Some policy-disabled configurations throw rather than returning null. This
  // must not take down the whole pipeline build.
  const canvas = {
    getContext() {
      throw new Error("WebGL is disabled");
    },
  };
  assert.equal(webglAvailable(() => canvas), false);
});

test("a createCanvas that throws is treated as unavailable", () => {
  assert.equal(
    webglAvailable(() => {
      throw new Error("no document");
    }),
    false,
  );
});

// Browsers cap live WebGL contexts (~16 in Chrome). Silently consuming one per
// pipeline build just to answer a yes/no question would be its own leak — and
// context exhaustion is one of the ways the original bug is reached.
test("releases the probe context so the check does not consume one", () => {
  let released = 0;
  const gl = {
    getExtension: (name) => (name === "WEBGL_lose_context" ? { loseContext: () => released++ } : null),
  };
  assert.equal(webglAvailable(() => fakeCanvas({ webgl2: gl })), true);
  assert.equal(released, 1);
});

test("still reports available when the release extension is missing", () => {
  // WEBGL_lose_context is not universally implemented; its absence must not be
  // mistaken for WebGL being unavailable.
  const gl = { getExtension: () => null };
  assert.equal(webglAvailable(() => fakeCanvas({ webgl2: gl })), true);
});

test("survives a context object with no getExtension at all", () => {
  assert.equal(webglAvailable(() => fakeCanvas({ webgl2: {} })), true);
});
