// Decoded bitmaps for the photographic backgrounds (backgrounds.js, kind
// "image"), memoised per src.
//
// Kept out of backgrounds.js on purpose: that module is pure, and its tests
// enforce that painters are deterministic and free of side effects. Network I/O
// there would undermine the property those tests exist to protect.
//
// The contract callers depend on: this NEVER rejects. A missing or corrupt asset
// resolves null, the compositor keeps drawing the effect's fallback colour, and
// the call survives with a degraded background instead of a dropped one. A throw
// would surface in the frame loop, where the watchdog reads consecutive failures
// as the effect being broken and turns the background off.

// src -> Promise<ImageBitmap|null>. The PROMISE is cached, not the bitmap, so
// concurrent callers share one in-flight request. A resolved null stays cached:
// the compositor asks on every effect switch and the picker on every render, so
// retrying a dead asset would turn one missing file into a request storm.
const cache = new Map();

export function loadBackgroundImage(src) {
  if (!src) return Promise.resolve(null);
  const cached = cache.get(src);
  if (cached) return cached;
  const pending = fetch(src)
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.blob();
    })
    .then((blob) => createImageBitmap(blob))
    .catch((err) => {
      // Once, not per frame: the cached null means we never get here again for
      // this src.
      console.warn(`background image ${src} could not be loaded:`, err);
      return null;
    });
  cache.set(src, pending);
  return pending;
}

// Tests only: drop every cached bitmap and in-flight request.
export function _resetImageCacheForTests() {
  cache.clear();
}
