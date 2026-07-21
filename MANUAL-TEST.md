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
