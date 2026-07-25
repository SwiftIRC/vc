# Room-duration timer (top-center, hover-reveal)

## Problem

There's no call-duration display. Add a timer at the top-center of the in-call
screen that shows how long the room/call has been running, revealed on pointer
activity and fading when idle — the same behavior as the bottom control bar.

## Decisions

- **Counts from when the room started**, shared by everyone and surviving a refresh.
  A room is created lazily on first join (`registry.Resolve` → `room.New`) and reaped
  after being empty for `GCGrace` (`registry.Sweep`), so the room's creation time is
  effectively "when this call started."
- **The server sends the room's AGE in seconds** (not an absolute timestamp) in the
  `joined` message; the client counts up from it locally. This is **skew-free** —
  everyone sees the same value regardless of device clock differences, and a refresh
  re-fetches the current age. (An absolute timestamp + `Date.now()` diff would drift
  by each device's clock skew, breaking "everyone sees 20:00".)
- **Hover-reveal via a shared idle class.** The control bar's autohide is refactored
  to toggle a `ui-idle` class on `document.body` (instead of `is-hidden` on the
  controls element); both the control bar and the new timer fade via CSS. One source
  of truth, guaranteed in-sync.

## Server

### `internal/room/room.go`
- Add `startedAt time.Time` to `Room`. Set it in `New()` from the clock:
  `New` returns the struct with `startedAt: cfg.Now()` (the room's creation = call
  start; `cfg.Now` is already defaulted to `time.Now` at the top of `New`).
- In the `Joined` construction (the `p.Conn.Send(signal.Joined{...})` in `Join`,
  ~line 214), add `RoomAgeSec: int64(r.cfg.Now().Sub(r.startedAt).Seconds())`.

### `internal/signal/messages.go`
- Add to `Joined`: `RoomAgeSec int64 \`json:"roomAge,omitempty"\`` — seconds the room
  has existed, as of this join.

## Client

### `internal/web/assets/lib/duration.js` (new, pure, unit-tested)
- `formatDuration(sec) -> string`: clamp to `>= 0`, floor; return `M:SS` normally and
  `H:MM:SS` once at/after one hour. Minutes/hours are un-padded when leading,
  seconds and inner minutes zero-padded (`0:05`, `1:05`, `10:00`, `1:00:00`,
  `1:01:01`).

### `internal/web/assets/app.js`
- In the in-call render path (`onJoined` → `renderInCall`, ~line 219/245), read
  `msg.roomAge` (default `0`), record a local baseline (`Date.now()`), create a
  `.call-timer` element, append it to the in-call root (`.incall`, which is
  `position: relative`), and start a 1-second interval that sets its text to
  `formatDuration(baseAgeSec + Math.floor((Date.now() - baseline) / 1000))` (also set
  once immediately so it doesn't show blank for the first second).
- In `teardownInCall`, clear the interval and remove the `.call-timer` element.

### `internal/web/assets/ui/controls.js` (autohide refactor)
- `_revealControls` (~226): `document.body.classList.remove("ui-idle")` instead of
  `this.el.classList.remove("is-hidden")`.
- `_maybeHide` (~231): keep the "don't hide while a control has focus"
  (`this.el.contains(document.activeElement)`) reschedule guard; otherwise
  `document.body.classList.add("ui-idle")` instead of `this.el.classList.add("is-hidden")`.
- `destroy()` (~960): also `document.body.classList.remove("ui-idle")` so the class
  never lingers after leaving the call.

### `internal/web/assets/style.css`
- Replace the `.controls.is-hidden { … }` rule (~673) with `body.ui-idle .controls { … }`
  (same fade/hide styling).
- Add `.call-timer`: absolute, `top` a little in, `left: 50%; transform: translateX(-50%)`,
  a small translucent pill (padding, rounded, dark background, readable color),
  `pointer-events: none`, `z-index` above the video (matching `.call-head`),
  tabular-nums, and a fade `transition` on opacity.
- Add `body.ui-idle .call-timer { … }` mirroring the controls' hidden/faded styling
  (opacity 0 / pointer-events none), so the timer autohides with the controls.

## Testing

### Go
- `internal/room/room_test.go`: with an injectable clock, create a room at T0, advance
  to T0+90s, a join → the `Joined` sent to that participant carries `RoomAgeSec == 90`.
- `internal/signal/messages_test.go`: `Joined{RoomAgeSec: 90}` encodes `"roomAge":90`;
  a `Joined` with `RoomAgeSec == 0` omits it (`omitempty`).

### JS
- `internal/web/test/duration.test.js` (`node --test`): `formatDuration` for `0`
  (`"0:00"`), a few seconds (`"0:05"`), a minute-plus (`"1:05"`), ten minutes
  (`"10:00"`), the one-hour rollover (`3600 -> "1:00:00"`, `3661 -> "1:01:01"`), and a
  negative input clamped to `"0:00"`.
- The DOM timer wiring (app.js), the autohide refactor (controls.js), and the CSS are
  verified by `node --check` + the full suite staying green + a manual browser check
  (timer counts up top-center; it and the control bar reveal/fade together on
  activity/idle; a refresh resumes at the right value).

## Out of scope / notes

- The timer resets only if the whole room is reaped (everyone gone past `GCGrace`) —
  the intended "current call" semantics.
- No change to `get()`/`Peek()`/the invite path; no new dependencies.
