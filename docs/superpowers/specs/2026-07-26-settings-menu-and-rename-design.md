# In-call ☰ settings menu + on-the-fly rename

## Problem

Two things, one surface:

1. **The control bar is crowded.** Consolidate the settings-type controls into a single
   ☰ (hamburger) menu so the bar keeps only the core call actions.
2. **You can't change your display name mid-call.** Add a rename control — surfaced as a
   row in that menu.

## Decisions

- **The ☰ menu holds:** Rename (new), Hide self, Noise suppression, Data saver, Camera
  columns, and — op only — Lock room and Session quality. **The bar keeps:** mic, camera,
  deafen, share, countdown, chat, the ☰ button, the "Room locked" *indicator*, and Leave.
- **Moved controls reuse their existing handlers and state** (`_toggleLowBandwidth`,
  `_onNsToggle`, `_pickCols`, `_toggleLock`, the quality pickers, `_toggleSelfHidden`);
  only their DOM presentation moves from standalone bar buttons into menu rows.
- **Op rows (Lock, Quality) are gated by role.** `becomeOp()` inserts them into the menu
  on a mid-call promotion, exactly as it adds the bar buttons today.
- **The "Room locked" status indicator stays on the bar** — it's a readout shown to
  *everyone*, not a control; only the op's lock *toggle* moves into the menu.
- **Rename is display-only and open to everyone.** `p.Account` and `p.Role` are untouched,
  so an identified user keeps their verified account/role and op/voice badge; only the
  cosmetic display name changes (already an unverified field per the codebase's comments).
- **Rename survives a reconnect.** The client already re-sends its name in the join frame;
  the server will prefer a non-empty client-sent `join.Name` over the token's `Nick`
  (account/role still from the verified token). The choice also persists to `localStorage`
  (`swiftirc-vc-name`, the key prejoin already uses) so it sticks to the next visit.
- **Columns render as an inline segmented row; quality as inline tier selects (op).** No
  nested popovers.

## Wire protocol (`internal/signal/messages.go`)

Mirrors the `media-state → peer-media-state` pattern:

```go
// client → server
type Rename struct {
    Name string `json:"name"`
}
// server → client (broadcast to ALL, sender included, so it renders the sanitized result)
type PeerRenamed struct {
    ID   string `json:"id"`
    Name string `json:"name"`
}
```

- Decode switch: add `case "rename": v = &Rename{}`.
- `serverTypeName`: add `case PeerRenamed, *PeerRenamed: return "peer-renamed", nil`.
- Round-trip tests (the existing encode/decode table tests): add a `rename` decode case and
  a `PeerRenamed` → `"peer-renamed"` encode case.

## Server (`internal/server/server.go`, `internal/room/room.go`)

**Dispatch** — Rename is a self-action like `MediaState` (no error reply). Add
`*signal.Rename` to the `serve()` type-switch that routes to `dispatch`, and in `dispatch`:

```go
case *signal.Rename:
    name := strings.TrimSpace(m.Name)
    if name == "" { // empty submit = cancel
        return
    }
    rm.Rename(p.ID, sanitizeName(name)) // sanitizeName: strips control chars, collapses ws, caps 24 runes
    return
```

**`room.Rename`** — mirrors `SetMediaState` (broadcast to all, `excludeID=""`):

```go
func (r *Room) Rename(id, name string) {
    r.mu.Lock()
    p, ok := r.parts[id]
    if !ok || name == "" || name == p.Name { // missing / empty / unchanged → no-op
        r.mu.Unlock()
        return
    }
    p.Name = name
    r.mu.Unlock()
    r.Broadcast(signal.PeerRenamed{ID: id, Name: name}, "")
}
```

**Join name preference (reconnect)** — in `serve()`, where the participant's name is set
from claims-or-guest, prefer a non-empty client-sent name so a rename survives a reconnect:

```go
if claims != nil {
    p.Account, p.Role = claims.Account, roleFromClaim(claims.Role)
    // Display name is cosmetic and client-controlled (rename). Prefer the name the
    // client sent — so a renamed identified user keeps it across a reconnect — and
    // fall back to the token's verified nick only when the client sent none.
    if strings.TrimSpace(join.Name) != "" {
        p.Name = sanitizeName(join.Name)
    } else {
        p.Name = claims.Nick
    }
} else {
    p.Name, p.Role = sanitizeName(join.Name), room.RoleGuest
}
```

(At the initial identified join the prejoin field is prefilled read-only with the nick, so
`join.Name` is the nick and `p.Name` is unchanged from today. Account and role always come
from the verified token — only the cosmetic name is client-controlled, which is the whole
point of "everyone can rename".)

## Client name persistence (`internal/web/assets/lib/prefs.js`, `ui/prejoin.js`)

`loadName`/`saveName` (currently private in `prejoin.js`, keyed `swiftirc-vc-name`) move to
`lib/prefs.js` and are exported, so prejoin and the rename path share one implementation:

```js
const NAME_KEY = "swiftirc-vc-name";
export function loadName() { try { return localStorage.getItem(NAME_KEY) || ""; } catch { return ""; } }
export function saveName(name) { try { if (name) localStorage.setItem(NAME_KEY, name); } catch { /* storage off */ } }
```

`prejoin.js` drops its local copies and imports these instead (behaviour unchanged).

## Grid (`internal/web/assets/ui/grid.js`)

Add `setPeerName`, the naming analog of the existing `setPeerRole`:

```js
// Update a participant's display name from a peer-renamed broadcast. Works for self too
// (keeps this.selfName in sync so the self label, the "(name) (screen)" tile, and the
// reconnect join frame all reflect the new name). _setName already handles the "(you)"
// suffix and the screen tile via the tile's data-id.
setPeerName(id, name) {
    if (id === this.selfId) this.selfName = name;
    const tile = this.tiles.get(id);
    if (tile) this._setName(tile, name);
}
```

## Control bar → ☰ menu (`internal/web/assets/ui/controls.js`)

A new `settingsBtn` (`class "ctl settings icon"`, ☰ glyph) + a `settingsMenu` popover built
like the existing `.share-menu`/cols/quality popovers (same `_closeMenus` + outside-click
dismissal; `settingsMenu` added to `_closeMenus` and the outside-pointer handler). The
`children` array becomes:

```
[micWrap, cameraWrap, deafenBtn, shareWrap, countdownBtn, chatBtn, settingsWrap, lockStatus, leaveBtn]
```

`settingsMenu` rows, top to bottom:

- **Rename** — a row with a `<input class="rename-input" maxlength="24">`. Opening the menu
  prefills it from `this.grid.selfName`. Enter submits (`_submitRename`); Esc or blur reverts
  to the current name and closes. `_submitRename`: trim; if empty or unchanged, just close;
  else `this.signaling.send("rename", { name })` and close. The server re-sanitizes
  authoritatively and the resulting `peer-renamed` updates the tile, so no optimistic local
  edit is needed.
- **Hide self**, **Noise suppression**, **Data saver** — toggle rows. Each is a
  `.settings-item` button with an icon slot + a text label; clicking runs the existing
  handler and the existing state-setter (`_setSelfHiddenButton`, `_setNsButton`,
  `_setLowBwButton`) updates the row's icon slot and toggles `.active` on the row (the
  setters are adapted to target the row's icon span instead of a bare bar button). Noise
  suppression keeps its "loading…" disabled state on first enable.
- **Camera columns** — a labelled row whose choices are the existing `COLS_OPTIONS`
  rendered as an inline segmented control (`.cols-item` buttons), reusing `_pickCols` /
  `_markColsActive` unchanged (they just live in the menu now).
- **Lock room** *(op only)* — a toggle row reusing `_toggleLock` / `_setLockButton`
  (adapted to the row). The separate `lockStatus` indicator stays on the bar.
- **Session quality** *(op only)* — a labelled row holding the existing two tier `<select>`s
  (camera, screen) and their handlers, rendered inline.

`becomeOp()` inserts the Lock and Quality rows into `settingsMenu` (instead of onto the bar).

## Client wiring (`internal/web/assets/app.js`)

Handle the broadcast and keep the self name coherent across tile, reconnect, and storage:

```js
import { /* … */ saveName } from "./lib/prefs.js";

signaling.on("peer-renamed", (m) => {
    if (!grid || !m) return;
    grid.setPeerName(m.id, m.name);
    if (m.id === grid.selfId) {
        selfName = m.name;
        if (pendingJoin) pendingJoin.name = m.name; // so a reconnect re-sends the new name
        saveName(m.name);                            // persist for the next visit
    }
});
```

Controls sends `"rename"` directly via `this.signaling`; app.js owns the self-side
bookkeeping (grid, `selfName`, `pendingJoin.name`, persistence).

## Styling (`internal/web/assets/style.css`)

Add `.settings-menu` (a vertical popover, same anchoring idiom as `.share-menu`) and
`.settings-item` rows (icon slot + label + trailing control), an `.active`/checked state for
the toggle rows, the inline segmented style for columns, and the rename-input row. No change
to the moved controls' own glyph/`.active` conventions.

## Edge cases

- **Empty / whitespace / unchanged rename** → no-op (client guards; server `TrimSpace`
  guard; `room.Rename` unchanged-guard). Never renames to "guest".
- **Duplicate names allowed** — guests can already collide at join; no uniqueness check.
- **Chat history** keeps each message's attribution as sent (`ChatEvent.From` is captured at
  send time); only future messages, tiles, and the roster reflect the new name.
