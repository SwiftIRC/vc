# Tile-Chrome Declutter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Declutter the video tiles: in the focus-mode filmstrip hide the op controls + volume slider and widen the name; app-wide, replace the `mic`/`cam` text indicators with the control bar's SVG icons.

**Architecture:** Extract the existing `svgIcon` helper + mic/cam path constants from `controls.js` into a shared `lib/icons.js`, so the tile pills and the control bar draw the same icons. Filmstrip changes are pure CSS scoped to non-focused tiles.

**Tech Stack:** Vanilla ES modules (browser client), plain CSS. No new dependencies, no build step. `node --test` for the (unaffected) suite.

## Global Constraints

- Dependency-free vanilla ES modules; no build step; no new npm packages. SVG icons (not emoji), matching the control bar exactly.
- Icons are the EXISTING `svgIcon` + `MIC_PATHS`/`MIC_OFF_PATHS`/`CAM_PATHS`/`CAM_OFF_PATHS` from `controls.js` — reused, not reinvented.
- Filmstrip = `.grid.has-focus .tile:not(.focused)` (non-focused tiles in focus mode). Elements are hidden with CSS only — they stay in the DOM so focusing/exiting restores them.
- The lobby pre-join mic/camera toggle buttons are OUT OF SCOPE. Screen-share tiles have no mic/av pills (unaffected by the icon change).
- Tile DOM has no unit tests; verification is `node --check` + the full `node --test internal/web/test/*.test.js` suite staying green (use the `*.test.js` glob; bare-dir arg fails in this sandbox's Node 22) + manual browser check.
- Commit messages must NOT include any `Co-Authored-By` trailer.

---

### Task 1: Extract shared icon module (`lib/icons.js`) + refactor `controls.js`

**Files:**
- Create: `internal/web/assets/lib/icons.js`
- Modify: `internal/web/assets/ui/controls.js` (remove the local defs ~44–74; add an import)

**Interfaces:**
- Produces: `svgIcon(paths: string[]) -> SVGElement`; `MIC_PATHS`, `MIC_OFF_PATHS`, `CAM_PATHS`, `CAM_OFF_PATHS` (arrays of path `d` strings).
- Pure refactor: the control bar renders identically.

- [ ] **Step 1: Create `internal/web/assets/lib/icons.js`**

Move the icon helper + path data here verbatim (from `controls.js:44–74`), adding `export`:

```js
// Shared inline-SVG icons. Static, developer-authored markup (no user input), built via
// the DOM — never innerHTML — and drawn with currentColor so an icon inherits its host's
// text color. Used by the control bar (controls.js) and the tile indicators (grid.js) so
// both draw pixel-identical mic/camera glyphs.
const SVG_NS = "http://www.w3.org/2000/svg";

export function svgIcon(paths) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "icon-svg");
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d);
    p.setAttribute("fill", "currentColor");
    svg.appendChild(p);
  }
  return svg;
}

// Material Design "mic" and "mic_off" (a microphone, and a microphone with a slash).
export const MIC_PATHS = [
  "M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z",
  "M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z",
];
export const MIC_OFF_PATHS = [
  "M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z",
];
// Material Design "videocam" and "videocam_off" (a camera, and a camera with a slash).
export const CAM_PATHS = [
  "M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z",
];
export const CAM_OFF_PATHS = [
  "M21 6.5l-4 4V7c0-.55-.45-1-1-1H9.82L21 17.18V6.5zM3.27 2L2 3.27 4.73 6H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.21 0 .39-.08.54-.18L19.73 21 21 19.73 3.27 2z",
];
```

- [ ] **Step 2: Refactor `controls.js` to import them**

Delete the block at `controls.js:44–74` (the `// Inline SVG icon …` comment, `SVG_NS`, `svgIcon`, and the four `_PATHS` constants). Add an import next to the existing ones (after line 27):

```js
import { svgIcon, MIC_PATHS, MIC_OFF_PATHS, CAM_PATHS, CAM_OFF_PATHS } from "../lib/icons.js";
```

Leave every USE of `svgIcon(...)`/`*_PATHS` in `controls.js` (e.g. lines ~921, ~934) unchanged — they now resolve to the imported symbols.

- [ ] **Step 3: Syntax-check and smoke-test the module loads with the right exports**

Run:
```
node --check internal/web/assets/ui/controls.js && node --check internal/web/assets/lib/icons.js
node --input-type=module -e 'import("./internal/web/assets/lib/icons.js").then(m=>{const ok=typeof m.svgIcon==="function"&&Array.isArray(m.MIC_PATHS)&&Array.isArray(m.MIC_OFF_PATHS)&&Array.isArray(m.CAM_PATHS)&&Array.isArray(m.CAM_OFF_PATHS);console.log(ok?"icons.js exports OK":"MISSING EXPORT");process.exit(ok?0:1)})'
```
Expected: `--check` silent; prints `icons.js exports OK`. (icons.js only calls `document` inside `svgIcon`, not at load, so it imports cleanly under Node.)

- [ ] **Step 4: Run the full suite (unchanged)**

Run: `node --test internal/web/test/*.test.js`
Expected: green (this refactor touches no tested module).

- [ ] **Step 5: Commit**

```bash
git add internal/web/assets/lib/icons.js internal/web/assets/ui/controls.js
git commit -m "refactor(web): extract svgIcon + mic/cam paths into shared lib/icons.js"
```

---

### Task 2: Filmstrip — hide op controls + volume, widen the name (CSS only)

**Files:**
- Modify: `internal/web/assets/style.css` (add rules near the filmstrip tile rule ~357–361)

**Interfaces:** none (pure CSS).

- [ ] **Step 1: Add the filmstrip declutter rules**

In `internal/web/assets/style.css`, immediately after the `.grid.has-focus .tile:not(.focused)` block (the one ending ~line 361), add:

```css
/* Filmstrip tiles are narrow (--strip-w): drop the op moderation controls and the
   per-tile volume slider there so the name gets the room. Both stay in the DOM and
   reappear when the tile is focused or the grid leaves focus mode. */
.grid.has-focus .tile:not(.focused) .op-actions,
.grid.has-focus .tile:not(.focused) .vol,
.grid.has-focus .tile:not(.focused) .vol-label {
  display: none;
}
/* With both side controls gone, let the (still-centered) name use nearly the full width. */
.grid.has-focus .tile:not(.focused) .name-tag {
  max-width: calc(100% - 1.2rem);
}
```

- [ ] **Step 2: Verify the suite is unaffected**

Run: `node --test internal/web/test/*.test.js`
Expected: green (CSS-only change; no JS touched).

- [ ] **Step 3: Manual browser check (note as pending for the controller)**

Focus a tile in a call with ≥2 others: the filmstrip tiles show a wide, centered name and NO op buttons / volume slider; the large focused tile still shows its op controls and volume; leaving focus mode restores everything. (You do not need to run a browser — note this as pending.)

- [ ] **Step 4: Commit**

```bash
git add internal/web/assets/style.css
git commit -m "feat(web): declutter the focus-mode filmstrip (hide op controls + volume, widen name)"
```

---

### Task 3: Tile mic/cam indicators become SVG icons (`grid.js` + CSS)

**Files:**
- Modify: `internal/web/assets/ui/grid.js` (import; `_buildTile` pill creation ~507–508; `_setIndicator` method)
- Modify: `internal/web/assets/style.css` (`.pill` rules ~515–532; add `.tile .pills .icon-svg`)

**Interfaces:**
- Consumes: `svgIcon`, `MIC_PATHS`, `MIC_OFF_PATHS`, `CAM_PATHS`, `CAM_OFF_PATHS` from `lib/icons.js` (Task 1).

- [ ] **Step 1: Import the icons in `grid.js`**

After the existing imports (line 31), add:

```js
import { svgIcon, MIC_PATHS, MIC_OFF_PATHS, CAM_PATHS, CAM_OFF_PATHS } from "../lib/icons.js";
```

- [ ] **Step 2: Build the pills as icon hosts in `_buildTile`**

Replace the two pill-creation lines (~507–508):

```js
    const micPill = el("span", { class: "pill mic", text: "mic" });
    const avPill = el("span", { class: "pill av", text: "cam" });
```

with icon-hosting spans that carry their on/off path pair and labels (the icon itself is filled in by `_setIndicator`, called just below at ~551–552):

```js
    const micPill = el("span", { class: "pill mic", role: "img" });
    micPill._paths = { on: MIC_PATHS, off: MIC_OFF_PATHS };
    micPill._labels = { on: "Microphone on", off: "Microphone muted" };
    const avPill = el("span", { class: "pill av", role: "img" });
    avPill._paths = { on: CAM_PATHS, off: CAM_OFF_PATHS };
    avPill._labels = { on: "Camera on", off: "Camera off" };
```

- [ ] **Step 3: Swap the glyph + label in `_setIndicator`**

Replace the current method:

```js
  _setIndicator(pill, on) {
    pill.classList.toggle("on", !!on);
    pill.classList.toggle("off", !on);
  }
```

with one that also swaps the SVG icon and updates the accessible label (matching the control bar's on/off glyph swap):

```js
  _setIndicator(pill, on) {
    pill.classList.toggle("on", !!on);
    pill.classList.toggle("off", !on);
    if (pill._paths) pill.replaceChildren(svgIcon(on ? pill._paths.on : pill._paths.off));
    if (pill._labels) {
      const label = on ? pill._labels.on : pill._labels.off;
      pill.setAttribute("aria-label", label);
      pill.setAttribute("title", label);
    }
  }
```

- [ ] **Step 4: Style the pill icons**

In `internal/web/assets/style.css`, update the `.pill` rules (~515–532). Replace:

```css
.tile .pill {
  padding: 0.05rem 0.35rem;
  border-radius: 6px;
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.tile .pill.on {
  background: rgba(255, 255, 255, 0.16);
  color: var(--fg);
}

.tile .pill.off {
  background: rgba(255, 107, 107, 0.22);
  color: var(--error);
  text-decoration: line-through;
}
```

with (icon-hosting pill: a snug translucent backing for legibility over video; the icon
color follows `currentColor`, so `on` reads neutral/white and `off` reads error-red; the
slashed "off" glyph conveys mute, so no strikethrough):

```css
.tile .pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.15rem;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.5);
}

.tile .pill.on {
  color: #fff;
}

.tile .pill.off {
  color: var(--error);
}

.tile .pills .icon-svg {
  width: 1rem;
  height: 1rem;
  display: block;
}
```

- [ ] **Step 5: Syntax-check and run the suite**

Run: `node --check internal/web/assets/ui/grid.js && node --test internal/web/test/*.test.js`
Expected: `--check` silent; suite green.

- [ ] **Step 6: Manual browser check (note as pending for the controller)**

Every tile's bottom-right shows mic + camera SVG icons (not the words "mic"/"cam"): live = neutral/white, muted/off = red slashed glyph; state flips as peers mute/unmute and toggle their camera; the control-bar icons are unchanged. (Note as pending — no browser needed from the implementer.)

- [ ] **Step 7: Commit**

```bash
git add internal/web/assets/ui/grid.js internal/web/assets/style.css
git commit -m "feat(web): show mic/camera state as SVG icons on every tile"
```

---

## Self-Review

**Spec coverage:**
- Shared `lib/icons.js` (`svgIcon` + 4 path constants) + `controls.js` refactor → Task 1.
- Filmstrip: hide `.op-actions` + `.vol`/`.vol-label`, widen centered name → Task 2.
- Tile pills → SVG icons app-wide, on/off glyph swap, color cue, aria-labels → Task 3.
- Lobby toggles / screen tiles untouched → Global Constraints (no task touches them).
- Testing = `node --check` + suite + manual → each task's verify steps.

**Placeholder scan:** No TBD/TODO; every step has complete code + exact paths/anchors.

**Type consistency:** `svgIcon`/`*_PATHS` export names identical across `icons.js`, `controls.js` import, and `grid.js` import; `pill._paths`/`pill._labels` shapes consistent between `_buildTile` and `_setIndicator`; `.pill.on`/`.pill.off`/`.icon-svg` class names consistent between grid.js and the CSS.
