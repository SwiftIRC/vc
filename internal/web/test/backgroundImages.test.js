import { test } from "node:test";
import assert from "node:assert/strict";
import { loadBackgroundImage, _resetImageCacheForTests } from "../assets/lib/backgroundImages.js";

// Node has neither fetch-of-a-blob nor createImageBitmap in the shape we need, so
// both are stubbed. install() also silences console.warn, which the failure path
// uses deliberately, and restores everything after the test.
function install(t, { fetchImpl } = {}) {
  const prev = { fetch: globalThis.fetch, cib: globalThis.createImageBitmap, warn: console.warn };
  const fetches = [];
  globalThis.fetch = (src) => {
    fetches.push(src);
    return fetchImpl ? fetchImpl(src) : Promise.resolve({ ok: true, blob: () => Promise.resolve({ src }) });
  };
  globalThis.createImageBitmap = (blob) => Promise.resolve({ width: 1280, height: 720, of: blob.src });
  console.warn = () => {};
  _resetImageCacheForTests();
  t.after(() => {
    globalThis.fetch = prev.fetch;
    globalThis.createImageBitmap = prev.cib;
    console.warn = prev.warn;
    _resetImageCacheForTests();
  });
  return { fetches };
}

test("a successful load resolves an ImageBitmap", async (t) => {
  install(t);
  const bmp = await loadBackgroundImage("img/carina.webp");
  assert.equal(bmp.width, 1280);
  assert.equal(bmp.of, "img/carina.webp");
});

test("concurrent calls for one src share a single fetch", async (t) => {
  const { fetches } = install(t);
  const [a, b, c] = await Promise.all([
    loadBackgroundImage("img/carina.webp"),
    loadBackgroundImage("img/carina.webp"),
    loadBackgroundImage("img/carina.webp"),
  ]);
  assert.equal(fetches.length, 1, "the loader re-fetched a src already in flight");
  assert.equal(a, b);
  assert.equal(b, c);
});

test("a later call reuses the cached bitmap", async (t) => {
  const { fetches } = install(t);
  const first = await loadBackgroundImage("img/carina.webp");
  const second = await loadBackgroundImage("img/carina.webp");
  assert.equal(fetches.length, 1);
  assert.equal(first, second);
});

test("a rejected fetch resolves null instead of throwing", async (t) => {
  install(t, { fetchImpl: () => Promise.reject(new Error("offline")) });
  // A throw here would reach the compositor's frame loop, where the watchdog would
  // read it as the effect failing and drop the background.
  assert.equal(await loadBackgroundImage("img/carina.webp"), null);
});

test("a non-ok response resolves null", async (t) => {
  install(t, { fetchImpl: () => Promise.resolve({ ok: false, status: 404 }) });
  assert.equal(await loadBackgroundImage("img/missing.webp"), null);
});

test("a decode failure resolves null", async (t) => {
  install(t);
  globalThis.createImageBitmap = () => Promise.reject(new Error("corrupt"));
  assert.equal(await loadBackgroundImage("img/carina.webp"), null);
});

test("a failure is not retried", async (t) => {
  const { fetches } = install(t, { fetchImpl: () => Promise.reject(new Error("offline")) });
  assert.equal(await loadBackgroundImage("img/carina.webp"), null);
  assert.equal(await loadBackgroundImage("img/carina.webp"), null);
  // The compositor asks per effect switch and the picker per render; retrying a
  // dead asset would turn one missing file into a request storm.
  assert.equal(fetches.length, 1, "a failed load was retried");
});

test("an empty src resolves null without fetching", async (t) => {
  const { fetches } = install(t);
  assert.equal(await loadBackgroundImage(""), null);
  assert.equal(await loadBackgroundImage(undefined), null);
  assert.equal(fetches.length, 0);
});
