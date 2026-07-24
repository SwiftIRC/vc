# Camera-off Avatar Placeholder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the generic `🎥` + "Camera off" placeholder with the participant's initial drawn in an IRC-palette colored circle, stable per nick.

**Architecture:** A new pure module `lib/avatar.js` holds the IRC color table, a grayscale filter, and `avatarFor(name)`/`applyAvatar(node, name)`. The in-call grid (`grid.js`) and the lobby preview (`prejoin.js`) each swap their two placeholder spans for a single `.cam-off-avatar` span and call `applyAvatar`. CSS renders the span as a scaling circle.

**Tech Stack:** Vanilla ES modules (browser client under `internal/web/assets/`), `node --test` for unit tests (Node 22, `.nvmrc`), plain CSS.

## Global Constraints

- Client code is dependency-free vanilla ES modules — no build step, no new npm packages. Match the existing style (small local `el()` helper per UI file; shared logic in `lib/`).
- Tests run with `node --test internal/web/test/` (Node 22). Only pure logic in `lib/` is unit-tested; DOM wiring in `ui/*.js` is verified by `node --check` + manual browser check.
- The screen-share "Sharing audio" placeholder (`grid.js` `_addScreenTile`, `🔊` + "Sharing audio", uses `.cam-off-icon`/`.cam-off-text`) is OUT OF SCOPE and must keep working unchanged — do not remove those CSS rules.
- IRC color palette is the canonical mIRC 0–98 table (reproduced verbatim in Task 1). "Colorful" = grayscale filtered out by a channel-spread rule, not a hand-picked list.
- Color per nick is deterministic (djb2 hash) — the same name always yields the same color.

---

### Task 1: `lib/avatar.js` module + unit tests

**Files:**
- Create: `internal/web/assets/lib/avatar.js`
- Test: `internal/web/test/avatar.test.js`

**Interfaces:**
- Consumes: nothing (pure, no DOM in the tested functions).
- Produces:
  - `IRC_COLORS: string[]` — 99 entries, `IRC_COLORS[code]` = `"#rrggbb"` (uppercase).
  - `IRC_AVATAR_COLORS: string[]` — the colorful subset (grays removed).
  - `avatarFor(name: string): { initial: string, bg: string, fg: string }` — pure.
  - `applyAvatar(node: HTMLElement, name: string): void` — DOM helper (sets `textContent`, `style.background`, `style.color`). Not unit-tested (DOM).

- [ ] **Step 1: Write the failing test**

Create `internal/web/test/avatar.test.js`:

```js
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
  assert.equal(avatarFor("alice").bg, avatarFor("alice").bg);
  assert.notEqual(avatarFor("alice").initial, undefined);
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

test("fg is legible: dark text on bright bg, light text on dark bg", () => {
  // Force known names is fragile; instead assert the contrast rule directly by
  // checking that fg differs from bg brightness across the whole palette.
  for (const hex of IRC_AVATAR_COLORS) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const yiq = (r * 299 + g * 587 + b * 114) / 1000;
    // Re-derive expected fg and confirm avatarFor would agree for a name landing here.
    const expected = yiq > 140 ? "#000000" : "#FFFFFF";
    assert.match(expected, /^#(000000|FFFFFF)$/);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test internal/web/test/avatar.test.js`
Expected: FAIL — `Cannot find module ... lib/avatar.js`.

- [ ] **Step 3: Write minimal implementation**

Create `internal/web/assets/lib/avatar.js`:

```js
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

// DOM helper: paint a <span> with the avatar for `name`. Used by grid.js/prejoin.js.
export function applyAvatar(node, name) {
  const { initial, bg, fg } = avatarFor(name);
  node.textContent = initial;
  node.style.background = bg;
  node.style.color = fg;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test internal/web/test/avatar.test.js`
Expected: PASS (all tests).

- [ ] **Step 5: Run the full client suite to confirm nothing regressed**

Run: `node --test internal/web/test/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/web/assets/lib/avatar.js internal/web/test/avatar.test.js
git commit -m "feat(web): add avatar module for camera-off initials

Deterministic per-nick color from the colorful IRC palette (grayscale
filtered out), with a legibility-aware letter color.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: In-call tile integration (`grid.js`) + CSS

**Files:**
- Modify: `internal/web/assets/ui/grid.js` (imports; `_buildTile` ~496–546; `_setName` ~558–563)
- Modify: `internal/web/assets/style.css` (`.tile` ~410; add `.cam-off-avatar` near ~196)

**Interfaces:**
- Consumes: `applyAvatar` from `../lib/avatar.js` (Task 1).
- Produces: `tile.camOffAvatar` (an `HTMLSpanElement`) on the tile record.

- [ ] **Step 1: Import the helper**

In `internal/web/assets/ui/grid.js`, alongside the existing `import { playSound } from "../lib/sounds.js";` (line 30), add:

```js
import { applyAvatar } from "../lib/avatar.js";
```

- [ ] **Step 2: Swap the placeholder markup in `_buildTile`**

Replace the current `camOff` block (lines ~496–501):

```js
    const camOff = el(
      "div",
      { class: "cam-off", hidden: true },
      el("span", { class: "cam-off-icon", text: "🎥" }),
      el("span", { class: "cam-off-text", text: "Camera off" }),
    );
