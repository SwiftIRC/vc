// In-call controls: a local control bar for every participant, plus op-only
// moderation.
//
// Local controls (all participants):
//   - mute        -> Media.toggleMic() (just disables the track; device stays open)
//   - camera      -> Media.enableCamera()/disableCamera() (releases the device when
//                    off, so its indicator light goes out; re-acquires when on)
//   - screenshare -> Media.startScreen()/stopScreen(); the resulting track is
//                    published to / unpublished from the SFU as kind "screen".
//   - leave       -> onLeave() (app.js tears the call down)
// Button labels always reflect live state. Screen state is driven off Media's
// own screen-start/screen-stop events so the browser's native "Stop sharing"
// UI keeps the button (and the SFU publication) honest.
//
// Op controls (only when the joined role is "op"):
//   - per remote tile: kick / mute / ban  -> Signaling "kick" | "mute-peer" |
//     "ban" {id, kind?}. opActionsFor(participant) returns the tile's button
//     group; grid.js places it. Non-ops get null, so the markup never exists.
//   - a room lock toggle -> Signaling "set-lock" {password?} (empty password
//     unlocks). The lock INDICATOR reflects the authoritative room-locked /
//     room-unlocked broadcasts, never the click.
//
// Inbound "muted" {kind} (an op muted THIS client) disables the named local
// track as a re-enableable nudge and reflects it on the buttons + self tile.

import { loadMediaPrefs, saveMediaPrefs } from "../lib/prefs.js";

// Tiny DOM helper: el("button", {class:"x", onClick:fn}, "text"). The "text" key
// sets textContent, so any caller string is inert markup-wise.
function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) node.setAttribute(k, "");
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const kid of kids) if (kid != null) node.append(kid);
  return node;
}

export class Controls {
  // { media, peer, signaling, role, onLeave }. role is the joined role; only "op"
  // renders moderation. Call attachGrid(grid) after construction so toggles can
  // refresh the self tile's indicators.
  constructor({ media, peer, signaling, role, onLeave } = {}) {
    this.media = media || null;
    this.peer = peer || null;
    this.signaling = signaling || null;
    this.isOp = role === "op";
    this.onLeave = typeof onLeave === "function" ? onLeave : () => {};
    this.grid = null;

    this.sharing = false; // local screen-share active?
    this.locked = false; // authoritative room lock state (from broadcasts)

    // Synced countdown sound. State is driven ENTIRELY by the server's
    // countdown broadcasts (non-authoritative UI): countdownActive locks the
    // control for everyone, countdownByMe is true only for the participant who
    // started this run (they alone may stop it). _startPending records that WE
    // just asked to start, so when the accepting broadcast returns we know it is
    // ours. The Audio element is created lazily on first use.
    this.countdownActive = false;
    this.countdownByMe = false;
    this._startPending = false;
    this.countdownAudio = null;
    this._onCountdownEnded = () => this._reportCountdownEnded();
    this.nsOn = false; // noise suppression active? (opt-in; default OFF, like Jitsi)
    this.nsBusy = false; // true while the ~2MB worklet loads / graph (re)builds

    this._build();

    // Screen state follows Media's events: startScreen/stopScreen AND the
    // browser's own "Stop sharing" UI both surface here, so the button and the
    // SFU publication stay in sync no matter who ended the share.
    this._onScreenStart = (e) => this._onScreenStarted(e);
    this._onScreenStop = () => this._onScreenStopped();
    if (this.media) {
      this.media.addEventListener("screen-start", this._onScreenStart);
      this.media.addEventListener("screen-stop", this._onScreenStop);
    }

    // Chat panel state (wired via attachChat).
    this.chat = null;
    this.chatOpen = false;
    this.unread = 0;

    // Autohide: reveal on any pointer/keyboard activity, hide after a few seconds
    // idle. Window-level so activity anywhere on the call surface counts.
    this._hideDelayMs = 3000;
    this._hideTimer = null;
    this._activityEvents = ["mousemove", "mousedown", "touchstart", "keydown", "focusin"];
    this._onActivity = () => this._revealControls();
    for (const ev of this._activityEvents) {
      window.addEventListener(ev, this._onActivity, { passive: true });
    }
    this._revealControls(); // start visible, then arm the idle timer
  }

  attachGrid(grid) {
    this.grid = grid || null;
  }

  // --- chat panel toggle ---

  // Wire the chat panel so the toggle button shows/hides it. The panel starts
  // hidden; keep the button + unread badge in sync with that.
  attachChat(chat) {
    this.chat = chat || null;
    this.chatOpen = false;
    if (this.chat) this.chat.setVisible(false);
    this._clearUnread();
    this._setChatButton();
  }