- **Identified user** — rename changes the display name only; account, role, and the op/+
  badge are untouched. Their name can then diverge from their NickServ nick (accepted).
- **Reconnect** — the renamed name rides the rejoin frame (`pendingJoin.name`) and the
  server prefers it, so the name survives a mid-call socket drop for everyone.
- **Mid-call op promotion** — `becomeOp()` inserts Lock + Quality rows into the already-built
  menu; a demotion path isn't needed (roles only go up in-session, as today).
- **Length** — the input caps at 24 (matching `sanitizeName`'s rune cap); the server
  re-sanitizes as the authority.
- **Screen-share tile** — `_setName` updates the `(name) (screen)` label via the tile's
  `data-id`, so a rename relabels the sharer's screen tile too.

## Testing

- **Go:** signal encode/decode round-trip for `rename` and `peer-renamed`; a `room.Rename`
  unit test (broadcasts `PeerRenamed`; no-ops on unchanged/missing); a server test that a
  reconnect carrying a client name keeps it while an empty name falls back to the token nick.
  Existing `go test ./...` stays green.
- **JS:** `node --check` on changed modules; `node --test internal/web/test/*.test.js` stays
  green (the ☰ menu and rename UI are DOM — manual).
- **Manual (note pending):** the ☰ button opens/closes the menu; every moved control works
  from the menu (toggles, columns, and — as op — lock + quality, appearing on promotion);
  renaming updates your tile, the roster, and everyone else's view of you; the new name
  survives a reconnect and a refresh; other participants still see you throughout.

## Out of scope

- Ops renaming *other* participants.
- Unique-nick enforcement or reserved-name checks.
- Rename rate-limiting / flood control.
- Showing a rename event in the moderation/chat feed, or nick history.
- A role *demotion* path for the op rows.
