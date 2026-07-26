# Hide Self-View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A control-bar eye toggle that hides your own camera tile from your own grid (others fill the space); everyone else still sees you.

**Architecture:** `grid.setSelfHidden()` hides the self camera tile and `_relayout` excludes hidden tiles; a `controls.js` eye/eye-off toggle drives it, persisted in layout prefs. Client-only; no protocol/server/media change.

**Tech Stack:** Vanilla ES modules; existing `.ctl.icon` CSS (no new styles). `node --test` for the unaffected suite.

## Global Constraints

- Local only — hides the self CAMERA tile from this client; media keeps publishing. Self screen-share tile untouched.
- Eye/eye-off SVG icon reusing `lib/icons.js` + the existing `.ctl.icon`/`.active`/`.icon-svg` styles — no `style.css` change.
- Persisted via the existing layout prefs (`selfHidden`); applied on `attachGrid` (like the saved column count).
- `node --check` + `node --test internal/web/test/*.test.js` (glob; bare-dir arg fails in this sandbox's Node 22) green. No `Co-Authored-By` trailer.

---

### Task 1: Icons + grid `setSelfHidden`

**Files:**
- Modify: `internal/web/assets/lib/icons.js` (add `EYE_PATHS`, `EYE_OFF_PATHS`)
- Modify: `internal/web/assets/ui/grid.js` (`setSelfHidden`; `_relayout` filter)

**Interfaces:**
- Produces: `EYE_PATHS`, `EYE_OFF_PATHS` (arrays); `grid.setSelfHidden(hidden)`.

- [ ] **Step 1: Add the eye icon paths to `lib/icons.js`**

Append (Material Design "visibility" / "visibility_off"):

```js
// Material Design "visibility" and "visibility_off" (an eye, and an eye with a slash).
export const EYE_PATHS = [
  "M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z",
];
export const EYE_OFF_PATHS = [
  "M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z",
];
```

- [ ] **Step 2: Add `setSelfHidden` to `grid.js`**

Add a public method (near `setColumns`):

```js
  // Hide/show THIS client's own camera tile in the local grid. Others are unaffected —
  // the media keeps publishing; this only changes what WE render. A hidden self tile is
  // excluded from _relayout, so the remaining tiles fill the space. Clears focus first
  // so we never leave a focused-but-invisible tile.
  setSelfHidden(hidden) {
    this._selfHidden = !!hidden;
    if (!this._selfTile) return;
    if (this._selfHidden && this._focusedEl === this._selfTile.el) this._clearFocus();
    this._selfTile.el.hidden = this._selfHidden;
    this._relayout();
  }
```

- [ ] **Step 3: Exclude hidden tiles from `_relayout`**

In `_relayout()` (~line 145), change the tile collection so hidden tiles don't take a cell. Replace:

```js
    const tiles = [...this.el.querySelectorAll(":scope > .tile")];
    for (const t of tiles) t.classList.remove("pos3-a", "pos3-b", "pos3-c"); // recomputed below
```

with:

```js
    const all = [...this.el.querySelectorAll(":scope > .tile")];
    for (const t of all) t.classList.remove("pos3-a", "pos3-b", "pos3-c"); // recomputed below
    const tiles = all.filter((t) => !t.hidden); // a hidden (self-view) tile leaves no cell
```

(Everything below still uses `tiles`; it is now the visible set, so `n`, the column math, the 3-up placement, and `_layoutFocus(tiles)` all skip a hidden self tile.)

- [ ] **Step 4: Verify — syntax, icon exports, suite**

Run:
```
node --check internal/web/assets/lib/icons.js && node --check internal/web/assets/ui/grid.js
node --input-type=module -e 'import("./internal/web/assets/lib/icons.js").then(m=>{const ok=Array.isArray(m.EYE_PATHS)&&Array.isArray(m.EYE_OFF_PATHS);console.log(ok?"eye paths OK":"MISSING");process.exit(ok?0:1)})'
node --test internal/web/test/*.test.js
```
Expected: `--check` silent; prints `eye paths OK`; suite green.

- [ ] **Step 5: Commit**

```bash
git add internal/web/assets/lib/icons.js internal/web/assets/ui/grid.js
git commit -m "feat(web): grid.setSelfHidden + eye icons for hide-self-view"
```

---

### Task 2: Control-bar hide-self toggle

**Files:**
- Modify: `internal/web/assets/ui/controls.js` (import; constructor pref; build the button; `_setSelfHiddenButton`; `_toggleSelfHidden`; `attachGrid`)

**Interfaces:**
- Consumes: `EYE_PATHS`/`EYE_OFF_PATHS`/`svgIcon` from `lib/icons.js`; `grid.setSelfHidden` (Task 1); `loadLayoutPrefs`/`saveLayoutPrefs`.

- [ ] **Step 1: Import the eye paths**

Extend the existing icons import (line 28):

```js
import { svgIcon, MIC_PATHS, MIC_OFF_PATHS, CAM_PATHS, CAM_OFF_PATHS, EYE_PATHS, EYE_OFF_PATHS } from "../lib/icons.js";
```

- [ ] **Step 2: Read the persisted state in the constructor**

Right after the `this._cols = ...` line (~line 93), add:

```js
    // Hide-self-view: hide our OWN camera tile from our OWN grid (local only), restored.
    this._selfHidden = !!loadLayoutPrefs().selfHidden;
```

- [ ] **Step 3: Build the toggle button in `_build`**

Where the icon toggles are built (near `colsBtn`/`colsWrap`, ~line 294–304), add:

```js
    this.hideSelfBtn = el("button", {
      type: "button", class: "ctl hide-self icon",
      "aria-label": "Hide yourself from your view",
      onClick: () => this._toggleSelfHidden(),
    });
    this._setSelfHiddenButton();
```

- [ ] **Step 4: Add it to the control `children`**

In the `children` array (~line 352), insert `this.hideSelfBtn` after `this.colsWrap`:

```js
    const children = [this.micWrap, this.cameraWrap, this.shareWrap, this.nsBtn, this.colsWrap, this.hideSelfBtn, this.lowBwBtn, this.countdownBtn, this.chatBtn];
```

- [ ] **Step 5: Add `_setSelfHiddenButton` and `_toggleSelfHidden`**

Add both methods (e.g. near the other button-state setters):

```js
  _setSelfHiddenButton() {
    this.hideSelfBtn.replaceChildren(svgIcon(this._selfHidden ? EYE_OFF_PATHS : EYE_PATHS));
    this.hideSelfBtn.classList.toggle("active", this._selfHidden);
    this.hideSelfBtn.title = this._selfHidden ? "Show yourself" : "Hide yourself from your view";
  }

  _toggleSelfHidden() {
    this._selfHidden = !this._selfHidden;
    saveLayoutPrefs({ selfHidden: this._selfHidden });
    this._setSelfHiddenButton();
    if (this.grid) this.grid.setSelfHidden(this._selfHidden);
  }
```

- [ ] **Step 6: Apply the restored state in `attachGrid`**

`attachGrid(grid)` (~line 198) becomes:

```js
  attachGrid(grid) {
    this.grid = grid || null;
    if (this.grid && this._cols) this.grid.setColumns(this._cols); // apply the restored choice
    if (this.grid) this.grid.setSelfHidden(this._selfHidden); // restore hide-self-view
  }
```

- [ ] **Step 7: Verify — syntax + suite**

Run: `node --check internal/web/assets/ui/controls.js && node --test internal/web/test/*.test.js`
Expected: `--check` silent; suite green.

- [ ] **Step 8: Manual check (note pending for the controller)**

In a call with ≥1 other person: the eye button hides your own tile and the others expand to fill the space; the icon flips to eye-off and highlights; clicking again restores your tile; a refresh keeps your choice; other participants still see you throughout. (No browser needed from the implementer — note pending.)

- [ ] **Step 9: Commit** (NO `Co-Authored-By` trailer)

```bash
git add internal/web/assets/ui/controls.js
git commit -m "feat(web): control-bar eye toggle to hide your own self-view"
```

---

## Self-Review

**Spec coverage:**
- `EYE_PATHS`/`EYE_OFF_PATHS` → Task 1 Step 1.
- `setSelfHidden` (hide self camera tile, clear focus, relayout) + `_relayout` hidden-filter → Task 1 Steps 2–3.
- Control-bar eye toggle, state-oriented icon, persist, apply on `attachGrid` → Task 2.
- Reuses existing `.ctl.icon` CSS (no style change) → Global Constraints.
- Testing: `node --check` + icon-export smoke + suite + manual → both tasks.

**Placeholder scan:** No TBD/TODO; every step has complete code, commands, and expected results.

**Type consistency:** `EYE_PATHS`/`EYE_OFF_PATHS` names identical across `icons.js`, the `controls.js` import, and the `svgIcon(...)` calls; `setSelfHidden(hidden)` signature matches between `grid.js` and both call sites (`attachGrid`, `_toggleSelfHidden`); `selfHidden` pref key consistent across `loadLayoutPrefs`/`saveLayoutPrefs`; `this._selfHidden` used consistently in controls.js.
