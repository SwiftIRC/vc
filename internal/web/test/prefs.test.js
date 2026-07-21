import { test } from "node:test";
import assert from "node:assert/strict";
import { loadMediaPrefs, saveMediaPrefs } from "../assets/lib/prefs.js";

// Node has no localStorage; install a minimal stub before each test. prefs.js reads
// globalThis.localStorage at CALL time, so re-stubbing per test is enough.
function stubStorage() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  return store;
}

test("loadMediaPrefs is empty when nothing is stored", () => {
  stubStorage();
  assert.deepEqual(loadMediaPrefs(), {});
});

test("saveMediaPrefs round-trips and merges partial updates", () => {
  stubStorage();
  saveMediaPrefs({ mic: false });
  assert.deepEqual(loadMediaPrefs(), { mic: false });
  saveMediaPrefs({ camera: false }); // must not clobber mic
  assert.deepEqual(loadMediaPrefs(), { mic: false, camera: false });
  saveMediaPrefs({ mic: true }); // overwrites just mic
  assert.deepEqual(loadMediaPrefs(), { mic: true, camera: false });
});

test("malformed stored JSON is ignored, not thrown", () => {
  const store = stubStorage();
  store.set("swiftirc-vc-media", "not json{");
  assert.deepEqual(loadMediaPrefs(), {});
});

test("storage that throws never propagates", () => {
  globalThis.localStorage = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
  };
  assert.deepEqual(loadMediaPrefs(), {});
  assert.doesNotThrow(() => saveMediaPrefs({ mic: false }));
});
