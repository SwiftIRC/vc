// In-call controls: a local control bar for every participant, plus op-only
// moderation.
//
// Local controls (all participants):
//   - mute        -> Media.toggleMic()
//   - camera      -> Media.toggleCamera()
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

    // Chat toggle: shows/hides the (default-hidden) chat panel; the badge counts
    // unread messages that arrive while the panel is closed.
    this.chatBadge = el("span", { class: "chat-badge", hidden: true });
    this.chatBtn = el(
      "button",
      { type: "button", class: "ctl chat", title: "Toggle chat", onClick: () => this._toggleChat() },
      el("span", { text: "Chat" }),
      this.chatBadge,
    );

    const leaveBtn = el("button", { type: "button", class: "ctl leave", onClick: () => this.onLeave() }, "Leave");

    // A mic/camera button is meaningless with no such track; disable it up front.
    if (!(this.media && this.media.micTrack)) this.muteBtn.disabled = true;
    if (!(this.media && this.media.cameraTrack)) this.cameraBtn.disabled = true;

    this._setMicButton(this.media && this.media.micTrack ? this.media.micTrack.enabled : false);
    this._setCameraButton(this.media && this.media.cameraTrack ? this.media.cameraTrack.enabled : false);
    this._setScreenButton(false);

    // Lock indicator (everyone) + lock toggle (op only).
    this.lockStatus = el("span", { class: "lock-status", hidden: true, text: "Room locked" });
    const children = [this.muteBtn, this.cameraBtn, this.screenBtn, this.chatBtn];
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
  }

  _toggleCamera() {
    if (!this.media) return;
    const enabled = this.media.toggleCamera();
    this._setCameraButton(enabled);
    if (this.grid) this.grid.refreshSelf();
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

  _onScreenStarted(e) {
    const track = e && e.detail ? e.detail.track : null;
    if (this.peer && track) this.peer.publish(track, "screen");
    this.sharing = true;
    this._setScreenButton(true);
  }

  _onScreenStopped() {
    if (this.peer) this.peer.unpublish("screen"); // idempotent when no sender
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

  // --- op controls ---

  // Build a remote tile's op-action group, or null for non-ops (so no op markup
  // is ever created for a non-op). Called by grid.js per remote tile.
  opActionsFor(participant) {
    if (!this.isOp || !participant || !participant.id) return null;
    const id = participant.id;
    return el(
      "div",
      { class: "op-actions" },
      el("button", { type: "button", class: "op kick", title: "Kick", onClick: () => this._send("kick", { id }) }, "kick"),
      el("button", { type: "button", class: "op mute", title: "Mute mic", onClick: () => this._send("mute-peer", { id, kind: "mic" }) }, "mute"),
      el("button", { type: "button", class: "op ban", title: "Ban", onClick: () => this._send("ban", { id }) }, "ban"),
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
  }
}
