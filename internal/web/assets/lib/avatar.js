// Camera-off avatar: the participant's initial drawn in an IRC-palette colored
// circle. Pure logic (color table, grayscale filter, initial + color derivation)
// lives here so it is unit-testable under `node --test`; applyAvatar is the only
// DOM-touching export. Consumed by ui/grid.js (in-call tiles) and ui/prejoin.js
// (lobby preview).

// The canonical mIRC 0..98 color table. Index === IRC color code. Codes 0,1,14,15
// and the 88..98 ramp are grayscale; they are filtered out below. Reproduced as
// uppercase #rrggbb so tests can match /^#[0-9A-F]{6}$/.
export const IRC_COLORS = [
  "#FFFFFF", "#000000", "#00007F", "#009300", "#FF0000", "#7F0000", "#9C009C", "#FC7F00", // 0-7
  "#FFFF00", "#00FC00", "#009393", "#00FFFF", "#0000FC", "#FF00FF", "#7F7F7F", "#D2D2D2", // 8-15
  "#470000", "#472100", "#474700", "#324700", "#004700", "#00472C", "#004747", "#002747", // 16-23
  "#000047", "#2E0047", "#470047", "#47002A", "#740000", "#743A00", "#747400", "#517400", // 24-31
  "#007400", "#007449", "#007474", "#004074", "#000074", "#4B0074", "#740074", "#740045", // 32-39
  "#B50000", "#B56300", "#B5B500", "#7DB500", "#00B500", "#00B571", "#00B5B5", "#0063B5", // 40-47
  "#0000B5", "#7500B5", "#B500B5", "#B5006B", "#FF0000", "#FF8C00", "#FFFF00", "#B2FF00", // 48-55
  "#00FF00", "#00FFA0", "#00FFFF", "#008CFF", "#0000FF", "#A500FF", "#FF00FF", "#FF0098", // 56-63
  "#FF5959", "#FFB459", "#FFFF71", "#CFFF60", "#6FFF6F", "#65FFC9", "#6BFFFF", "#59B4FF", // 64-71
  "#5959FF", "#C459FF", "#FF66FF", "#FF59BC", "#FF9C9C", "#FFD39C", "#FFFF9C", "#E2FF9C", // 72-79
  "#9CFF9C", "#9CFFDB", "#9CFFFF", "#9CD3FF", "#9C9CFF", "#DC9CFF", "#FF9CFF", "#FF94D3", // 80-87
  "#000000", "#131313", "#282828", "#363636", "#4D4D4D", "#656565", "#818181", "#9F9F9F", // 88-95
  "#BCBCBC", "#E2E2E2", "#FFFFFF", // 96-98
];

// A color is "gray" when its channels are close together. Spread >= 32 (on 0..255)
// keeps every vivid IRC entry and rejects the whole grayscale ramp in one rule.
function isColorful(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return Math.max(r, g, b) - Math.min(r, g, b) >= 32;
}

export const IRC_AVATAR_COLORS = IRC_COLORS.filter(isColorful);

// Neutral fill for the "no name yet" case (only reachable in the lobby). Kept off
// the palette on purpose so tests can assert it is never used for a real nick.
const NEUTRAL_BG = "#555555";

// djb2 string hash over code points -> unsigned 32-bit. Deterministic: same name
// always maps to the same palette slot.
function hash(str) {
  let h = 5381;
  for (const ch of str) h = ((h << 5) + h + ch.codePointAt(0)) >>> 0;
  return h;
}

// Pick #000 or #fff for the letter based on the fill's YIQ luminance, so it stays
// legible on both bright (yellow, aqua) and dark (navy, maroon) fills.
function textColor(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 140 ? "#000000" : "#FFFFFF";
}

export function avatarFor(name) {
  const trimmed = (name || "").trim();
  if (!trimmed) return { initial: "?", bg: NEUTRAL_BG, fg: "#FFFFFF" };
  const initial = [...trimmed][0].toUpperCase();
  const bg = IRC_AVATAR_COLORS[hash(trimmed) % IRC_AVATAR_COLORS.length];
  return { initial, bg, fg: textColor(bg) };
}

// SHA-256 hex of the normalized email, computed in-browser (no MD5 dependency).
// Only this hash is ever sent or stored; the raw email never leaves the client.
// Returns "" for blank input or when SubtleCrypto is unavailable (insecure context).
export async function gravatarHash(email) {
  const e = (email || "").trim().toLowerCase();
  if (!e) return "";
  try {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(e));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return "";
  }
}

// Gravatar image URL for a validated hash. d=404 makes Gravatar 404 for an unknown
// email, which triggers our letter/color fallback rather than Gravatar's own default.
// Returns "" for a malformed hash so a bad value can never build a URL.
export function gravatarUrl(hex, size) {
  if (!/^[a-f0-9]{64}$/.test(hex || "")) return "";
  const s = Number.isFinite(size) && size > 0 ? Math.round(size) : 80;
  return `https://www.gravatar.com/avatar/${hex}?d=404&s=${s}`;
}

// Pixel size to request, scaled for retina and capped.
function gravatarSize() {
  const dpr = typeof devicePixelRatio === "number" && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.min(320, Math.round(160 * dpr));
}

// DOM helper: paint a <span> with the avatar for `name`, then — if `gravatar` is a
// valid hash — swap in the Gravatar image once it loads. The letter/color is painted
// synchronously first, so it is the instant, correct fallback for no-email, no-
// Gravatar (404), offline, or blocked cases. Used by grid.js/prejoin.js.
export function applyAvatar(node, name, gravatar) {
  const { initial, bg, fg } = avatarFor(name);
  node.textContent = initial;
  node.style.background = bg;
  node.style.color = fg;
  node.style.backgroundImage = ""; // drop any prior image (rename / cleared email)
  const token = gravatar || "";
  node.dataset.avatarToken = token; // identity guard for the async load below
  const url = gravatarUrl(token, gravatarSize());
  if (!url) return; // no/invalid hash — letter/color stays
  const img = new Image();
  img.onload = () => {
    if (node.dataset.avatarToken !== token) return; // superseded by a later applyAvatar
    node.style.backgroundImage = `url("${url}")`;
    node.style.backgroundSize = "cover";
    node.style.backgroundPosition = "center";
    node.textContent = ""; // opaque image covers the letter
  };
  img.src = url; // on error (404/offline/blocked) do nothing — fallback already shows
}
