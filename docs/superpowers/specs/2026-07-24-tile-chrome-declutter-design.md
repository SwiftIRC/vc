# Declutter tile chrome

## Problem

Two adjustments to the in-call video tiles:

1. In the focus-mode filmstrip (the narrow right-hand column of other cameras
   shown when a tile is focused), the top row is crowded: op moderation buttons
   (top-left), the centered name (squeezed to `100% − 6rem`), and the per-tile
   volume slider (top-right) all compete in a 120–240px-wide tile.
2. The mic/camera state indicators on every tile read as the words "mic" / "cam".
   The control bar already shows mic/camera as inline SVG icons; the tile
   indicators should match.

## Decisions

- **Filmstrip (change 1):** hide BOTH the op controls and the volume slider on
  non-focused (strip) tiles, and let the name stay centered but expand to nearly
  the full tile width. Ops still moderate a strip participant by clicking their
  tile to focus it (the large focused tile keeps its op controls and volume);
  volume is likewise adjustable once a tile is focused or when not in focus mode.
- **Icons (change 2):** replace the "mic"/"cam" text indicators with the SAME
  inline SVG icons the control bar uses, on every tile (self + remote, in all
  layouts). Reuse the existing `svgIcon` helper and `MIC_PATHS`/`MIC_OFF_PATHS`/
  `CAM_PATHS`/`CAM_OFF_PATHS` path data rather than inventing new icons.
- SVG icons, not emoji — matches the control bar exactly and stays dependency-free.
- The lobby pre-join mic/camera toggle BUTTONS are out of scope (separate control,
  already icon/emoji buttons).

## Change 1 — Filmstrip: drop op controls + volume, widen the name

CSS-only, scoped to non-focused tiles in focus mode
(`.grid.has-focus .tile:not(.focused)`):

- Hide the op controls: `.op-actions { display: none; }`.
- Hide the volume slider and its drag readout: `.vol, .vol-label { display: none; }`.
- Widen the name-tag: it stays centered (`left: 50%; transform: translateX(-50%)`)
  but its `max-width` relaxes from `calc(100% − 6rem)` to about `calc(100% − 1.2rem)`,
  so with both side obstacles gone it uses nearly the full tile width (still
  ellipsis-truncating when necessary).

No JS change: the elements still exist in the DOM (so exiting focus / focusing a
tile restores them); they are only visually hidden while a tile sits in the strip.

## Change 2 — mic/cam indicators as SVG icons (all tiles)

### New shared module: `internal/web/assets/lib/icons.js`

Extract, verbatim, from `internal/web/assets/ui/controls.js`:
- `svgIcon(paths)` — builds an inline `<svg class="icon-svg" viewBox="0 0 24 24"
  aria-hidden>` from an array of path `d` strings, via `createElementNS` (never
  `innerHTML`), colored by `currentColor`.
- `MIC_PATHS`, `MIC_OFF_PATHS`, `CAM_PATHS`, `CAM_OFF_PATHS` — the path data.

`controls.js` then imports these from `lib/icons.js` instead of defining them
locally (pure refactor — the control bar renders identically). This keeps the
tile icons and control-bar icons a single source of truth.

### `internal/web/assets/ui/grid.js`

- `_buildTile`: build `micPill`/`avPill` as `.pill` spans containing an SVG icon
  instead of the text "mic"/"cam". Record each pill's on/off path pair so the
  indicator setter can swap glyphs (e.g. `micPill._paths = { on: MIC_PATHS, off:
  MIC_OFF_PATHS }`, `avPill._paths = { on: CAM_PATHS, off: CAM_OFF_PATHS }`).
- `_setIndicator(pill, on)`: replace the pill's child with
  `svgIcon(on ? pill._paths.on : pill._paths.off)` (matching the control bar's
  enabled/disabled swap), keep toggling the `on`/`off` classes for color, and set
  an `aria-label`/`title` conveying state ("Microphone on" / "Microphone muted",
  "Camera on" / "Camera off") so the meaning the text carried is preserved for
  assistive tech (the SVG itself stays `aria-hidden`).

### CSS (`internal/web/assets/style.css`)

- Add `.tile .pills .icon-svg { width: 1rem; height: 1rem; display: block; }`.
- Restyle `.pill.on` / `.pill.off`: keep a small translucent dark backing on the
  pill for legibility over bright video; drive the icon color via `currentColor` —
  `on` a light/neutral color, `off` the error red. Drop the text-only
  `text-decoration: line-through` (the slashed "off" glyph conveys the muted state).

## Scope / out of scope

- Applies to base video tiles' mic/av indicators everywhere. Screen-share tiles
  have no mic/av pills, so they are unaffected (the filmstrip hide rules still
  apply to them harmlessly — a non-focused screen tile also loses its op controls
  and volume in the strip, consistent with camera tiles).
- The lobby pre-join mic/camera toggle buttons are unchanged.
- No protocol, server, or media changes.

## Testing

Both changes are DOM/CSS with no pure logic to unit-test (the `icons.js`
extraction only relocates DOM-building code). Verification:
- `node --check` on `controls.js`, `grid.js`, and the new `lib/icons.js`.
- The existing `node --test internal/web/test/*.test.js` suite stays green.
- Manual browser check: control-bar icons unchanged after the extraction; tile
  mic/cam indicators render as icons that flip between on and muted/off states and
  color; the filmstrip shows a wide centered name with no op buttons or volume
  slider, while a focused tile still shows both.
