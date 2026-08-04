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
- [ ] **Join with mic off → others hear nothing until unmuted** — in the lobby click
      the mic toggle so it reads "Mic off" (muted), then Join. In another browser,
      confirm you are inaudible and your self tile shows a muted mic. Click Unmute
      in-call; the others now hear you. The lobby choice carried straight into the
      call (the Media instance is reused — no separate wiring).
- [ ] **Join with camera off → others see a placeholder** — in the lobby click the
      camera toggle so the preview shows the "Camera off" placeholder, then Join. In
      another browser, confirm your tile shows no live video (an off/placeholder
      state, not a frozen frame). Click Start video in-call; your camera appears for
      everyone.
- [ ] **Device switch preserves the off state** — in the lobby, toggle the mic
      and/or camera OFF, then switch the Microphone / Camera device via the dropdown.
      The new device stays off: the mic button still reads "Mic off" and the "Camera
      off" placeholder remains over the preview (the switch does not silently
      re-enable a muted/off track). Join and confirm the off state still holds.
- [ ] **Missing device disables its toggle** — on a machine (or profile) with no
      camera or no mic, the corresponding pre-join toggle is disabled rather than
      throwing, mirroring how the in-call control is disabled for a missing track.

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
- [ ] **Audio-only share ends cleanly** — share a tab with "Share tab audio" ticked
      but pick a surface with no video (or share audio only). Remote browsers get a
      screen tile showing the 🔊 **Sharing audio** placeholder plus a volume slider.
      Stop the share: on every remote browser the whole tile goes away — not just
      the slider. A black tile still captioned "Sharing audio", with no controls on
      it, is the failure this checks for.
- [ ] **Half a share ending keeps the other half** — share a tab WITH both video and
      audio, then stop only the audio (re-share the same surface without audio, or
      mute the tab at source). The screen tile must stay up showing the video, and
      lose only its volume slider. Conversely a share whose video ends while its
      audio continues must keep the tile and fall back to the 🔊 placeholder.
- [ ] **Active speaker highlights** — with 2+ remote participants, whoever is
      talking gets an accent-outlined tile; it follows the loudest voice and clears
      when the room goes quiet.
- [ ] **Per-participant volume (local only)** — each **remote** tile has a small
      volume slider (0–1, default full). Drag browser A's slider for B down to zero:
      A stops hearing B while A still hears everyone else, and **C's** perception of
      B is unchanged (it is purely local — no wire message, nothing broadcast). The
      level sticks if B toggles their camera/mic and the mic track re-attaches. Your
      own (self) tile has no slider. A remote screen-share tile shows a slider only
      when that share carries audio (this app shares video-only, so normally none).
- [ ] **Mute / camera controls work** — Mute toggles your mic (label flips
      Mute/Unmute, your tile's mic indicator turns off); Stop video toggles your
      camera (label + av indicator + your preview). Others stop hearing/seeing you.
- [ ] **Remote mute state propagates to everyone (incl. late joiners)** — with
      browsers A and B in the call, A clicks Mute. **B** (already in the call) sees
      A's tile mic indicator go crossed-out within a moment. Now join a **third**
      browser C: A's tile on C **starts** crossed-out (C learns A's stored muted
      state from the roster, not from any live event). A clicks Unmute → both B and C
      show A's mic live again. Repeat for the camera (Stop video / Start video): the
      remote camera/av indicator tracks it the same way, on both B and C.
- [ ] **Join muted → others see you muted immediately** — in the lobby toggle the
      mic (and/or camera) OFF, then Join. On every other browser already in the call,
      your tile shows the mic (and/or camera) crossed-out right away — you never
      briefly appear un-muted. Unmute in-call and the indicator clears for everyone.
- [ ] **Device switch mid-preview** — in the lobby, switch camera or mic; the new
      device is the one that goes live when you join (the preview updates, the other
      track keeps streaming).

## Synced countdown sound

- [ ] **Countdown plays for everyone** — with A, B, C joined, A clicks the 🚀
      countdown button. `RocketCountdown.mp3` starts for A (its click is a user
      gesture, so autoplay is allowed) and for B/C (best-effort — a browser may
      block the network-triggered playback until that tab has been interacted with;
      that is acceptable). A's button highlights and its title becomes "Stop the
      countdown".
- [ ] **Only the starter controls it; others are locked** — while A's countdown
      runs, B's and C's countdown buttons are disabled (locked, greyed) and cannot
      start or stop it. Only A can stop it.
- [ ] **Starter stop clears it for everyone** — A clicks the button again. The
      sound stops for A, B, and C and every button unlocks (returns to the idle 🚀).
- [ ] **Natural end unlocks everyone** — A starts the countdown and lets it play to
      the end without clicking. When A's audio finishes, A's client reports the end,
      the server clears the state, and every button unlocks on its own.
- [ ] **Starter leaving mid-countdown unlocks everyone** — A starts the countdown,
      then A leaves (or closes the tab). B and C stop hearing it and their buttons
      unlock — the control never stays stuck locked with no one able to stop it.
