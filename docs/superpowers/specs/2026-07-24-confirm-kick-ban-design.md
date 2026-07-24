# Confirm dialog for kick / ban

## Problem

The per-tile op moderation buttons fire immediately on click
(`controls.js` `opActionsFor`): kick and ban remove a participant with a single
misclick and no undo. Ban additionally blocks the person from rejoining. These two
destructive actions should require a confirmation prompt; the reversible actions
(mute, make-op, stop-screenshare) stay one-click.

## Decisions

- **Small in-app dialog**, not `window.confirm()` — a custom modal matching the
  app's dark UI.
- Built on the native `<dialog>` element + `showModal()`, which provides the
  modal backdrop, focus trapping, and Escape-to-close for free (so the component
  stays small and the accessibility is correct by default).
- **Reusable, promise-based** helper — usable for any future destructive action,
  not hard-wired to moderation.
- **Scope: kick + ban only.** Mute, make-op, and stop-screenshare are unchanged.

## Component — `internal/web/assets/lib/confirm.js`

`confirmDialog({ title, message, confirmLabel, tone }) -> Promise<boolean>`:

- Parameters: `title` (string, required), `message` (string, optional secondary
  line), `confirmLabel` (string, the confirm button text, e.g. "Ban"), `tone`
  (`"danger"` styles the confirm button red; omitted = neutral).
- Builds `<dialog class="confirm-dialog">` via the DOM (never `innerHTML`):
  a title element, an optional message element, and a button row with a **Cancel**
  button and a **Confirm** button (labeled `confirmLabel`). Appends it to
  `document.body` and calls `dialog.showModal()`.
- **Cancel is the default focus** (`autofocus` on Cancel) — so Enter and Escape
  both cancel, the safe default for a destructive prompt.
- Resolution: Confirm → `resolve(true)`; Cancel, Escape (the dialog's `cancel`
  event), or a click on the backdrop (a click whose target is the `<dialog>`
  element itself) → `resolve(false)`. Every path calls `dialog.close()`.
- On the dialog's `close` event, remove it from the DOM and resolve the promise
  (guarded so it resolves exactly once).
- No user input is interpolated as markup — `title`/`message`/`confirmLabel` are
  set via `textContent`.

## Wiring — `internal/web/assets/ui/controls.js` (`opActionsFor`)

Extract the target's display name once (`const name = participant.name || "this
participant";`). Replace the immediate-send `onClick` handlers on the kick and ban
buttons with confirm-gated async handlers:

- Kick button:
  ```js
  onClick: async () => {
    if (await confirmDialog({ title: `Kick ${name}?`, message: "They'll be removed from the call.", confirmLabel: "Kick", tone: "danger" })) {
      this._send("kick", { id });
    }
  },
  ```
- Ban button: same shape with
  `title: `Ban ${name}?``, `message: "They'll be removed and blocked from rejoining."`,
  `confirmLabel: "Ban"`, `tone: "danger"`.

The `mute`, `+op` (`grant-op`), and `stop-screenshare` handlers are unchanged.
`controls.js` imports `confirmDialog` from `../lib/confirm.js`.

## Styling — `internal/web/assets/style.css`

- `.confirm-dialog`: a dark card matching the app — `background`, `1px` border
  (`--border`), rounded corners, padding, a sensible `max-width` (e.g. 22rem),
  centered by the top layer (`margin: auto`), and readable `color`. Reset the
  native dialog border. Style `.confirm-dialog::backdrop` as a dim translucent
  overlay.
- A title style and a muted secondary-message style.
- A right-aligned button row. The Cancel button is neutral (match the app's other
  secondary buttons); the Confirm button with `tone="danger"` is red — reuse
  `--error`, consistent with the existing `.op.ban` / `.op.kick` styling.

## Scope / out of scope

- Only the kick and ban tile actions gain a confirm. Mute, make-op, and
  stop-screenshare are untouched.
- No protocol, server, or media changes — this is a client-side pre-send guard;
  the wire messages and server behavior are identical once confirmed.

## Testing

`confirmDialog` is pure DOM built on `<dialog>.showModal()`, which requires a real
browser (not available under `node --test`), so there is no unit test. Verification:
- `node --check` on `internal/web/assets/lib/confirm.js` and
  `internal/web/assets/ui/controls.js`.
- The existing `node --test internal/web/test/*.test.js` suite stays green.
- Manual browser check: clicking Kick/Ban opens the dialog; Confirm sends the
  action (participant removed); Cancel, Escape, and a backdrop click all abort with
  no action sent; the mute / +op / stop-share buttons still act immediately.
