import { test } from "node:test";
import assert from "node:assert/strict";
import { IRC_COLORS, IRC_AVATAR_COLORS, avatarFor } from "../assets/lib/avatar.js";

// The known grayscale codes in the mIRC spec: white/black/grey/light-grey and the
// 88..98 black->white ramp. None of them may survive into the avatar palette.
const GRAY_CODES = [0, 1, 14, 15, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98];

test("IRC_COLORS has all 99 codes as #rrggbb", () => {
  assert.equal(IRC_COLORS.length, 99);
  for (const c of IRC_COLORS) assert.match(c, /^#[0-9A-F]{6}$/);
});

test("IRC_AVATAR_COLORS drops every grayscale code and keeps a rich set", () => {
  for (const code of GRAY_CODES) {
    assert.ok(!IRC_AVATAR_COLORS.includes(IRC_COLORS[code]), `gray code ${code} leaked`);
  }
  // Every surviving color is actually colorful (max-min channel spread >= 32).
  for (const hex of IRC_AVATAR_COLORS) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    assert.ok(Math.max(r, g, b) - Math.min(r, g, b) >= 32, `${hex} is too gray`);
  }
  assert.ok(IRC_AVATAR_COLORS.length >= 50, "expected a large colorful palette");
});

test("avatarFor is deterministic per name", () => {
  for (const n of ["alice", "mallory"]) {
    const a = avatarFor(n), b = avatarFor(n);
    assert.equal(a.bg, b.bg);
    assert.equal(a.fg, b.fg);
    assert.equal(a.initial, b.initial);
  }
});

test("avatarFor pins known name->color mappings (guards 'stable per nick')", () => {
  // Snapshot of the real hash->palette mapping. If djb2, the palette order, or the
  // grayscale threshold change, these break — which is the point: a silent recolor of
  // every user must fail a test.
  assert.equal(avatarFor("alice").bg, "#59B4FF");
  assert.equal(avatarFor("alice").fg, "#000000");
  assert.equal(avatarFor("bob").bg, "#000074");
  assert.equal(avatarFor("bob").fg, "#FFFFFF");
  assert.equal(avatarFor("eve").bg, "#FC7F00");
});

test("avatarFor uses the uppercased first code point as the initial", () => {
  assert.equal(avatarFor("alice").initial, "A");
  assert.equal(avatarFor("  bob ").initial, "B"); // trims
  assert.equal(avatarFor(" Álvaro").initial, "Á"); // accented
  assert.equal(avatarFor("🦊fox").initial, "🦊"); // no split surrogate pair
});

test("blank name yields a neutral '?' avatar", () => {
  const a = avatarFor("   ");
  assert.equal(a.initial, "?");
  assert.equal(a.bg, "#555555");
  assert.ok(!IRC_AVATAR_COLORS.includes(a.bg), "blank fallback must not be a palette color");
});

test("bg is always drawn from the colorful palette for real names", () => {
  for (const n of ["alice", "bob", "carol", "dave", "eve", "mallory"]) {
    assert.ok(IRC_AVATAR_COLORS.includes(avatarFor(n).bg), `${n} bg off-palette`);
  }
});

test("avatarFor picks a legible fg for the bg it chose", () => {
  // Exercise the real function: for whatever bg a name lands on, fg must be the
  // YIQ-correct black/white. Covers both branches across a spread of names.
  let sawDark = false;
  let sawLight = false;
  for (const n of ["alice", "bob", "carol", "dave", "eve", "mallory", "zoe", "trent", "peggy", "victor"]) {
    const { bg, fg } = avatarFor(n);
    const r = parseInt(bg.slice(1, 3), 16);
    const g = parseInt(bg.slice(3, 5), 16);
    const b = parseInt(bg.slice(5, 7), 16);
    const yiq = (r * 299 + g * 587 + b * 114) / 1000;
    assert.equal(fg, yiq > 140 ? "#000000" : "#FFFFFF", `fg wrong for ${n} (bg ${bg})`);
    if (fg === "#000000") sawDark = true;
    else sawLight = true;
  }
  assert.ok(sawDark && sawLight, "expected both dark and light fg across the sample");
});