- [ ] **Non-starter cannot hijack** — while A's countdown runs, nothing B or C does
      (the disabled button, or a crafted frame) can stop A's run or start a second
      one; the server refuses silently and the UI stays consistent.

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
- [ ] **An op-forced mute updates everyone's indicator** — as an op, mute browser B's
      mic from B's tile. B's mic really goes silent, AND B's mic pill flips to
      crossed-out on **every** browser including the op's own, not just on B's. A
      mute that silences B while leaving their pill showing "unmuted" everywhere else
      reads to the op as "my mute did nothing" — that is the failure this checks for.
      Repeat for camera. Then have B un-mute themselves: the pill must come back on
      for everyone (the mute is a nudge, not a lock).
- [ ] **A refused moderation command does not end the call** — as an op, mute a
      participant who has *just* left (open their tile's menu, have them close their
      tab, then click mute). The server refuses with `no-such-peer`. You must get a
      line in the chat feed saying they already left, and **everything must keep
      working**: send a chat message, watch the roster, and mute someone else — all
      still fine. The old failure was silent and total: the socket stopped for good,
      so chat, the roster and every later moderation click died while video kept
      flowing, which made it look like op had been lost.
- [ ] **A refused join still lands on the lobby** — the other half of the same
      change. Join a locked room with the wrong password: the lobby (not the call)
      shows the error and the socket does not reconnect, exactly as before.
- [ ] **A forced mute is not remembered** — after being op-muted, B leaves and
      rejoins. B's lobby must NOT come back pre-muted: a forced mute is not B's own
      preference and must not decide how their next call starts.
- [ ] **Op stops a screenshare** — while browser B is sharing its screen, an op sees
      a **stop share** button on B's screen tile (a non-op does not). The op clicks
      it; B's share ends (B's Share-screen button flips back from "Stop share"), and
      B's screen tile disappears for **everyone**. B can start a new share afterward.
      Sending it when B is not sharing is a harmless no-op.
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
      This is the manual check for the screenshare re-offer fix: after B's polite
      rollback, `_onRemoteOffer` re-runs `_makeOffer`, so the screen is re-offered and
      **must** still reach the others rather than sitting silently unpublished on B's
      PC. Verify B's screen shows for every remote even when the glare is forced.

## Background blur and virtual backgrounds

The automated suite covers the effect catalogue, the frame-rate watchdog's pure
logic, and the vendored asset serving (gzip, content-type, SIMD-only). It cannot
cover segmentation quality, the blur's edge coverage, actual mask resolution,
thermal/battery behaviour, or tab-visibility interaction — those only exist in a
real browser with a real camera. **None of this feature's runtime behaviour has
been verified yet; every item below is an open check, not a confirmed result.**

- [ ] **Lobby catalogue** — open a room. The lobby's Background control shows
      two labelled rows: **EFFECTS** (None, Blur, Blur+, Aurora, Dusk, Grid,
      Depth, Paper — 8 chips) and **SCENES** (Office Space, Space Ghost, Star
      Trek, Idiocracy, Carina — 5 chips), thirteen chips in all.
- [ ] **Blur starts and lazy-loads once** — pick **Blur**. The preview blurs
      behind you within a few seconds. The first pick downloads ~3.4MB (Network
      tab: `vision_wasm_internal.wasm`, `Content-Encoding: gzip`); picking a
      different effect afterward does not re-download it.
- [ ] **Mask edge quality** — check the mask edge around **hair and shoulders**
      on Blur and on a virtual background. Some softness is expected; large
      chunks of head disappearing is not.
- [ ] **Virtual backgrounds fill the frame** — pick each of the 5 procedural
      backgrounds in turn, then each of the 5 image scenes in turn. Each should
      fill the frame completely — no camera visible at the edges, no flicker
      between frames.
- [ ] **Scene chips show their image** — every chip in the **Scenes** row shows a
      photo, not a flat colour rectangle. A flat chip means that asset failed to
      load: check the console for "background image … could not be loaded".
- [ ] **Scenes fill a non-16:9 frame** — the assets are 16:9. On a device whose
      camera offers 4:3, pick each scene and confirm it still fills the frame with
      no letterboxing and no stretching (it is centre-cropped).
- [ ] **No raw camera during a scene switch** — switch rapidly between scenes, and
      between a scene and a painted effect. A brief flat colour is expected while
      the image decodes; the unmasked camera background must never appear.
- [ ] **A scene survives a reload** — pick a scene in the lobby, join, reload.
      The lobby returns with that scene selected and its chip highlighted.
- [ ] **Blur edge coverage (vignette check)** — on both **Blur** and **Blur+**,
      look closely at the outer edge of the frame, ideally against something
      light or high-contrast behind you. A `clearRect` fix already stops the
      previous frame's pixels ghosting through, but the blurred draw still does
      not fully cover the canvas — the blur's alpha ramp leaves roughly the
      outer 8px (Blur) to 38px (Blur+, at 720p) partially transparent, which can
      read as a faint dark band. Check both strengths; it is most likely to be
      visible on **Blur+ at a large (720p+) frame**. **Verdict:** a band
      roughly matching that description is a known, accepted limitation —
      pass it. Fail only if the band is substantially larger or darker than
      described, if it appears on the **painted** (non-blur) backgrounds too
      (those are drawn to full coverage and should have no band at all), or if
      it shows as a hard cutoff rather than a soft transparency ramp.