  _toggleChat() {
    if (!this.chat) return;
    this.chatOpen = !this.chatOpen;
    this.chat.setVisible(this.chatOpen);
    if (this.chatOpen) this._clearUnread();
    this._setChatButton();
  }

  // Called by app.js on every inbound chat frame. While the panel is closed this
  // bumps an unread badge so new messages don't go unnoticed.
  notifyChatActivity() {
    if (this.chatOpen) return;
    this.unread += 1;
    this.chatBadge.textContent = this.unread > 99 ? "99+" : String(this.unread);
    this.chatBadge.hidden = false;
  }

  _clearUnread() {
    this.unread = 0;
    this.chatBadge.textContent = "";
    this.chatBadge.hidden = true;
  }

  _setChatButton() {
    this.chatBtn.classList.toggle("active", this.chatOpen);
  }

  // --- autohide control bar ---

  _revealControls() {
    this.el.classList.remove("is-hidden");
    if (this._hideTimer) clearTimeout(this._hideTimer);
    this._hideTimer = setTimeout(() => this._maybeHide(), this._hideDelayMs);
  }

  _maybeHide() {
    this._hideTimer = null;
    // Never hide while a control has focus (keyboard users) — reschedule instead.
    if (this.el.contains(document.activeElement)) {
      this._hideTimer = setTimeout(() => this._maybeHide(), this._hideDelayMs);
      return;
    }
    this.el.classList.add("is-hidden");
  }

  _build() {
    this.muteBtn = el("button", { type: "button", class: "ctl mic", onClick: () => this._toggleMic() });
    this.cameraBtn = el("button", { type: "button", class: "ctl cam", onClick: () => this._toggleCamera() });
    this.screenBtn = el("button", { type: "button", class: "ctl screen", onClick: () => this._toggleScreen() });
    // Noise suppression: opt-in (default OFF — it adds CPU/latency, so the user
    // enables it), and disabled while the large worklet loads on first enable.
    this.nsBtn = el("button", { type: "button", class: "ctl ns", title: "Microphone noise suppression", onClick: () => this._onNsToggle() });

    // Chat toggle: shows/hides the (default-hidden) chat panel; the badge counts
    // unread messages that arrive while the panel is closed.
    this.chatBadge = el("span", { class: "chat-badge", hidden: true });
    // Compact icon toggle (title/aria give it an accessible name) so it doesn't
    // dominate the control bar; the badge counts unread while the panel is closed.
    this.chatBtn = el(
      "button",
      { type: "button", class: "ctl chat icon", title: "Toggle chat", "aria-label": "Toggle chat", onClick: () => this._toggleChat() },
      el("span", { class: "glyph", text: "💬" }),
      this.chatBadge,
    );

    // Countdown: a compact icon (matching the chat toggle) that plays the shared
    // rocket-countdown sound for everyone, synchronized. Non-authoritative — the
    // click just sends intent; the server's broadcast drives the actual state.
    this.countdownBtn = el(
      "button",
      { type: "button", class: "ctl countdown icon", title: "Play countdown for everyone", "aria-label": "Play countdown for everyone", onClick: () => this._toggleCountdown() },
      el("span", { class: "glyph", text: "🚀" }),
    );

    const leaveBtn = el("button", { type: "button", class: "ctl leave", onClick: () => this.onLeave() }, "Leave");

    // A mic/camera button is meaningless with no such track; disable it up front.
    // Noise suppression likewise needs a mic to process.
    if (!(this.media && this.media.micTrack)) this.muteBtn.disabled = true;
    // Enabled whenever a camera EXISTS (even if joined with it off, so it can be
    // turned back on), not only when a track is currently live.
    if (!(this.media && this.media.cameraAvailable)) this.cameraBtn.disabled = true;

    this._setMicButton(this.media && this.media.micTrack ? this.media.micTrack.enabled : false);
    this._setCameraButton(!!(this.media && this.media.cameraTrack));
    this._setScreenButton(false);
    this._setNsButton(false, false); // default OFF
    this._setCountdownButton();

    // Lock indicator (everyone) + lock toggle (op only).
    this.lockStatus = el("span", { class: "lock-status", hidden: true, text: "Room locked" });
    const children = [this.muteBtn, this.cameraBtn, this.screenBtn, this.nsBtn, this.countdownBtn, this.chatBtn];
    if (this.isOp) {
      this.lockBtn = el("button", { type: "button", class: "ctl lock", onClick: () => this._toggleLock() });
      this._setLockButton(false);
      children.push(this.lockBtn);
    }
    children.push(this.lockStatus, leaveBtn);

    this.el = el("div", { class: "controls" }, ...children);
  }