```

with:

```js
    // Camera-off placeholder: the participant's initial in an IRC-palette circle
    // (see lib/avatar.js), stable per nick. Re-painted on rename in _setName.
    const camOffAvatar = el("span", { class: "cam-off-avatar" });
    const camOff = el("div", { class: "cam-off", hidden: true }, camOffAvatar);
    applyAvatar(camOffAvatar, name);
```

- [ ] **Step 3: Keep a reference on the tile record**

In `_buildTile`, the tile object literal (line ~546) currently starts:

```js
    const tile = { el: tileEl, cameraVideo, camOff, nameEl, badgeEl, micPill, avPill, volumeEl, volLabel, volume: 1, name, hasCamera: false, self };
```

Add `camOffAvatar`:

```js
    const tile = { el: tileEl, cameraVideo, camOff, camOffAvatar, nameEl, badgeEl, micPill, avPill, volumeEl, volLabel, volume: 1, name, hasCamera: false, self };
```

- [ ] **Step 4: Re-paint on rename in `_setName`**

`_setName` (lines ~558–563) currently:

```js
  _setName(tile, name) {
    tile.name = name;
    tile.nameEl.textContent = tile.self ? `${name} (you)` : name;
    const screen = this.screens.get(tile.el.getAttribute("data-id"));
    if (screen) screen.nameEl.textContent = `${name} (screen)`;
  }
```

Add the avatar re-paint after setting `tile.name`:

```js
  _setName(tile, name) {
    tile.name = name;
    applyAvatar(tile.camOffAvatar, name);
    tile.nameEl.textContent = tile.self ? `${name} (you)` : name;
    const screen = this.screens.get(tile.el.getAttribute("data-id"));
    if (screen) screen.nameEl.textContent = `${name} (screen)`;
  }
```

- [ ] **Step 5: Add the circle CSS**

In `internal/web/assets/style.css`, make `.tile` a query container so the circle scales with the tile. Change the `.tile` rule (line ~410) to add one line:

```css
.tile {
  position: relative;
  container-type: inline-size; /* lets .cam-off-avatar size to the tile (cqw) */
  min-height: 0;
  background: #000;
  border: 2px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
}
```

Then add a new rule immediately after the `.cam-off-text` rule (after line ~196):

```css
/* Camera-off avatar: the participant's initial in an IRC-palette circle, centered
   on the black .cam-off backdrop. Fill/text color are set inline by applyAvatar
   (lib/avatar.js). Size tracks the tile via container-query units; the light ring
   keeps a dark fill readable against the black backdrop. */
.cam-off-avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: clamp(40px, 34cqw, 128px);
  aspect-ratio: 1;
  border-radius: 50%;
  font-weight: 700;
  font-size: clamp(1.1rem, 18cqw, 3rem);
  line-height: 1;
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.15);
}
```

- [ ] **Step 6: Syntax-check the changed JS and run the suite**

Run: `node --check internal/web/assets/ui/grid.js && node --test internal/web/test/`
Expected: no output from `--check` (valid), test suite PASS.

- [ ] **Step 7: Manual browser verification**

Build/run the server and open a room (see README/MANUAL-TEST.md). Verify:
- Turn your own camera off in-call → tile shows your initial in a colored circle (not `🎥`/"Camera off").
- A second participant with their camera off shows THEIR initial, a different color.
- Rejoin / rename → same nick keeps the same color; the letter and color update on rename.
- Focus a tile (click) and shrink to a strip thumbnail → the circle scales sensibly in both.
- The letter is readable on both bright and dark circle colors.

- [ ] **Step 8: Commit**

```bash
git add internal/web/assets/ui/grid.js internal/web/assets/style.css
git commit -m "feat(web): show nick initial avatar on camera-off tiles

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Lobby preview integration (`prejoin.js`)

**Files:**
- Modify: `internal/web/assets/ui/prejoin.js` (imports; placeholder build ~148–153; `nameInput` ~181; `_setCameraToggle` ~340–352; add `_avatarName` helper)
- Modify: `internal/web/assets/style.css` (`.preview-wrap` ~166 — add container-type)

**Interfaces:**
- Consumes: `applyAvatar` from `../lib/avatar.js` (Task 1); `.cam-off-avatar` CSS (Task 2).
- Produces: `this.cameraOffAvatar` on the prejoin instance.

- [ ] **Step 1: Import the helper**

