# Hide self-view

## Problem

There's no way to hide your own camera tile from your own grid. Add a control-bar
toggle that removes the self tile from **your** view (so the other tiles fill the
space), without affecting what anyone else sees.

## Decisions

- **Local only.** Hides the self **camera** tile from this client's grid; the media
  keeps publishing, so every other participant still sees you normally. No protocol/
  server change.
- **Only the self camera tile** — a self *screen-share* tile stays visible (you want
  to see what you're sharing).
- **Eye / eye-off icon** in the control bar, matching the existing SVG-icon toggles
  (mic/camera/columns), via the shared `lib/icons.js`.
- **Persisted** in the existing layout prefs (`selfHidden`), applied on `attachGrid`
  like the saved column count, so the choice survives a refresh.

## Change — `internal/web/assets/lib/icons.js`

Add two Material-Design path sets (eye = "visibility", eye-off = "visibility_off"),
exported like the mic/cam paths:

```js
export const EYE_PATHS = [
  "M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z",
];
export const EYE_OFF_PATHS = [
  "M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z",
];
```

## Change — `internal/web/assets/ui/grid.js`

- Add `setSelfHidden(hidden)`:
  - If there's no `this._selfTile`, no-op.
  - If hiding and the self tile is currently focused (`this._focusedEl ===
    this._selfTile.el`), `this._clearFocus()` first — never focus an invisible tile.
  - `this._selfHidden = !!hidden;` and `this._selfTile.el.hidden = !!hidden;` (the
    global `[hidden]` rule sets `display:none`).
  - `this._relayout();`
- `_relayout()`: when it collects tiles (`querySelectorAll(":scope > .tile")`), filter
  out hidden ones for the layout count/placement — `.filter((t) => !t.hidden)` — so a
  hidden self tile leaves no empty cell and the others expand. (The pos3-class cleanup
  can still run over all tiles; only the visible set drives `n`/columns/`_layoutFocus`.)

## Change — `internal/web/assets/ui/controls.js`

- Import `EYE_PATHS, EYE_OFF_PATHS` (and `svgIcon` if not already) from `../lib/icons.js`.
- Constructor: read `this._selfHidden = !!loadLayoutPrefs().selfHidden;`.
- Build a `hideSelfBtn` (`class: "ctl hide-self icon"`, aria-label "Hide yourself from
  your view") and add it to the control `children` list. Set its initial glyph/state
  via `_setSelfHiddenButton()`.
- `_setSelfHiddenButton()`: `this.hideSelfBtn.replaceChildren(svgIcon(this._selfHidden
  ? EYE_OFF_PATHS : EYE_PATHS)); this.hideSelfBtn.classList.toggle("active",
  this._selfHidden); this.hideSelfBtn.title = this._selfHidden ? "Show yourself" :
  "Hide yourself from your view";` (state-oriented, matching the mic/camera buttons).
- `_toggleSelfHidden()`: flip `this._selfHidden`, `saveLayoutPrefs({ selfHidden:
  this._selfHidden })`, `this._setSelfHiddenButton()`, and `if (this.grid)
  this.grid.setSelfHidden(this._selfHidden);`.
- `attachGrid(grid)`: after wiring the grid, apply the restored state — `if (this.grid)
  this.grid.setSelfHidden(this._selfHidden);` (mirrors how the saved column count is
  applied there).

## Prefs

`selfHidden` (boolean) rides in the existing layout prefs — `loadLayoutPrefs()` /
`saveLayoutPrefs({ selfHidden })`. No change to `prefs.js` (its merge is generic).

## Edge cases

- Hidden + alone in the call → an empty grid (you hid the only tile); toggling off
  restores it. Acceptable.
- Focus mode: covered — hiding a focused self tile clears focus first.
- Self screen-share tile is a separate tile and is untouched.

## Testing

DOM/UI with no pure logic to unit-test. Verification:
- `node --check` on `icons.js`, `grid.js`, `controls.js`.
- The existing `node --test internal/web/test/*.test.js` suite stays green.
- Manual: the toggle hides your own tile and the others expand to fill the space;
  toggling again restores it; the choice persists across a refresh; other participants
  still see you throughout.

## Out of scope

- Hiding yourself from *others* (a "go invisible" mode) — a separate, larger feature.
- No protocol/server/media change.