  // --- local controls ---

  _toggleMic() {
    if (!this.media) return;
    const enabled = this.media.toggleMic();
    this._setMicButton(enabled);
    if (this.grid) this.grid.refreshSelf();
    this.sendMediaState(); // tell the room so remote mute indicators update
  }

  async _toggleCamera() {
    if (!this.media) return;
    // Camera OFF releases the device (indicator light off); ON re-acquires it.
    // Guard the button across the async re-acquire so a double-click cannot overlap
    // two getUserMedia captures.
    const turningOn = !this.media.cameraTrack;
    this.cameraBtn.disabled = true;
    try {
      if (turningOn) await this.media.enableCamera();
      else this.media.disableCamera();
    } catch {
      /* re-acquire failed (permission/device busy): leave the camera off */
    }
    this.cameraBtn.disabled = !(this.media && this.media.cameraAvailable);
    this._setCameraButton(!!this.media.cameraTrack);
    if (this.grid) this.grid.refreshSelf();
    this.sendMediaState(); // tell the room so remote camera indicators update
  }

  // Broadcast this client's CURRENT mic + camera enabled state to the room. A
  // missing track counts as OFF. Called on every local mic/camera toggle and once
  // by app.js right after join, so a client that joined muted/camera-off (a
  // pre-join toggle) is seen correctly — the server otherwise stored the default
  // (on). Idempotent to re-send.
  sendMediaState() {
    const mic = !!(this.media && this.media.micTrack && this.media.micTrack.enabled);
    const camera = !!(this.media && this.media.cameraTrack && this.media.cameraTrack.enabled);
    this._send("media-state", { mic, camera });
    saveMediaPrefs({ mic, camera }); // remember for the next call's lobby
  }

  _toggleScreen() {
    if (!this.media) return;
    if (this.sharing) {
      this.media.stopScreen(); // -> screen-stop -> unpublish + button
    } else {
      // Rejection (user cancelled the picker) is non-fatal; Media emits its own
      // error and no screen-start fires, so the button simply stays "Share screen".
      this.media.startScreen().catch(() => {});
    }
  }

  // Toggle mic noise suppression. First enable loads the ~2MB worklet, so disable
  // the button and show "Loading…" until Media settles. Media re-reads its own
  // authoritative state (noiseSuppressionOn), so a load failure (raw mic left in
  // place) simply lands us back on OFF — the user is never stuck.
  // Turn on noise suppression by default at call start (opt-out via the button).
  // Called after peer.start so the mic sender exists for the processed-track swap.
  enableDefaultNoiseSuppression() {
    if (loadMediaPrefs().ns === false) return; // user last turned denoise OFF — respect it
    if (this.media && this.media.micTrack && !this.nsOn && !this.nsBusy) {
      this._toggleNoiseSuppression();
    }
  }

  // The denoise BUTTON handler: toggle, then persist the settled state. Kept separate
  // from _toggleNoiseSuppression so the default-on path (and a worklet-load failure)
  // never writes a preference — only an explicit user click does.
  async _onNsToggle() {
    await this._toggleNoiseSuppression();
    saveMediaPrefs({ ns: this.nsOn });
  }

  async _toggleNoiseSuppression() {
    if (!this.media || this.nsBusy) return;
    const target = !this.nsOn;
    this.nsBusy = true;
    this._setNsButton(this.nsOn, true);
    try {
      await this.media.setNoiseSuppression(target);
    } catch (err) {
      console.error("noise suppression toggle failed", err);
    } finally {
      this.nsBusy = false;
      this.nsOn = !!this.media.noiseSuppressionOn; // trust Media's real state
      this._setNsButton(this.nsOn, false);
    }
  }

  _onScreenStarted(e) {
    const detail = (e && e.detail) || {};
    if (this.peer && detail.track) this.peer.publish(detail.track, "screen");
    // Publish tab/system audio too when the user opted to share it (separate kind so
    // it forwards as its own track, keyed distinctly from the screen video).
    if (this.peer && detail.audioTrack) this.peer.publish(detail.audioTrack, "screen-audio");
    this.sharing = true;
    this._setScreenButton(true);
  }

