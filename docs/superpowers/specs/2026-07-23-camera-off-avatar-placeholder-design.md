# Camera-off avatar placeholder

## Problem

When a participant's camera is off, the tile (and the pre-join self-preview) shows
a generic `🎥` icon plus the text "Camera off". It carries no identity — every
off-camera tile looks the same. Replace that with the first letter of the
participant's nick, drawn in a colored circle whose background is picked from the
IRC color palette (colorful entries only, no grays).

## Decisions

- **Color is stable per nick.** A deterministic hash of the name maps to a palette
  color, so the same person always gets the same color and it never changes on
  re-render. (Not re-rolled randomly each time the tile rebuilds.)
- **Applies to in-call tiles and the lobby preview.** Both are places a camera can
  be off. In the lobby the name field can be blank, so a blank name falls back to a
  neutral `?` circle until a name is typed.
- **Palette is the extended IRC spec (codes 0–98), grayscale filtered out.** IRC
  defines 99 colors; many (0,1,14,15 and the 88–98 black→white ramp) are grayscale.
  Rather than hand-pick a dozen, keep the full table and derive the colorful subset
  with a saturation rule, leaving ~80+ vivid colors.

## Components

### New module: `internal/web/assets/lib/avatar.js`

Lives in `lib/` alongside the other pure, unit-tested client logic (`prefs.js`,
`presence.js`, …). No DOM required for the color/initial logic, so it is testable
under `node --test`.

Exports:

- `IRC_COLORS` — the canonical mIRC 0–98 hex table, `IRC_COLORS[code]` = `#rrggbb`.
  This is the "IRC colors spec" reproduced faithfully.

- `IRC_AVATAR_COLORS` — computed once at module load as `IRC_COLORS.filter(isColorful)`.
  `isColorful(hex)` returns false when the max−min RGB channel spread is below a
  threshold (`~32` on a 0–255 scale). This drops every grayscale code (0,1,14,15 and
  88–98) with a single rule and keeps the vivid ones. No hardcoded exclusion list.

- `avatarFor(name)` → `{ initial, bg, fg }`, a **pure** function:
  - `initial`: first code point of the trimmed name, uppercased
    (`[...name.trim()][0]?.toUpperCase()`), so emoji/accented nicks don't split a
    surrogate pair. `"?"` when the trimmed name is empty.
  - `bg`: deterministic djb2 hash of the name, `mod IRC_AVATAR_COLORS.length`, →
    a palette color. Same nick → same color, always. A blank name returns a fixed
    neutral slate (e.g. `#555`) — the "unknown" case, only reachable in the lobby.
  - `fg`: `#000` or `#fff` chosen by the bg's YIQ luminance
    (`(r*299 + g*587 + b*114)/1000 > 140` → dark text), so the letter stays legible
    on a bright fill (yellow, aqua) as well as a dark one (navy, maroon).

- `applyAvatar(node, name)` — thin DOM helper used by both callers: sets
  `node.textContent`, `node.style.background`, and `node.style.color` from
  `avatarFor(name)`. Keeps the apply logic in one place.

### Integration: `internal/web/assets/ui/grid.js`

- `_buildTile` (~line 496): replace the two placeholder spans
  (`cam-off-icon` `🎥` + `cam-off-text` "Camera off") inside `.cam-off` with a single
  `<span class="cam-off-avatar">`. Keep a reference on the tile
  (`tile.camOffAvatar`) and call `applyAvatar(tile.camOffAvatar, name)`.
- `_setName` (~line 558): after updating the name, re-run
  `applyAvatar(tile.camOffAvatar, name)` so a rename recolors and re-letters the
  circle.
- Self and remote tiles both go through `_buildTile`, so both are covered. The black
  `.cam-off` backdrop stays (it still hides the frozen/black video frame); the
  colored circle centers on top of it.

### Integration: `internal/web/assets/ui/prejoin.js`

- Placeholder build (~line 148): same span swap; keep `this.cameraOffAvatar`.
- Re-apply the avatar whenever the overlay becomes visible (in `_setCameraToggle`,
  where `this.cameraOffOverlay.hidden` is set) **and** on `nameInput` `input`, so the
  circle tracks the typed name live and shows the neutral `?` until a name exists.

### CSS: `internal/web/assets/style.css`

- Add `.cam-off-avatar` near the existing `.cam-off` rules (~line 173): a centered
  circle — `aspect-ratio: 1`, `border-radius: 50%`, size via `clamp()` so it scales
  from small strip thumbnails up to a focused tile; bold letter with `font-size`
  scaled to the circle; a subtle light ring
  (`box-shadow: 0 0 0 2px rgba(255,255,255,.15)`) so a dark-fill circle still reads
  against the black backdrop. Background/color come from inline styles set by
  `applyAvatar`.
- The `.cam-off-icon` / `.cam-off-text` rules stay: the screen-share audio
  placeholder (`grid.js` ~line 614, `🔊` + "Sharing audio") still uses them and is
  **not** changed by this work.

## Testing

`internal/web/test/avatar.test.js` (`node --test`, matching the existing suite):

- `avatarFor` is deterministic: same name → identical `bg` across calls.
- Different names generally map across the palette (spot-check a couple of known
  name→index pairs so a hash regression is caught).
- Blank / whitespace name → `initial === "?"` and the neutral bg.
- Non-ASCII first character (emoji, accented letter) yields a sensible single-glyph
  `initial` without splitting a surrogate pair.
- Every entry in `IRC_AVATAR_COLORS` passes `isColorful` (no gray leaks in) and none
  of the known grayscale codes (0,1,14,15,88–98) survive the filter.
- `fg` contrast: a bright bg → dark `fg`, a dark bg → light `fg`.

## Out of scope

- The screen-share "Sharing audio" placeholder (unchanged).
- Any persisted/user-chosen avatar color — color is derived from the nick only.
