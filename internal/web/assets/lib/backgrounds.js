// The background-effect catalogue: the painters that draw the procedural
// backgrounds, and the entries describing the photographic ones.
//
// Two kinds of virtual background live here, with different properties.
//
// PAINTED backgrounds are drawn in code. They cost no bytes in the binary, carry
// no licensing, and are resolution-independent — the same painter fills a 1080p
// frame and a 48x27 picker thumbnail, so a chip is an exact preview of the effect.
//
// IMAGE backgrounds (kind "image") are WebP assets under assets/img/, embedded in
// the binary and described here by `src` plus `fallback`. They give up all three
// of those properties: ~339K of payload, third-party imagery (see
// assets/img/README.md), and a fixed 1280x720 that upscales on a 1080p camera and
// says little at chip size. They buy recognisable scenes, which no painter can.
// The catalogue holds both; only painters are bound by the rules below.
//
// Every painter must:
//   - fill the ENTIRE (w, h) rect, or the real camera shows through at the edges;
//   - be deterministic — no Math.random, or the background shimmers frame to
//     frame, which reads as a glitch;
//   - restore any global context state it changed, since the compositor reuses
//     one context.
// All three are enforced by test/backgrounds.test.js.
//
// Sizes are expressed as fractions of w/h for the same reason: a pixel constant
// tuned at 720p looks wrong at 480p and invisible in a thumbnail.

// --- painter helpers ---

function fill(ctx, w, h, color) {
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, h);
}