  _onScreenStopped() {
    if (this.peer) {
      this.peer.unpublish("screen"); // idempotent when no sender
      this.peer.unpublish("screen-audio");
    }
    this.sharing = false;
    this._setScreenButton(false);
  }

  // --- inbound moderation reflected on this client ---

  // An op muted THIS client. Disable the named local track (re-enableable: the
  // user can click the control to turn it back on — it's a nudge, not a lock).
  onMuted(kind) {
    if (!this.media) return;
    if (kind === "mic") {
      const t = this.media.micTrack;
      if (t && t.enabled) {
        t.enabled = false;
        this._setMicButton(false);
        if (this.grid) this.grid.refreshSelf();
      }
    } else if (kind === "camera") {
      const t = this.media.cameraTrack;
      if (t && t.enabled) {
        t.enabled = false;
        this._setCameraButton(false);
        if (this.grid) this.grid.refreshSelf();
      }
    } else if (kind === "screen") {
      this.media.stopScreen(); // -> screen-stop -> unpublish + button
    }
  }

  // Authoritative room lock state from a room-locked / room-unlocked broadcast.
  onLock(locked) {
    this.locked = !!locked;
    this.lockStatus.hidden = !this.locked;
    if (this.lockBtn) this._setLockButton(this.locked);
  }

  // --- synced countdown sound ---

  // Click handler. Non-authoritative: we only send intent and let the server's
  // broadcast flip our state. When idle, ask to start (and remember it was us,
  // so the accepting broadcast is recognized as ours). When WE own an active
  // run, ask to stop. When someone else owns it the button is disabled, so the
  // active/not-mine branch is unreachable from a click.
  _toggleCountdown() {
    if (this.countdownActive) {
      if (this.countdownByMe) this._send("countdown", { action: "stop" });
      return;
    }
    this._startPending = true;
    this._send("countdown", { action: "start" });
  }

  // Inbound `countdown` {action, by} broadcast. On start, lock the control for
  // everyone and play the sound (ours iff we had a start pending); on stop,
  // unlock and reset. The audio itself is best-effort (see _playCountdown).
  onCountdown(msg = {}) {
    const action = msg && msg.action;
    if (action === "start") {
      this.countdownActive = true;
      this.countdownByMe = this._startPending;
      this._startPending = false;
      this._setCountdownButton();
      this._playCountdown();
    } else if (action === "stop") {
      this.countdownActive = false;
      this.countdownByMe = false;
      this._startPending = false;
      this._setCountdownButton();
      this._stopCountdown();
    }
  }

  // Reflect countdown state on the button. While a run is active the control is
  // locked for everyone EXCEPT its starter, who sees a highlighted "stop"
  // affordance.
  _setCountdownButton() {
    const active = this.countdownActive;
    const mine = this.countdownByMe;
    this.countdownBtn.classList.toggle("active", active);
    this.countdownBtn.disabled = active && !mine;
    this.countdownBtn.title = active
      ? mine
        ? "Stop the countdown"
        : "Countdown in progress"
      : "Play countdown for everyone";
  }

  // Lazily build the Audio element and wire its natural-end handler once.
  _countdownSound() {
    if (!this.countdownAudio) {
      this.countdownAudio = new Audio("/RocketCountdown.mp3");
      this.countdownAudio.addEventListener("ended", this._onCountdownEnded);
    }
    return this.countdownAudio;
  }

  _playCountdown() {
    const audio = this._countdownSound();
    try {
      audio.currentTime = 0;
    } catch {}
    // Autoplay policy: for the STARTER this play() runs in the call stack of
    // their click (a user gesture), so it is allowed. For OTHERS it is triggered
    // by a network message and the browser may block it — that is acceptable and
    // best-effort. Swallow the rejection so it is not an unhandled promise.
    const p = audio.play();
    if (p && typeof p.catch === "function") p.catch(() => {});
  }

  _stopCountdown() {
    if (!this.countdownAudio) return;
    this.countdownAudio.pause();
    try {
      this.countdownAudio.currentTime = 0;
    } catch {}
  }

  // The sound finished on its own. Only the starter reports the end, which lets
  // the server clear the authoritative state and unlock the control for everyone
  // (others just let their own copy finish). A manual stop pauses instead, so it
  // never fires this.
  _reportCountdownEnded() {
    if (this.countdownByMe) this._send("countdown", { action: "stop" });
  }

  // --- op controls ---

