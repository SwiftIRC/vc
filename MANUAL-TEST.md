# Manual test checklist

Browser-only flows that can't run headless (getUserMedia, WebRTC, screen-share,
the reconnect/kick lifecycle). Run the whole list in **at least two real
browsers** (two windows/profiles on one machine is fine; two devices is better)
before shipping a client change.

Serve the app first:

```
go run ./cmd/webrtc-chat -public-ip 127.0.0.1      # ad-hoc mode, listens on :8080
```

Open the printed URL in each browser and grant camera/microphone permission when
prompted. Some items need an **op**: the first person to join an ad-hoc room
becomes op, or open `/<room>#t=<token>` from a `!vc` invite whose token carries
`role=op`. Throughout, "browser A / B / C" are separate joined clients.

## Pre-join screen

- [ ] **Preview + live count** — visit `/<room>` (e.g. `/testroom`). The lobby
      shows a live self-view and "N in call". Join the same room in a second
      browser and confirm the first browser's count rises within ~3s.
- [ ] **Device pickers** — the Camera / Microphone dropdowns list your inputs;
      switching one updates the preview without dropping the other.
- [ ] **Locked room shows password field** — with the room locked (an op runs the
      lock action from another client), reload the lobby; a Password field appears
      once the poll reports `locked`.
- [ ] **Wrong password shows error and stays on pre-join** — join a locked room
      with the wrong password; an error appears and you remain in the lobby with
      the Join button re-enabled (the socket does not reconnect-loop).
- [ ] **Token nick is read-only** — open `/<room>#t=<token>` from a `!vc` invite;
      the display-name field is prefilled with the token's nick and not editable.

## Join / leave

- [ ] **Join transitions to in-call** — click Join with a valid name/password;
      the lobby is replaced by the in-call view (tile grid, control bar, chat).
- [ ] **Leave returns to the lobby** — Leave tears down the call, releases the
      camera/mic (the camera light goes out), and re-renders the pre-join lobby.
      Other browsers see your tile disappear.
- [ ] **Video flows both ways** — with A and B joined, each sees the other's live
      camera in a remote tile, and each hears the other. Muting/stopping on one
      side is reflected on the other.

## In-call grid + controls

- [ ] **Grid lays out N tiles** — join from several browsers. Each participant
      (self + every remote) gets one tile with a name and, for an op/voice user, an
      `op` / `+` badge. Your own tile is labelled "(you)" and mirrored. Tiles reflow
      as the count changes; a leaving peer's tile disappears.