// A soft radial wash placed at (x, y) as a fraction of the frame, with radius r
// as a fraction of the frame's longer side.
function glow(ctx, w, h, { x, y, r, from, to }) {
  const cx = w * x;
  const cy = h * y;
  const radius = Math.max(w, h) * r;
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
  g.addColorStop(0, from);
  g.addColorStop(1, to);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

// The source rectangle that fills a dw x dh target completely with a centre crop
// and no distortion — the "cover" fit. Needed because the image assets are 16:9
// but a camera frame may be 4:3, and the picker's chip is 48x27.
//
// Returns null when any dimension fails `> 0` — which non-finite values do too,
// except +Infinity (unreachable in practice: ImageBitmap.width/height are an
// unsigned long, so a real bitmap can never hand this a non-finite size).
//
// The null signal matters because of what a zero-sized or non-finite source
// rect does to drawImage: per the current spec it does NOT throw, it silently
// returns without drawing anything. That is worse than a throw here, because
// drawImageBackground only fills the fallback colour when coverRect returns
// falsy — so a garbage-but-truthy rect would draw nothing AND skip the fill,
// leaving the frame uncovered and the raw camera showing through underneath.
// That is exactly the failure this code exists to prevent.
export function coverRect(sw, sh, dw, dh) {
  if (!(sw > 0) || !(sh > 0) || !(dw > 0) || !(dh > 0)) return null;
  const scale = Math.max(dw / sw, dh / sh); // whichever axis needs more growth wins
  const cw = Math.min(sw, dw / scale);
  const ch = Math.min(sh, dh / scale);
  return { sx: (sw - cw) / 2, sy: (sh - ch) / 2, sw: cw, sh: ch };
}

// Draw an image background: the bitmap cover-fit into the frame, or the effect's
// fallback colour when it is not (yet) available. Returns whether the bitmap was
// drawn, so a caller that wants to redraw once it arrives can tell.
//
// The fallback branch is load-bearing, not cosmetic. An image effect is applied
// SYNCHRONOUSLY while its bitmap is still decoding, so for the first frame or two
// this is the only thing standing between the subject and a composited raw camera
// frame. It must fill the entire rect, exactly as a painter must.
export function drawImageBackground(ctx, bitmap, fallback, w, h) {
  const rect = bitmap && coverRect(bitmap.width, bitmap.height, w, h);
  if (!rect) {
    fill(ctx, w, h, fallback);
    return false;
  }
  ctx.drawImage(bitmap, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, w, h);
  return true;
}

// --- painters ---

// Deep night sky with additive colour washes.
export function paintAurora(ctx, w, h) {
  fill(ctx, w, h, "#0d1b2a");
  ctx.globalCompositeOperation = "lighter"; // washes add, rather than occlude
  glow(ctx, w, h, { x: 0.25, y: 0.3, r: 0.75, from: "rgba(80, 60, 190, 0.85)", to: "rgba(80, 60, 190, 0)" });
  glow(ctx, w, h, { x: 0.75, y: 0.65, r: 0.7, from: "rgba(32, 150, 160, 0.75)", to: "rgba(32, 150, 160, 0)" });
  glow(ctx, w, h, { x: 0.55, y: 0.15, r: 0.55, from: "rgba(150, 70, 200, 0.55)", to: "rgba(150, 70, 200, 0)" });
  ctx.globalCompositeOperation = "source-over"; // never leave this set
}

// A warm horizon, darkest at the top so a face stays the brightest thing on screen.
export function paintDusk(ctx, w, h) {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "#141a2e");
  g.addColorStop(0.55, "#3a2b4a");
  g.addColorStop(0.82, "#8a4a46");
  g.addColorStop(1, "#c9764a");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

// The app's own dark ground with a faint accent dot grid, vignetted so the dots
// fall away at the edges and never compete with the subject.
export function paintGrid(ctx, w, h) {
  fill(ctx, w, h, "#14161a"); // --bg
  if (w <= 0 || h <= 0) return; // Degenerate frame: skip the dot grid
  // Pitch is floored to Math.max(4, w / 24) to prevent pathological call counts
  // (w=1 would generate ~1.7M draw calls). This means narrow frames (< 96px wide)
  // show a sparser grid than the design intent: a 48×27 thumbnail gets 84 dots
  // instead of 312. The trade-off is load-bearing against render hangs.
  const pitch = Math.max(4, w / 24);
  const r = Math.max(0.5, pitch * 0.06);
  ctx.fillStyle = "rgba(76, 141, 255, 0.22)"; // --accent, well faded
  for (let y = pitch / 2; y < h; y += pitch) {
    for (let x = pitch / 2; x < w; x += pitch) {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  glow(ctx, w, h, { x: 0.5, y: 0.5, r: 0.8, from: "rgba(20, 22, 26, 0)", to: "rgba(20, 22, 26, 0.85)" });
}

// A single accent-tinted pool of light behind the head, heavily vignetted.
export function paintDepth(ctx, w, h) {
  fill(ctx, w, h, "#0f1116");
  glow(ctx, w, h, { x: 0.5, y: 0.42, r: 0.62, from: "rgba(76, 141, 255, 0.42)", to: "rgba(76, 141, 255, 0)" });
  glow(ctx, w, h, { x: 0.5, y: 0.5, r: 0.95, from: "rgba(15, 17, 22, 0)", to: "rgba(15, 17, 22, 0.9)" });
}

// A light neutral, for anyone in a bright room where the dark options look odd.
export function paintPaper(ctx, w, h) {
  const g = ctx.createLinearGradient(0, 0, w * 0.3, h);
  g.addColorStop(0, "#f4f1ea");
  g.addColorStop(1, "#dcd6c8");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  glow(ctx, w, h, { x: 0.5, y: 0.5, r: 0.9, from: "rgba(120, 110, 90, 0)", to: "rgba(120, 110, 90, 0.28)" });
}

// --- the catalogue ---

// Blur radii are fractions of frame WIDTH, so a given strength looks the same at
// 480p and 1080p. A pixel constant would be a wall at one resolution and barely
// visible at another.
export const EFFECTS = Object.freeze([
  Object.freeze({ id: "none", label: "None", kind: "none" }),
  Object.freeze({ id: "blur", label: "Blur", kind: "blur", radius: 0.012 }),
  Object.freeze({ id: "blur-strong", label: "Blur+", kind: "blur", radius: 0.03 }),
  Object.freeze({ id: "aurora", label: "Aurora", kind: "paint", paint: paintAurora }),
  Object.freeze({ id: "dusk", label: "Dusk", kind: "paint", paint: paintDusk }),
  Object.freeze({ id: "grid", label: "Grid", kind: "paint", paint: paintGrid }),
  Object.freeze({ id: "depth", label: "Depth", kind: "paint", paint: paintDepth }),
  Object.freeze({ id: "paper", label: "Paper", kind: "paint", paint: paintPaper }),
  // Photographic scenes. Unlike a painter these are assets: they need decoding
  // before first use, they are not resolution-independent, and `fallback` — the
  // image's own average colour — is what covers the frame until the bitmap lands.
  //
  // `src` is resolved against THIS MODULE's URL, not written as a plain relative
  // string, on purpose: `loadBackgroundImage` hands it straight to `fetch()`,
  // which resolves a relative URL against `document.baseURI` — the PAGE's path,
  // not this file's. The app's router serves the SPA shell for any unknown path,
  // so a room URL with a trailing slash (e.g. `/lobby/`) would turn `img/foo.webp`
  // into a request for `/lobby/img/foo.webp`, which 200s with HTML instead of
  // 404ing — `res.ok` is true, `createImageBitmap` then rejects on the HTML blob,
  // and the failure is cached as a permanent `null`. Every scene becomes a flat
  // fallback colour for the rest of the page's life. `new URL(..., import.meta.url)`
  // resolves against this module's own versioned URL instead, which is stable
  // regardless of what page embedded it. Do not "simplify" this back to a bare
  // string.
  Object.freeze({ id: "office-space", label: "Office Space", kind: "image", src: new URL("../img/office-space.webp", import.meta.url).href, fallback: "#585454" }),
  Object.freeze({ id: "space-ghost", label: "Space Ghost", kind: "image", src: new URL("../img/space-ghost.webp", import.meta.url).href, fallback: "#675364" }),
  Object.freeze({ id: "star-trek", label: "Star Trek", kind: "image", src: new URL("../img/star-trek.webp", import.meta.url).href, fallback: "#7D705E" }),
  Object.freeze({ id: "idiocracy", label: "Idiocracy", kind: "image", src: new URL("../img/idiocracy.webp", import.meta.url).href, fallback: "#3E3524" }),
  Object.freeze({ id: "carina", label: "Carina", kind: "image", src: new URL("../img/carina.webp", import.meta.url).href, fallback: "#614E54" }),
]);

// The picker's two rows. Derived from `kind` rather than a field on each entry —
// there is exactly one rule ("photos are scenes") and duplicating it per entry
// would just be a second place to get it wrong. A test asserts this partitions
// EFFECTS exactly, so an entry cannot go missing from the UI by being appended to
// EFFECTS alone.
export const GROUPS = Object.freeze([
  Object.freeze({
    id: "effect",
    label: "Effects",
    effects: Object.freeze(EFFECTS.filter((e) => e.kind !== "image")),
  }),
  Object.freeze({
    id: "scene",
    label: "Scenes",
    effects: Object.freeze(EFFECTS.filter((e) => e.kind === "image")),
  }),
]);

// The saved-preference gate. Effect ids live in localStorage, so a rename, a
// downgrade, or a hand-edited value can all present an id this build has never
// heard of. Resolve to "none" rather than throwing or leaving the pipeline in an
// undefined state — the worst outcome should be "no effect", never "no camera".
export function resolveEffectId(id) {
  return EFFECTS.some((e) => e.id === id) ? id : "none";
}

// Always returns a catalogue entry, so callers never guard for undefined.
export function effectById(id) {
  const wanted = resolveEffectId(id);
  return EFFECTS.find((e) => e.id === wanted) || EFFECTS[0];
}