- [ ] **Mask resolution and main-thread cost** — with an effect running, open
      devtools and find the actual dimensions of the confidence mask
      `_drawMaskedPerson` widens into an alpha channel each frame (log
      `mask.width`/`mask.height` in `internal/web/assets/lib/segmenter.js`, or
      inspect via the debugger). A code comment assumes a 256×256 mask (~65k
      elements/frame); if MediaPipe is actually returning the mask at the
      *input* resolution, 1280×720 would be ~921k iterations/frame — roughly
      22M writes/second on the main thread at the 24fps output rate. Check the
      Performance panel for how much main-thread time this loop actually costs.
      This determines whether low-end devices are protected by the watchdog or
      being crushed by this loop before the watchdog gets a chance to react.
      **Verdict:** record the observed mask dimensions and the measured
      per-frame cost — there's no pass/fail on the numbers themselves, but if
      the mask comes back at input resolution rather than the assumed
      256×256, that's a real finding worth its own follow-up issue, and
      `segmenter.js`'s "~65k elements" comment should be corrected to match
      whatever is actually observed either way.
- [ ] **Effect is visible to remotes** — join with an effect on. Confirm the
      self tile AND a second browser's remote tile both show it.
- [ ] **Survives camera off/on, device switch, and leave/rejoin** — turn the
      camera off and back on: the effect returns. Switch camera device: the
      effect survives on the new device. Leave and rejoin: the effect is
      restored from the saved preference.
- [ ] **Tab-away does not trip the watchdog** — with an effect on, switch to
      another tab for 10+ seconds, then come back. The published stream is
      expected to freeze for remote peers while the tab was hidden (`rAF`/`rVFC`
      stop firing in a hidden tab — a known, accepted trade-off), but the effect
      itself **must still be active** on return and must **not** have been
      switched off. The watchdog's verdict is explicitly suppressed while
      `document.hidden`; a revert here is a bug, not a pass.
- [ ] **Low light** — dim the room. Quality degrades — confirm it degrades
      rather than breaking (no strobing, no fully-lost subject).
- [ ] **Safari < 17 downscale fallback still blurs** — on a Safari below 17
      (no `CanvasRenderingContext2D.filter`), Blur still works via the
      downscale fallback, though visibly coarser, and the mask edge is harder.
      Confirm it is not simply unblurred.
- [ ] **Mobile: watchdog holds or reverts cleanly** — on the oldest phone
      available, pick a virtual background and leave the call running for two
      minutes. Either it holds a usable frame rate, **or** it reverts to None
      with the notice **"Background turned off — this device couldn't keep
      up."** Both are passes; a sustained low-fps feed with no revert is a
      failure. Note battery and thermal behaviour over those two minutes.
- [ ] **Mobile: the pipeline-failure notice is distinct from the watchdog
      notice** — the picker shows two different notices depending on why an
      effect didn't stick, and both need checking, not just the watchdog one
      above. Force a start failure (e.g. block network requests matching
      `/vendor/mediapipe/` in devtools, or go offline, right as you pick an
      effect) and confirm the notice reads **"That background could not be
      started."** — not the watchdog's wording — and that the raw camera keeps
      streaming rather than going black.
- [ ] **A revert is never permanent** — after a revert (either notice above),
      reload the page. The effect must come back rather than staying off — the
      reverted state is deliberately not persisted, precisely so a bad watchdog
      call on one occasion doesn't disable the feature for good.

## Backgrounds on a machine without WebGL

MediaPipe's vision graph is GL-based no matter what `delegate` is set to, so with
hardware acceleration off there is no working configuration. This was a real
production failure: `glActiveTexture` threw once per frame forever, and
`delegate: "CPU"` failed identically. `segmenter.js` now refuses up front.

To reproduce the no-WebGL state, launch Chrome with `--disable-gpu`, or turn off
"Use graphics acceleration when available" in Settings → System and restart. Then:

- [ ] Confirm the browser really has no WebGL — in the console,
      `document.createElement("canvas").getContext("webgl2")` should be `null`.
- [ ] Open a room and pick any background.
      **Verdict:** exactly one notice appears — "Backgrounds need WebGL, which this
      browser has turned off. Enable hardware acceleration in your browser
      settings, then reload." — every chip except **None** becomes disabled, and
      the camera keeps sending unprocessed video. Fail if the console shows
      repeating `frame failed` errors, if the notice blames the device for being
      too slow, or if the chips stay clickable.
- [ ] Confirm the console shows no per-frame spam: at most one `frame failed`
      line per run of failures, not one per frame.
- [ ] Re-enable acceleration, restart the browser, reload, and pick a background.
      **Verdict:** it works normally, and a previously saved preference is still
      there — the unsupported state must never have been persisted over it.