- [ ] **Screen-share is its own tile** — start a screen-share (Share screen). A new
      tile appears for the shared surface **without** displacing the sharer's camera
      tile; other browsers see the same separate screen tile. Stop it (button or the
      browser's "Stop sharing") and the screen tile — and only it — goes away.
- [ ] **Active speaker highlights** — with 2+ remote participants, whoever is
      talking gets an accent-outlined tile; it follows the loudest voice and clears
      when the room goes quiet.
- [ ] **Mute / camera controls work** — Mute toggles your mic (label flips
      Mute/Unmute, your tile's mic indicator turns off); Stop video toggles your
      camera (label + av indicator + your preview). Others stop hearing/seeing you.
- [ ] **Device switch mid-preview** — in the lobby, switch camera or mic; the new
      device is the one that goes live when you join (the preview updates, the other
      track keeps streaming).

## Chat + moderation feed

- [ ] **Chat sends and fans out** — type a message in A's chat box and press Enter
      (or Send). It appears in A's own log (echoed by the server, not locally) and
      in B's and C's logs, prefixed with the sender's name and a timestamp.
- [ ] **Chat replay for a late joiner** — with a few messages already sent, join
      from a fresh browser C. C's chat log is populated with the recent history (up
      to 200 messages) in the original order, then new messages continue live.
- [ ] **Injection safety** — send a chat message whose text is literally
      `<img src=x onerror=alert(1)>` (and set a display name containing `<b>x</b>`).
      It renders as **plain text** in every browser — no image error, no alert, no
      bold — confirming remote strings go through textContent, never innerHTML.
- [ ] **Moderation feed narrates op actions** — when an op kicks / bans / mutes /
      locks / unlocks, every remaining client's chat log shows a feed line, e.g.
      "alice kicked bob", "alice muted bob (mic)", "alice locked the room".

## Op moderation

- [ ] **Op sees kick/mute/ban + lock; non-op does not** — an op sees per-remote
      kick / mute / ban buttons and a Lock room toggle; a non-op sees none of these
      (they are never rendered), only the local controls.
- [ ] **Op kick removes the target for everyone** — an op clicks kick on a remote
      tile; the target's tile vanishes for all remaining participants.
- [ ] **Op mute nudges the target (re-enableable)** — an op clicks mute on a remote
      tile; that client's mic goes off (its Mute button flips to Unmute) but the
      user can click Unmute to speak again — a nudge, not a hard lock.
- [ ] **Lock indicator reacts to lock state** — when an op locks the room, every
      client shows a "Room locked" indicator; unlocking clears it. The op's toggle
      label tracks the same state (it reflects the server broadcast, not the click).

## Reliability lifecycle (security-critical)

- [ ] **Kicked client does NOT rejoin** — an op kicks browser B. B's call tears
      down and B sees a terminal card ("You were kicked by <op>"). **B stays on that
      card and does not reappear** in anyone's grid. In B's devtools, confirm the
      WebSocket closed and there is **no** reconnect attempt.
- [ ] **Banned client does NOT rejoin** — an op bans browser B. B sees "You were
      banned by <op>" and does not rejoin. Reloading B's page and trying to join the
      same room again is refused with a "banned" error on the pre-join screen. This
      is the enforcement the ban depends on — verify it carefully.
- [ ] **Server-restart → reconnect + rejoin** — with A and B in a call, stop the
      server (Ctrl-C) and start it again. Each client shows a "Reconnecting…"
      indicator, then the socket reconnects and re-sends its join, so each client
      returns to the room (you reappear in your own grid; for an ad-hoc room the
      first to reconnect becomes op of the fresh instance). *Note: the media plane
      is re-established by renegotiation; after a full restart, reload a client if
      its video tiles do not resume. If ICE itself fails (not just the socket), the
      client now makes one silent ICE-restart attempt and, failing that, surfaces a
      "Media connection lost — reload to reconnect." prompt (see the media-failure
      check below); full media auto-recovery without a reload remains a follow-up.*
- [ ] **Transient network blip → rejoin** — briefly break connectivity (devtools
      "Offline", then back online, or block the port for a few seconds). The socket
      drops and reconnects with backoff; the client re-sends join and is back in the
      room's roster and chat (chat history is replayed, not duplicated).
- [ ] **Media path dies but socket stays up → reload prompt** — with A and B in a
      call, kill only the *media* path while leaving the WebSocket alive: drop the
      UDP/ICE traffic (firewall the SFU's media port, or force a NAT rebind /
      network change) without cutting the `/ws/` socket. The client makes one silent
      ICE-restart attempt; if the transport does not recover within a few seconds
      (`connectionState`/`iceConnectionState` stuck at `failed`), a non-blocking
      **"Media connection lost — reload to reconnect."** message appears in the call
      header. Crucially the socket is **not** closed — chat and the roster keep
      working — and reloading the page rebuilds the call. This is distinct from
      kicked/banned (which close the socket and never rejoin); here the WS is fine.
- [ ] **Tab close releases devices** — close a joined browser's tab. Its camera
      light goes out and, within the GC window, its tile disappears for everyone
      else (the server reaps it on socket close).

## Glare convergence (the Pion-no-rollback verification)

WebRTC glare = both sides offer at once. The client is the polite peer and rolls
its own offer back; the SFU (Pion) keeps its offer. This can only be verified in a
real browser — it's the manual check the Pion limitation requires.

- [ ] **Op renegotiation vs. client screenshare converge** — arrange a
      server-initiated renegotiation to collide with a client-initiated one: e.g.
      have a new participant join (which makes the SFU offer new forwarded tracks to
      B) at the same moment **B clicks Share screen** (which makes B offer). Repeat
      a few times to hit the overlap. Each time, both tracks must converge: B's
      screen-share tile appears for everyone AND B keeps receiving the newly
      forwarded tracks. No tile is permanently stuck black and no console error
      leaves the peer connection wedged in a non-`stable` signaling state.
