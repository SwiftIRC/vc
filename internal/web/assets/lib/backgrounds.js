// The background-effect catalogue, and the painters that draw the virtual ones.
//
// Backgrounds are drawn in code rather than shipped as image files. That keeps
// the binary from carrying photo assets, sidesteps image licensing entirely, and
// stays sharp at any resolution — the same painter fills a 1080p frame and a
// 48x27 picker thumbnail, so a chip is always an exact preview of the effect.
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
  const pitch = Math.max(4, w / 24); // Floor to prevent pathological density at very small widths
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