  // Build a remote tile's op-action group, or null for non-ops (so no op markup
  // is ever created for a non-op). Called by grid.js per remote tile.
  opActionsFor(participant) {
    if (!this.isOp || !participant || !participant.id) return null;
    const id = participant.id;
    return el(
      "div",
      { class: "op-actions" },
      el("button", { type: "button", class: "op makeop", title: "Make op", onClick: () => this._send("grant-op", { id }) }, "+op"),
      el("button", { type: "button", class: "op kick", title: "Kick", onClick: () => this._send("kick", { id }) }, "kick"),
      el("button", { type: "button", class: "op mute", title: "Mute mic", onClick: () => this._send("mute-peer", { id, kind: "mic" }) }, "mute"),
      el("button", { type: "button", class: "op ban", title: "Ban", onClick: () => this._send("ban", { id }) }, "ban"),
    );
  }

  // The local participant was just promoted to op mid-call: gain the op controls
  // (the room lock button) and add op actions to every existing remote tile. New
  // tiles get them automatically — opActionsFor now returns markup since isOp is true.
  // Idempotent: a repeat call after already being op does nothing.
  becomeOp() {
    if (this.isOp) return;
    this.isOp = true;
    if (!this.lockBtn) {
      this.lockBtn = el("button", { type: "button", class: "ctl lock", onClick: () => this._toggleLock() });
      this._setLockButton(this.locked);
      this.el.insertBefore(this.lockBtn, this.lockStatus); // lock sits just before the lock indicator + Leave
    }
    if (this.grid) this.grid.addOpControls();
  }

  // Build a remote SCREEN tile's op-action group (a single "Stop screenshare"
  // action), or null for non-ops. Reuses the existing mute-peer mechanism with
  // kind:"screen"; the server nudges the sharer, whose onMuted("screen") handler
  // stops the share and unpublishes it. Called by grid.js per remote screen tile.
  screenOpActionsFor(participant) {
    if (!this.isOp || !participant || !participant.id) return null;
    const id = participant.id;
    return el(
      "div",
      { class: "op-actions" },
      el(
        "button",
        { type: "button", class: "op stopshare", title: "Stop screenshare", onClick: () => this._send("mute-peer", { id, kind: "screen" }) },
        "stop share",
      ),
    );
  }

  _toggleLock() {
    if (this.locked) {
      this._send("set-lock", {}); // empty password = unlock
      return;
    }
    const password = window.prompt("Set a room password to lock:");
    if (password) this._send("set-lock", { password });
  }

  _send(type, fields) {
    if (this.signaling) this.signaling.send(type, fields);
  }

  // --- button labels ---

  _setMicButton(enabled) {
    this.muteBtn.textContent = enabled ? "Mute" : "Unmute";
    this.muteBtn.classList.toggle("active", !enabled);
  }

  _setCameraButton(enabled) {
    this.cameraBtn.textContent = enabled ? "Stop video" : "Start video";
    this.cameraBtn.classList.toggle("active", !enabled);
  }

  _setScreenButton(sharing) {
    this.screenBtn.textContent = sharing ? "Stop share" : "Share screen";
    this.screenBtn.classList.toggle("active", sharing);
  }

  _setLockButton(locked) {
    if (!this.lockBtn) return;
    this.lockBtn.textContent = locked ? "Unlock room" : "Lock room";
    this.lockBtn.classList.toggle("active", locked);
  }

  // Reflect noise-suppression state. `busy` shows a loading/disabled state while
  // the worklet loads; the button is also disabled when there is no mic to process.
  _setNsButton(on, busy) {
    this.nsBtn.textContent = busy ? "Loading…" : on ? "Denoise on" : "Denoise off";
    this.nsBtn.classList.toggle("active", on && !busy);
    this.nsBtn.classList.toggle("loading", busy);
    this.nsBtn.disabled = busy || !(this.media && this.media.micTrack);
  }

  // Detach Media + activity listeners and cancel the idle timer. After this the
  // control bar drives nothing and holds no timers.
  destroy() {
    if (this.media) {
      this.media.removeEventListener("screen-start", this._onScreenStart);
      this.media.removeEventListener("screen-stop", this._onScreenStop);
    }
    for (const ev of this._activityEvents) {
      window.removeEventListener(ev, this._onActivity);
    }
    if (this._hideTimer) {
      clearTimeout(this._hideTimer);
      this._hideTimer = null;
    }
    // Stop and release the countdown Audio so it doesn't keep playing after the
    // call is torn down.
    if (this.countdownAudio) {
      this.countdownAudio.removeEventListener("ended", this._onCountdownEnded);
      this.countdownAudio.pause();
      this.countdownAudio.src = "";
      this.countdownAudio = null;
    }
  }
}
