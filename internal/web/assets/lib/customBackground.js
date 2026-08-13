// A background the user supplies from their own device.
//
// The image never leaves the browser. It is decoded locally, composited into the
// outgoing camera frames like any other scene, and it is the COMPOSITE that gets
// encoded and published — so remote participants see the background as part of your
// video without a byte of it being uploaded, stored on the server, or shown to
// anyone whose client did not already have your camera. Nothing about the wire
// protocol changes to support this.
//
// Everything here is browser-only except fitWithin and isSupportedImage, which are
// pure and carry the decisions worth pinning in tests.

import { loadCustomBackground, saveCustomBackground } from "./prefs.js";

// The effect id. Written to localStorage as the selected background, so it is a
// contract in the same way the built-in ids are.
export const CUSTOM_ID = "custom";

// Downscale target: the same 1280x720 the shipped scenes use. A decoded ImageBitmap
// is raw RGBA held for the life of the page and read on every composited frame, so
// an unshrunk 4032x3024 phone photo would cost ~48 MB and roughly ten times what a
// built-in scene costs, for no visible gain at call resolutions.
const MAX_W = 1280;
const MAX_H = 720;

// Refuse before decoding rather than after. A file this large is either a mistake
// or a decode that will stall the tab.
const MAX_BYTES = 32 * 1024 * 1024;

// SVG is excluded deliberately: it is scriptable content rather than a bitmap, and
// a still backdrop gains nothing from it.
const ACCEPTED = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif", "image/bmp"]);

// The MIME types the file input advertises, kept in step with ACCEPTED.
export const ACCEPT_ATTR = [...ACCEPTED].join(",");

// The largest w x h fitting inside the box while preserving aspect ratio. Never
// enlarges: scaling a small image up costs memory and gains no detail, and the
// compositor's cover-fit already scales it to the frame at draw time — from the
// smaller source, which is cheaper and looks identical. Returns null for input it
// cannot use, so callers fall back rather than build a 0x0 or NaN-sized canvas.
export function fitWithin(sw, sh, maxW, maxH) {
  if (!(sw > 0) || !(sh > 0) || !(maxW > 0) || !(maxH > 0)) return null;
  const scale = Math.min(1, maxW / sw, maxH / sh);
  return { width: Math.max(1, Math.round(sw * scale)), height: Math.max(1, Math.round(sh * scale)) };
}

// Whether a picked File is something worth trying to decode.
export function isSupportedImage(file) {
  if (!file || typeof file.type !== "string") return false;
  if (!ACCEPTED.has(file.type)) return false;
  return typeof file.size === "number" && file.size > 0 && file.size <= MAX_BYTES;
}

// The current custom background as a URL the loader can fetch, or "" when none is
// set. A data: URL, not a blob: URL — blob URLs die with the document, so the same
// value can be handed to the image loader AND written to storage, and a reload
// restores what the user chose instead of silently losing it.
let currentSrc = "";

export function customBackgroundSrc() {
  return currentSrc;
}

export function hasCustomBackground() {
  return currentSrc !== "";
}

// Restore a previously chosen background. Called once at startup; safe to call when
// nothing was saved.
export function restoreCustomBackground() {
  const saved = loadCustomBackground();
  if (typeof saved === "string" && saved.startsWith("data:image/")) currentSrc = saved;
  return currentSrc;
}

// Decode, downscale, and adopt a picked file. Resolves with the new src, or throws
// with a message meant for the user — the caller shows it rather than logging it,
// because a background that silently does not appear is the worst outcome.
export async function setCustomBackground(file) {
  if (!isSupportedImage(file)) {
    throw new Error("That file isn't a supported image (PNG, JPEG, WebP, GIF, AVIF or BMP, under 32 MB).");
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("That image couldn't be decoded.");
  }
  try {
    const box = fitWithin(bitmap.width, bitmap.height, MAX_W, MAX_H);
    if (!box) throw new Error("That image has no usable dimensions.");
    const canvas = document.createElement("canvas");
    canvas.width = box.width;
    canvas.height = box.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This browser can't process images.");
    ctx.drawImage(bitmap, 0, 0, box.width, box.height);
    // JPEG rather than PNG: a photographic backdrop compresses an order of
    // magnitude smaller, which is what keeps the stored copy inside the
    // localStorage quota. Quality 0.85 is indistinguishable behind a subject.
    const src = canvas.toDataURL("image/jpeg", 0.85);
    currentSrc = src;
    // Persistence is best-effort. Exceeding the quota costs the NEXT session's
    // restore, not this one's background, so it must not fail the whole operation.
    saveCustomBackground(src);
    return src;
  } finally {
    // Release the full-size decode as soon as the downscaled copy exists; without
    // this the original stays resident for the life of the page.
    if (typeof bitmap.close === "function") bitmap.close();
  }
}

export function clearCustomBackground() {
  currentSrc = "";
  saveCustomBackground("");
}