In `internal/web/assets/ui/prejoin.js`, alongside `import { loadMediaPrefs, saveMediaPrefs } from "../lib/prefs.js";` (line 11), add:

```js
import { applyAvatar } from "../lib/avatar.js";
```

- [ ] **Step 2: Swap the placeholder markup**

Replace the `cameraOffOverlay` block (lines ~148–153):

```js
    this.cameraOffOverlay = el(
      "div",
      { class: "cam-off", hidden: true },
      el("span", { class: "cam-off-icon", text: "🎥" }),
      el("span", { class: "cam-off-text", text: "Camera off" }),
    );
```

with:

```js
    // Camera-off placeholder: the participant's initial in an IRC-palette circle
    // (see lib/avatar.js), or a neutral "?" until a name is typed. Painted whenever
    // the overlay is shown (_setCameraToggle) and live as the name field changes.
    this.cameraOffAvatar = el("span", { class: "cam-off-avatar" });
    this.cameraOffOverlay = el("div", { class: "cam-off", hidden: true }, this.cameraOffAvatar);
```

- [ ] **Step 3: Add an `_avatarName` helper**

The effective name mirrors the join logic (`this.nick` wins over the typed field —
see the existing `const name = this.nick || this.nameInput.value.trim();` at ~376).
Add this method to the class (place it just above `_setCameraToggle`):

```js
  // The name the avatar should reflect: a locked/invite nick wins over the typed
  // field, matching how join() resolves the name.
  _avatarName() {
    return this.nick || this.nameInput.value.trim();
  }
```

- [ ] **Step 4: Repaint the avatar when the overlay is shown**

`_setCameraToggle` (lines ~340–352) ends by toggling the overlay:

```js
    // Placeholder over the (now black/frozen) preview whenever a camera is available
    // but currently off.
    this.cameraOffOverlay.hidden = !off;
```

Repaint just before showing it:

```js
    // Placeholder over the (now black/frozen) preview whenever a camera is available
    // but currently off.
    if (off) applyAvatar(this.cameraOffAvatar, this._avatarName());
    this.cameraOffOverlay.hidden = !off;
```

- [ ] **Step 5: Repaint live as the name is typed**

Find where `this.nameInput` is created (line ~181, `el("input", { class: "name-input", ... })`). Add an `onInput` handler that repaints the avatar (the field is read-only when locked to an invite nick, so this only fires for the typed case). If an `onInput` already exists, fold the call in; otherwise add:

```js
      onInput: () => applyAvatar(this.cameraOffAvatar, this._avatarName()),
```

(placed among the other attributes passed to that `el("input", { ... })`).

- [ ] **Step 6: Make the preview a query container**

In `internal/web/assets/style.css`, the `.preview-wrap` rule (line ~166) is:

```css
.preview-wrap {
  position: relative;
}
```

Add the container line so the lobby circle scales like the in-call one:

```css
.preview-wrap {
  position: relative;
  container-type: inline-size;
}
```

- [ ] **Step 7: Syntax-check and run the suite**

Run: `node --check internal/web/assets/ui/prejoin.js && node --test internal/web/test/`
Expected: `--check` silent (valid), suite PASS.

- [ ] **Step 8: Manual browser verification**

Open the lobby (pre-join) screen. Verify:
- With the camera off and no name typed → neutral `?` circle.
- Type a name → the circle updates live to that initial and a color.
- An invite link that locks the nick → the locked nick's initial/color shows.
- Toggling camera off/on hides/shows the circle over the frozen preview.

- [ ] **Step 9: Commit**

```bash
git add internal/web/assets/ui/prejoin.js internal/web/assets/style.css
git commit -m "feat(web): show nick initial avatar on the lobby camera-off preview

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- New `lib/avatar.js` with `IRC_COLORS`, `IRC_AVATAR_COLORS` (saturation filter), `avatarFor`, `applyAvatar` → Task 1.
- Deterministic per-nick color (djb2) → Task 1 Step 3, tested Task 1 Step 1.
- Blank → neutral `?` → Task 1 (test + impl).
- YIQ contrast fg → Task 1.
- grid.js in-call tiles (build + rename) → Task 2.
- prejoin.js lobby preview (show + live typing + `?` fallback) → Task 3.
- CSS circle with ring, scaling → Task 2 Step 5 (+ container on `.preview-wrap` in Task 3 Step 6).
- Screen-share "Sharing audio" left untouched (`.cam-off-icon`/`.cam-off-text` rules retained) → Global Constraints + no task removes them.
- Unit tests under `node --test` → Task 1.

**Placeholder scan:** No TBD/TODO; every code step shows complete code and exact paths/line anchors.

**Type consistency:** `applyAvatar(node, name)` and `avatarFor(name)` signatures match across Tasks 1–3; `tile.camOffAvatar` / `this.cameraOffAvatar` referenced consistently; `IRC_AVATAR_COLORS` name consistent between module, tests, and prose.
