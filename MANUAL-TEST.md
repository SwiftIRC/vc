# Manual test checklist

Browser-only flows that can't run headless. Serve the app first:

```
go run ./cmd/webrtc-chat            # ad-hoc mode, listens on :8080
```

Open the printed URL in a browser that can reach the server, and grant
camera/microphone permission when prompted.

## Pre-join screen (Task 7)

- [ ] **Preview + live count** — visit `/<room>` (e.g. `/testroom`). The lobby
      shows a live self-view and "N in call". Open the same room in a second tab,
      join there, and confirm the first tab's count rises within ~3s.
- [ ] **Device pickers** — the Camera / Microphone dropdowns list your inputs;
      switching one updates the preview without dropping the other.
- [ ] **Locked room shows password field** — lock the room (an op runs the lock
      action from another client), reload the lobby; a Password field appears
      once the poll reports `locked`.
- [ ] **Wrong password shows error and stays on pre-join** — join a locked room
      with the wrong password; an error message appears and you remain in the
      lobby with the Join button re-enabled (the socket does not reconnect-loop).
- [ ] **Token nick is read-only** — open `/<room>#t=<token>` from a `!vc` invite;
      the display-name field is prefilled with the token's nick and not editable.

## Join transition (Task 7)

- [ ] **Join transitions to in-call** — click Join with a valid name/password;
      the lobby is replaced by the in-call placeholder showing your self id/role,
      the local preview, and the current peer list. Leave returns you to the lobby
      and releases the camera/mic.
- [ ] **Media flows** — with two tabs joined, each shows the other's forwarded
      video in the placeholder's remote area (full grid/controls arrive in Tasks 8–9).

## In-call grid + controls (Task 8)

- [ ] **Grid lays out N tiles** — join a room from several tabs. Each participant
      (self + every remote) gets one tile with a name and, for an op/voice user, an
      `op` / `+` badge. Your own tile is labelled "(you)" and mirrored. Tiles reflow
      responsively as the count changes; a leaving peer's tile disappears.
- [ ] **Screen-share is its own tile** — start a screen-share (Share screen). A new
      tile appears for the shared surface without displacing the sharer's camera
      tile; other tabs see the same separate screen tile. Stop it (button or the
      browser's "Stop sharing") and the screen tile — and only it — goes away.
- [ ] **Active speaker highlights** — with 2+ remote participants, whoever is
      talking gets a highlighted (accent-outlined) tile; it follows the loudest
      voice and clears when the room goes quiet.
- [ ] **Mute / camera controls work** — Mute toggles your mic (label flips
      Mute/Unmute, your tile's mic indicator turns off); Stop video toggles your
      camera (label + av indicator + your preview). Others stop hearing/seeing you.
- [ ] **Screenshare control works** — Share screen prompts the picker, publishes,
      and shows the screen tile everywhere; Stop share removes it everywhere.
- [ ] **Op sees kick/mute/ban + lock; non-op does not** — an op sees per-remote
      kick / mute / ban buttons and a Lock room toggle; a non-op (plain user/guest)
      sees none of these (they are never rendered), only the local controls.
- [ ] **Op kick removes the target for everyone** — an op clicks kick on a remote
      tile; the target is removed and their tile vanishes for all remaining
      participants (the kicked client closes itself).
- [ ] **Op mute nudges the target (re-enableable)** — an op clicks mute on a remote
      tile; that client's mic goes off (its Mute button flips to Unmute) but the
      user can click Unmute to speak again — it is a nudge, not a hard lock.
- [ ] **Lock indicator reacts to lock state** — when an op locks the room, every
      client shows a "Room locked" indicator; unlocking clears it. The op's toggle
      label tracks the same state (it reflects the server broadcast, not the click).
