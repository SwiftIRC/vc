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

import { loadMediaPrefs, saveMediaPrefs, loadLayoutPrefs, saveLayoutPrefs } from "../lib/prefs.js";
import { QUALITY_TIERS } from "../lib/quality.js";
import { svgIcon, MIC_PATHS, MIC_OFF_PATHS, CAM_PATHS, CAM_OFF_PATHS, EYE_PATHS, EYE_OFF_PATHS, SPEAKER_PATHS, SPEAKER_OFF_PATHS } from "../lib/icons.js";
import { confirmDialog } from "../lib/confirm.js";
import { primeAudio, unlockSounds } from "../lib/sounds.js";
import { BackgroundPicker } from "./background.js";

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

// Camera-grid column choices: Auto (value null) or a fixed 2/3/4.
const COLS_OPTIONS = [
  { label: "Auto", value: null },
  { label: "2", value: 2 },
  { label: "3", value: 3 },
  { label: "4", value: 4 },
];

// True when a key event's target is a control the browser already handles Space for
// (typing into a field, or activating a focused button/link) — so push-to-talk leaves
// Space alone there.
function isInteractive(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  switch (el.tagName) {
    case "INPUT":
    case "TEXTAREA":
    case "SELECT":
    case "OPTION":
    case "BUTTON":
    case "A":
      return true;
    default:
      return false;
  }
}

export class Controls {
  // { media, peer, signaling, role, onLeave }. role is the joined role; only "op"
  // renders moderation. Call attachGrid(grid) after construction so toggles can
  // refresh the self tile's indicators.
  constructor({ media, peer, signaling, role, onLeave, lowBandwidth, onLowBandwidth } = {}) {
    this.media = media || null;
    this.peer = peer || null;
    this.signaling = signaling || null;
    this.isOp = role === "op";
    this.onLeave = typeof onLeave === "function" ? onLeave : () => {};
    // Per-user "data saver": when on, this client downloads no video (audio only).
    // Local and independent of everyone else; onLowBandwidth lets app.js (un)gate our
    // downlink and persist the choice. The initial value is the restored preference.
    this.lowBandwidth = !!lowBandwidth;
    this.onLowBandwidth = typeof onLowBandwidth === "function" ? onLowBandwidth : () => {};
    this.grid = null;

    // Pinned camera-grid column count (2/3/4) or null for auto, restored from last time.
    const savedCols = loadLayoutPrefs().columns;
    this._cols = savedCols === 2 || savedCols === 3 || savedCols === 4 ? savedCols : null;

    // Hide-self-view: hide our OWN camera tile from our OWN grid (local only), restored.
    this._selfHidden = !!loadLayoutPrefs().selfHidden;

    // Chosen audio-output device (setSinkId), restored; "" = the browser default output.
    this._speakerId = loadMediaPrefs().speakerId || "";

    // Current session video caps (tier ids), kept in sync via setQualityState so the op
    // menu — built now or on a mid-call promotion — always reflects the live values.
    this._qCam = "auto";
    this._qScr = "auto";

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

    // iOS Safari blocks HTMLAudioElement.play() outside a user gesture until the
    // element has been played once within one. The countdown and chimes are played
    // from network events, so prime every sound element on the first REAL gesture in
    // the call (once), then drop these listeners. mousemove is deliberately excluded —
    // it is not a user-activation gesture.
    this._audioUnlocked = false;
    this._audioUnlockEvents = ["touchstart", "mousedown", "keydown"];
    this._onAudioUnlock = () => {
      if (this._audioUnlocked) return;
      this._audioUnlocked = true;
      primeAudio(this._countdownSound());
      unlockSounds();
      this._removeAudioUnlock();
    };
    for (const ev of this._audioUnlockEvents) {
      window.addEventListener(ev, this._onAudioUnlock, { passive: true });
    }

    // Push-to-talk: hold Space to go live while muted, release to re-mute. Separate
    // (non-passive) key listeners so they can preventDefault the page scroll.
    this._pttHeld = false; // Space currently held for PTT
    this._pttUnmuted = false; // we temporarily unmuted for this hold
    this._onKeyDown = (e) => this._pttKeyDown(e);
    this._onKeyUp = (e) => this._pttKeyUp(e);
    this._onWinBlur = () => this._pttRelease(); // releasing focus while held must re-mute
    window.addEventListener("keydown", this._onKeyDown);
    window.addEventListener("keyup", this._onKeyUp);
    window.addEventListener("blur", this._onWinBlur);
    // Close the Share / mic / camera popovers on any pointer-down outside them.
    this._onDocPointer = (e) => {
      if (this.shareMenu && !this.shareMenu.hidden && this.shareWrap && !this.shareWrap.contains(e.target)) {
        this.shareMenu.hidden = true;
      }
      if (this.micMenu && !this.micMenu.hidden && this.micWrap && !this.micWrap.contains(e.target)) {
        this.micMenu.hidden = true;
        this.micArrow.setAttribute("aria-expanded", "false");
      }
      if (this.cameraMenu && !this.cameraMenu.hidden && this.cameraWrap && !this.cameraWrap.contains(e.target)) {
        this.cameraMenu.hidden = true;
        this.cameraArrow.setAttribute("aria-expanded", "false");
      }
      if (this.settingsMenu && !this.settingsMenu.hidden && this.settingsWrap && !this.settingsWrap.contains(e.target)) {
        this.settingsMenu.hidden = true;
        this.settingsBtn.setAttribute("aria-expanded", "false");
      }
    };
    document.addEventListener("pointerdown", this._onDocPointer);
    this._revealControls(); // start visible, then arm the idle timer
  }

  attachGrid(grid) {
    this.grid = grid || null;
    if (this.grid && this._cols) this.grid.setColumns(this._cols); // apply the restored choice
    if (this.grid) this.grid.setSelfHidden(this._selfHidden); // restore hide-self-view
    if (this.grid && this._speakerId) this.grid.setAudioOutput(this._speakerId); // restore output device
  }

  // --- chat panel toggle ---

  // Wire the chat panel so the toggle button shows/hides it. The panel starts
  // hidden; keep the button + unread badge in sync with that.
  attachChat(chat) {
    this.chat = chat || null;
    this.chatOpen = false;
    if (this.chat) this.chat.setVisible(false);
    if (this.chat) this.chat.setOp(this.isOp);
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

  // Close the panel from outside the control bar — the chat pane's own ✕ routes here
  // rather than hiding itself, so this stays the single owner of chatOpen and the
  // toggle button can never disagree with what's on screen. Idempotent.
  closeChat() {
    if (!this.chat || !this.chatOpen) return;
    // Hiding the panel takes whatever was focused inside it (the compose box, the ✕)
    // out of the page, which drops keyboard focus to <body> — so Tab would restart from
    // the top of the document. Hand focus to the toggle instead: it is where the panel
    // came from, and Enter there reopens it.
    const refocus = this.chat.el && this.chat.el.contains(document.activeElement);
    this.chatOpen = false;
    this.chat.setVisible(false);
    this._setChatButton();
    if (refocus) this.chatBtn.focus();
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
    document.body.classList.remove("ui-idle");
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
    document.body.classList.add("ui-idle");
  }

  _build() {
    // Mic + camera are SPLIT buttons: the main button toggles mute/video, and a caret
    // on its right opens a small menu to switch that input's device on the fly. Each
    // menu is populated fresh on open (labels/ids appear once permission is granted;
    // hot-plugged devices show up), and a change hot-swaps via replaceTrack — no
    // renegotiation, and for the mic the NS graph is rebuilt.
    this.muteBtn = el("button", { type: "button", class: "ctl mic icon", onClick: () => this._toggleMic() });
    this.micSelect = el("select", { class: "device", onChange: () => this._switchMicDevice() });
    // Output-device selection rides in the SAME mic menu (saves a control-bar button), but
    // only where the browser can actually switch outputs (Chrome/Edge/Firefox; NOT iOS).
    this._outputSupported = typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
    this.speakerSelect = this._outputSupported
      ? el("select", { class: "device", onChange: () => this._switchSpeakerDevice() })
      : null;
    this.micArrow = this._deviceArrow("Choose microphone", () => this._toggleMicMenu());
    this.micMenu = this._deviceMenu2("Microphone", this.micSelect, "Speaker", this.speakerSelect);
    this.micWrap = el("div", { class: "split-ctl" }, this.muteBtn, this.micArrow, this.micMenu);

    this.cameraBtn = el("button", { type: "button", class: "ctl cam icon", onClick: () => this._toggleCamera() });
    this.cameraSelect = el("select", { class: "device", onChange: () => this._switchCameraDevice() });
    this.cameraArrow = this._deviceArrow("Choose camera", () => this._toggleCameraMenu());
    this.cameraMenu = this._deviceMenu("Camera", this.cameraSelect);
    this.cameraWrap = el("div", { class: "split-ctl" }, this.cameraBtn, this.cameraArrow, this.cameraMenu);
    // "Share" opens a small menu (Screen / Audio) when idle; while sharing it becomes
    // "Stop share" and a click stops it. One share at a time (one screenStream).
    this.shareBtn = el("button", { type: "button", class: "ctl share", onClick: () => this._onShareClick() });
    this.shareMenu = el(
      "div",
      { class: "share-menu", hidden: true },
      el("button", { type: "button", class: "share-item", onClick: () => this._share("screen") }, "Screen"),
      el("button", { type: "button", class: "share-item", onClick: () => this._share("audio") }, "Audio"),
    );
    this.shareWrap = el("div", { class: "share-wrap" }, this.shareBtn, this.shareMenu);
    // Noise suppression: opt-in (default OFF — it adds CPU/latency, so the user
    // enables it), and disabled while the large worklet loads on first enable.
    this.nsBtn = el("button", { type: "button", class: "ctl ns", title: "Microphone noise suppression", onClick: () => this._onNsToggle() });

    // Camera columns as an inline segmented group (reuses _pickCols/_markColsActive),
    // placed into the ☰ menu below.
    this.colsSeg = el(
      "div",
      { class: "seg cols-seg" },
      ...COLS_OPTIONS.map((opt) =>
        el("button", { type: "button", class: "share-item cols-item", "data-cols": String(opt.value ?? "auto"), onClick: () => this._pickCols(opt.value) }, opt.label),
      ),
    );

    this.hideSelfBtn = el("button", {
      type: "button", class: "ctl hide-self icon",
      "aria-label": "Hide yourself from your view",
      onClick: () => this._toggleSelfHidden(),
    });
    this._setSelfHiddenButton();

    // Deafen: mute ALL incoming audio locally. Its own compact toggle (not in a menu) so
    // its state is visible and one click away. Transient — every call starts un-deafened.
    this.deafenBtn = el("button", {
      type: "button", class: "ctl deafen icon",
      "aria-label": "Deafen (mute all incoming audio)",
      onClick: () => this._toggleDeafen(),
    });
    this._deafened = false;
    this._setDeafenButton();

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

    // Low-bandwidth (data saver): a per-user switch that asks the SFU to stop
    // forwarding ALL inbound video to us (audio only). Available to everyone and
    // affects only our own downlink; the grid collapses to audio-only on its own as
    // the server renegotiates our video away.
    this.lowBwBtn = el("button", { type: "button", class: "ctl lowbw", onClick: () => this._toggleLowBandwidth() });
    this._setLowBwButton();

    // ☰ settings menu: houses the low-frequency controls so the bar stays lean. Built
    // here, after nsBtn/hideSelfBtn/lowBwBtn/colsSeg all exist.
    this.settingsBtn = el(
      "button",
      { type: "button", class: "ctl settings icon", title: "Settings", "aria-label": "Settings", "aria-haspopup": "menu", "aria-expanded": "false", onClick: () => this._toggleSettingsMenu() },
      el("span", { class: "glyph", text: "☰" }),
    );
    // Rename: change your own display name. Enter submits; Esc reverts + closes.
    this.renameInput = el("input", {
      class: "rename-input device", type: "text", maxlength: "24",
      "aria-label": "Your display name",
      onKeydown: (e) => {
        if (e.key === "Enter") { e.preventDefault(); this._submitRename(); }
        else if (e.key === "Escape") { e.preventDefault(); this._closeMenus(); }
      },
    });
    // Background effects, compact variant so the popover stays a sane width. A
    // watchdog revert is never persisted — see the same rule on the denoise
    // toggle below: writing a state the user did not choose means reading it back
    // forever as though they had.
    this.backgroundPicker = new BackgroundPicker({
      media: this.media,
      compact: true,
      onChange: (effectId, reverted) => {
        if (!reverted) saveMediaPrefs({ background: effectId });
      },
    });
    this.settingsMenu = el(
      "div",
      { class: "share-menu settings-menu", hidden: true },
      this._settingsRow("Name", this.renameInput),
      this._settingsRow("Hide self", this.hideSelfBtn),
      this._settingsRow("Noise suppression", this.nsBtn),
      this._settingsRow("Background", this.backgroundPicker.el),
      this._settingsRow("Data saver", this.lowBwBtn),
      this._settingsRow("Columns", this.colsSeg),
    );
    this.settingsWrap = el("div", { class: "share-wrap" }, this.settingsBtn, this.settingsMenu);
    this._markColsActive();

    const leaveBtn = el("button", { type: "button", class: "ctl leave", onClick: () => this.onLeave() }, "Leave");

    // A mic/camera button is meaningless with no such track; disable it up front.
    // Noise suppression likewise needs a mic to process.
    if (!(this.media && this.media.micTrack)) this.muteBtn.disabled = true;
    // Enabled whenever a camera EXISTS (even if joined with it off, so it can be
    // turned back on), not only when a track is currently live.
    if (!(this.media && this.media.cameraAvailable)) this.cameraBtn.disabled = true;

    this._setMicButton(this.media && this.media.micTrack ? this.media.micTrack.enabled : false);
    this._setCameraButton(!!(this.media && this.media.cameraTrack));
    this._setShareButton(false);
    this._setNsButton(false, false); // default OFF
    this._setCountdownButton();

    // Lock indicator (everyone) + lock toggle (op only).
    this.lockStatus = el("span", { class: "lock-status", hidden: true, text: "Room locked" });
    const children = [this.micWrap, this.cameraWrap, this.deafenBtn, this.shareWrap, this.countdownBtn, this.chatBtn, this.settingsWrap, this.lockStatus, leaveBtn];
    this.el = el("div", { class: "controls" }, ...children);
    if (this.isOp) this._ensureOpSettingsRows(); // append Lock + Quality rows to the ☰ menu
  }

  // --- local controls ---

  _toggleMic() {
    if (!this.media) return;
    const enabled = this.media.toggleMic();
    this._setMicButton(enabled);
    if (this.grid) this.grid.refreshSelf();
    this.sendMediaState(); // tell the room so remote mute indicators update
    this.muteBtn.blur(); // drop focus so a following Space is push-to-talk, not a re-toggle
  }

  // --- push-to-talk (hold Space) ---

  _pttKeyDown(e) {
    if (e.code !== "Space" || e.repeat || this._pttHeld) return;
    if (isInteractive(e.target)) return; // typing, or Space is activating a focused control
    const t = this.media && this.media.micTrack;
    if (!t || t.enabled) return; // no mic, or already live — nothing to push
    e.preventDefault(); // don't scroll the page
    this._pttHeld = true;
    this._pttUnmuted = true;
    this._setMic(true);
  }
  _pttKeyUp(e) {
    if (e.code !== "Space" || !this._pttHeld) return;
    e.preventDefault();
    this._pttRelease();
  }
  // Re-mute if we unmuted for this hold. Also the safety valve for lost keyups (window
  // blur / teardown).
  _pttRelease() {
    if (!this._pttHeld && !this._pttUnmuted) return;
    this._pttHeld = false;
    if (this._pttUnmuted) {
      this._pttUnmuted = false;
      this._setMic(false);
    }
  }
  // Drive the mic to a specific state and mirror it to the button, self tile, and room.
  _setMic(enabled) {
    if (!this.media) return;
    const now = this.media.setMic(enabled);
    this._setMicButton(now);
    if (this.grid) this.grid.refreshSelf();
    this.sendMediaState();
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

  // Toggle this client's low-bandwidth (data-saver) mode: stop/resume downloading
  // ALL inbound video. Purely local and per-user — it changes only what WE receive —
  // so it just flips the button and hands the new state to app.js, which tells the
  // server and persists the choice.
  _toggleLowBandwidth() {
    this.lowBandwidth = !this.lowBandwidth;
    this._setLowBwButton();
    this.onLowBandwidth(this.lowBandwidth);
  }

  _setLowBwButton() {
    // Active = video downloads are OFF (audio only). Text mirrors the denoise button's
    // on/off wording; the title spells out the effect for both states.
    this.lowBwBtn.textContent = this.lowBandwidth ? "Data saver on" : "Data saver off";
    this.lowBwBtn.classList.toggle("active", this.lowBandwidth);
    const title = this.lowBandwidth
      ? "Low bandwidth on — receiving audio only. Click to receive video again."
      : "Low bandwidth: stop downloading video (receive audio only)";
    this.lowBwBtn.title = title;
    this.lowBwBtn.setAttribute("aria-label", title);
  }

  _onShareClick() {
    if (!this.media) return;
    if (this.sharing) {
      this.media.stopScreen(); // -> screen-stop -> unpublish + button
      return;
    }
    const open = this.shareMenu.hidden;
    this._closeMenus(); // only one popover open at a time
    if (open) this.shareMenu.hidden = false;
  }

  // A menu choice: a screen share (video + optional audio) or an audio-only share.
  // Rejection (cancelled picker, or no audio shared) is non-fatal — Media emits its
  // own error and no screen-start fires, so the button simply stays "Share".
  _share(kind) {
    this.shareMenu.hidden = true;
    if (!this.media) return;
    if (kind === "audio") this.media.startScreenAudioOnly().catch(() => {});
    else this.media.startScreen().catch(() => {});
  }

  // The caret button attached to a split control, and the little popover it opens.
  _deviceArrow(label, onClick) {
    return el(
      "button",
      { type: "button", class: "ctl ctl-arrow", title: label, "aria-label": label, "aria-haspopup": "menu", "aria-expanded": "false", onClick },
      el("span", { class: "caret", text: "▾" }),
    );
  }
  _deviceMenu(label, select) {
    return el("div", { class: "device-menu", hidden: true }, el("label", { class: "field" }, el("span", { text: label }), select));
  }
  // Like _deviceMenu but renders one OR two labelled fields; the second is omitted when
  // selectB is null (e.g. where output selection is unsupported). Used by the mic menu,
  // which carries both the Microphone and Speaker selects.
  _deviceMenu2(labelA, selectA, labelB, selectB) {
    const fields = [el("label", { class: "field" }, el("span", { text: labelA }), selectA)];
    if (selectB) fields.push(el("label", { class: "field" }, el("span", { text: labelB }), selectB));
    return el("div", { class: "device-menu", hidden: true }, ...fields);
  }

  // Close every popover (share, mic, camera) and reset the carets' expanded state.
  _closeMenus() {
    if (this.shareMenu) this.shareMenu.hidden = true;
    if (this.micMenu) this.micMenu.hidden = true;
    if (this.cameraMenu) this.cameraMenu.hidden = true;
    if (this.settingsMenu) this.settingsMenu.hidden = true;
    if (this.micArrow) this.micArrow.setAttribute("aria-expanded", "false");
    if (this.cameraArrow) this.cameraArrow.setAttribute("aria-expanded", "false");
    if (this.settingsBtn) this.settingsBtn.setAttribute("aria-expanded", "false");
  }

  // A labelled settings-menu row: a text label plus its control (a toggle button, a
  // segmented group, or the quality selects).
  _settingsRow(label, control) {
    return el("div", { class: "settings-item" }, el("span", { class: "si-label", text: label }), control);
  }

  _toggleSettingsMenu() {
    const open = this.settingsMenu.hidden;
    this._closeMenus();
    if (open) {
      this.settingsMenu.hidden = false;
      this.settingsBtn.setAttribute("aria-expanded", "true");
      if (this.renameInput) this.renameInput.value = (this.grid && this.grid.selfName) || "";
    }
  }

  // Send a rename if the trimmed input is non-empty and actually different from the
  // current self name; the server sanitizes authoritatively and the resulting
  // peer-renamed updates the tile, so no optimistic local edit is needed.
  _submitRename() {
    const name = this.renameInput.value.trim();
    const current = (this.grid && this.grid.selfName) || "";
    if (name && name !== current) this._send("rename", { name });
    this._closeMenus();
  }

  // Camera-grid column picker.
  _pickCols(value) {
    this._closeMenus();
    this._cols = value === 2 || value === 3 || value === 4 ? value : null;
    if (this.grid) this.grid.setColumns(this._cols);
    saveLayoutPrefs({ columns: this._cols });
    this._markColsActive();
  }
  _markColsActive() {
    if (!this.colsSeg) return;
    const key = this._cols == null ? "auto" : String(this._cols);
    for (const item of this.colsSeg.querySelectorAll(".cols-item")) {
      item.classList.toggle("active", item.getAttribute("data-cols") === key);
    }
  }

  _setSelfHiddenButton() {
    this.hideSelfBtn.replaceChildren(svgIcon(this._selfHidden ? EYE_OFF_PATHS : EYE_PATHS));
    this.hideSelfBtn.classList.toggle("active", this._selfHidden);
    const label = this._selfHidden ? "Show yourself" : "Hide yourself from your view";
    this.hideSelfBtn.title = label;
    this.hideSelfBtn.setAttribute("aria-label", label); // keep the AT label in step with the state, like title
  }

  _toggleSelfHidden() {
    this._selfHidden = !this._selfHidden;
    saveLayoutPrefs({ selfHidden: this._selfHidden });
    this._setSelfHiddenButton();
    if (this.grid) this.grid.setSelfHidden(this._selfHidden);
  }

  _setDeafenButton() {
    this.deafenBtn.replaceChildren(svgIcon(this._deafened ? SPEAKER_OFF_PATHS : SPEAKER_PATHS));
    this.deafenBtn.classList.toggle("active", this._deafened);
    const label = this._deafened ? "Undeafen (restore incoming audio)" : "Deafen (mute all incoming audio)";
    this.deafenBtn.title = label;
    this.deafenBtn.setAttribute("aria-label", label); // keep the AT label in step with state
  }

  _toggleDeafen() {
    this._deafened = !this._deafened;
    this._setDeafenButton();
    if (this.grid) this.grid.setDeafened(this._deafened);
  }

  // Toggle a device menu; populate it from a fresh enumerate each open so late-granted
  // labels and hot-plugged devices appear. Only one popover is open at a time.
  _toggleMicMenu() {
    const open = this.micMenu.hidden;
    this._closeMenus();
    if (open) {
      this.micMenu.hidden = false;
      this.micArrow.setAttribute("aria-expanded", "true");
      this._populateDevices("mic");
    }
  }
  _toggleCameraMenu() {
    const open = this.cameraMenu.hidden;
    this._closeMenus();
    if (open) {
      this.cameraMenu.hidden = false;
      this.cameraArrow.setAttribute("aria-expanded", "true");
      this._populateDevices("camera");
    }
  }

  async _populateDevices(kind) {
    if (!this.media) return;
    let devices;
    try {
      devices = await this.media.enumerate();
    } catch {
      return;
    }
    if (kind === "camera") {
      this._fillDeviceSelect(this.cameraSelect, devices.cameras, this.media.cameraTrack, "Camera");
    } else {
      this._fillDeviceSelect(this.micSelect, devices.mics, this.media.micTrack, "Microphone");
      if (this.speakerSelect) this._fillOutputSelect(devices.speakers || []);
    }
  }

  _fillDeviceSelect(select, list, activeTrack, label) {
    const activeId = activeTrack ? activeTrack.getSettings().deviceId : "";
    select.replaceChildren();
    if (list.length === 0) {
      select.append(el("option", { value: "", text: `No ${label.toLowerCase()} found` }));
      select.disabled = true;
      return;
    }
    select.disabled = false;
    list.forEach((d, i) => {
      const opt = el("option", { value: d.deviceId, text: d.label || `${label} ${i + 1}` });
      if (d.deviceId && d.deviceId === activeId) opt.selected = true;
      select.append(opt);
    });
  }

  // Like _fillDeviceSelect, but for audio OUTPUTS: there is no "active track" to read the
  // current sink from, so mark the persisted choice (this._speakerId) as selected.
  _fillOutputSelect(list) {
    const select = this.speakerSelect;
    select.replaceChildren();
    if (list.length === 0) {
      select.append(el("option", { value: "", text: "No speaker found" }));
      select.disabled = true;
      return;
    }
    select.disabled = false;
    list.forEach((d, i) => {
      const opt = el("option", { value: d.deviceId, text: d.label || `Speaker ${i + 1}` });
      if (d.deviceId && d.deviceId === this._speakerId) opt.selected = true;
      select.append(opt);
    });
  }

  // Route all remote audio to the chosen output device (persisted for next time).
  async _switchSpeakerDevice() {
    if (!this.grid || !this.speakerSelect) return;
    this._speakerId = this.speakerSelect.value;
    this.grid.setAudioOutput(this._speakerId);
    saveMediaPrefs({ speakerId: this._speakerId }); // remember this output for next time
    this._closeMenus(); // selection made — dismiss the popover
  }

  // Hot-swap the camera mid-call. useDevices acquires the chosen device (turning the
  // camera on if it was off) and fires "camera-track", which app.js forwards to the
  // peer via replaceTrack — remotes see the new camera without renegotiation.
  async _switchCameraDevice() {
    if (!this.media || !this.cameraSelect.value) return;
    try {
      await this.media.useDevices({ cameraId: this.cameraSelect.value });
      saveMediaPrefs({ cameraId: this.cameraSelect.value }); // remember this camera for next time
    } catch {
      /* media.js emits its own error event */
    }
    this._setCameraButton(!!this.media.cameraTrack);
    if (this.grid) this.grid.refreshSelf();
    this._closeMenus(); // selection made — dismiss the popover
  }

  // Hot-swap the mic mid-call. useDevices preserves the mute state, rebuilds the NS
  // graph if noise suppression is on, and fires "mic-track" for the peer to replace.
  async _switchMicDevice() {
    if (!this.media || !this.micSelect.value) return;
    try {
      await this.media.useDevices({ micId: this.micSelect.value });
      saveMediaPrefs({ micId: this.micSelect.value }); // remember this mic for next time
    } catch {
      /* media.js emits its own error event */
    }
    if (this.grid) this.grid.refreshSelf();
    this._closeMenus(); // selection made — dismiss the popover
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

  // The denoise BUTTON handler: toggle, then persist. Kept separate from
  // _toggleNoiseSuppression so the default-on path never writes a preference — only an
  // explicit user click does.
  //
  // Persist ONLY when the click achieved what the user asked for. A failed enable (the
  // ~2MB worklet didn't load) settles back on OFF, and writing that would record
  // `ns: false` — read back forever after as "the user turned denoise off", suppressing
  // the default-on for every later call long after the transient failure is gone.
  async _onNsToggle() {
    const target = !this.nsOn;
    await this._toggleNoiseSuppression();
    if (this.nsOn === target) saveMediaPrefs({ ns: this.nsOn });
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
    this._setShareButton(true);
  }

  _onScreenStopped() {
    if (this.peer) {
      this.peer.unpublish("screen"); // idempotent when no sender
      this.peer.unpublish("screen-audio");
    }
    this.sharing = false;
    this._setShareButton(false);
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

  // A native <dialog>: it gives the modal backdrop, focus trapping and Escape-to-cancel
  // for free, the same reasons lib/confirm.js uses one.
  _openPollForm() {
    this._closeMenus();
    if (!this.pollDialog) this._buildPollForm();
    this.pollQuestion.value = "";
    for (const input of this.pollOptions) input.value = "";
    this._setPollOptionCount(2);
    this.pollDialog.showModal();
    this.pollQuestion.focus();
  }

  _buildPollForm() {
    // MAX_POLL_OPTIONS matches the server's MaxPollOptions; a mismatch would let the
    // form build a poll the server silently refuses.
    const MAX_POLL_OPTIONS = 6;
    this.pollQuestion = el("input", { class: "poll-input", type: "text", maxlength: "200", placeholder: "Question", "aria-label": "Poll question" });
    this.pollOptions = Array.from({ length: MAX_POLL_OPTIONS }, (_, i) =>
      el("input", { class: "poll-input", type: "text", maxlength: "80", placeholder: `Option ${i + 1}`, "aria-label": `Option ${i + 1}` }),
    );
    this.pollAddBtn = el("button", { type: "button", class: "poll-add", onClick: () => this._setPollOptionCount(this._pollShown + 1) }, "Add option");

    const form = el(
      "form",
      { class: "poll-form", method: "dialog", onSubmit: (e) => { e.preventDefault(); this._submitPoll(); } },
      el("h2", { class: "poll-form-title", text: "New poll" }),
      this.pollQuestion,
      ...this.pollOptions,
      this.pollAddBtn,
      el(
        "div",
        { class: "poll-form-actions" },
        el("button", { type: "button", class: "poll-cancel", onClick: () => this.pollDialog.close() }, "Cancel"),
        el("button", { type: "submit", class: "poll-create" }, "Create"),
      ),
    );
    this.pollDialog = el("dialog", { class: "poll-dialog", "aria-label": "Create a poll" }, form);
    document.body.append(this.pollDialog);
    this._setPollOptionCount(2);
  }

  // Show exactly n option inputs (clamped 2..6) and hide the rest.
  _setPollOptionCount(n) {
    this._pollShown = Math.max(2, Math.min(this.pollOptions.length, n));
    this.pollOptions.forEach((input, i) => {
      input.hidden = i >= this._pollShown;
      if (input.hidden) input.value = "";
    });
    this.pollAddBtn.hidden = this._pollShown >= this.pollOptions.length;
  }

  _submitPoll() {
    const question = this.pollQuestion.value.trim();
    const options = this.pollOptions
      .slice(0, this._pollShown)
      .map((input) => input.value.trim())
      .filter(Boolean);
    // Same limits the server enforces, so an obviously invalid poll never leaves the
    // page — the server refusal would otherwise be silent to the user.
    if (!question || options.length < 2) {
      this.pollQuestion.focus();
      return;
    }
    this._send("create-poll", { question, options });
    this.pollDialog.close();
  }

  _removeAudioUnlock() {
    for (const ev of this._audioUnlockEvents) {
      window.removeEventListener(ev, this._onAudioUnlock);
    }
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
    // Best-effort: this runs from the `countdown` broadcast handler for EVERYONE —
    // including the starter, whose click only _send()s — so it is never a user
    // gesture. iOS therefore blocks it unless the element was unlocked on the first
    // in-call gesture (see the audio-unlock in the constructor); desktop permits it
    // once the page has been interacted with. Swallow the rejection either way.
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
    const name = participant.name || "this participant";
    // No "+op" for someone who is already an op — it would be a no-op grant. The
    // button carries the "makeop" class so grid.js can show/hide it if the target's
    // role changes (a promotion) without rebuilding the whole action group.
    const makeop =
      participant.role === "op"
        ? null
        : el("button", { type: "button", class: "op makeop", title: "Make op", onClick: () => this._send("grant-op", { id }) }, "+op");
    return el(
      "div",
      { class: "op-actions" },
      makeop,
      el("button", {
        type: "button", class: "op kick", title: "Kick",
        onClick: async (e) => {
          const btn = e.currentTarget; // captured before the await; disabled so a double-click can't stack two dialogs / double-send
          btn.disabled = true;
          try {
            if (await confirmDialog({ title: `Kick ${name}?`, message: "They'll be removed from the call.", confirmLabel: "Kick", tone: "danger" })) {
              this._send("kick", { id });
            }
          } finally {
            btn.disabled = false;
          }
        },
      }, "kick"),
      el("button", { type: "button", class: "op mute", title: "Mute mic", onClick: () => this._send("mute-peer", { id, kind: "mic" }) }, "mute"),
      el("button", {
        type: "button", class: "op ban", title: "Ban",
        onClick: async (e) => {
          const btn = e.currentTarget; // captured before the await; disabled so a double-click can't stack two dialogs / double-send
          btn.disabled = true;
          try {
            if (await confirmDialog({ title: `Ban ${name}?`, message: "They'll be removed and blocked from rejoining.", confirmLabel: "Ban", tone: "danger" })) {
              this._send("ban", { id });
            }
          } finally {
            btn.disabled = false;
          }
        },
      }, "ban"),
    );
  }

  // The local participant was just promoted to op mid-call: gain the op controls
  // (the room lock button) and add op actions to every existing remote tile. New
  // tiles get them automatically — opActionsFor now returns markup since isOp is true.
  // Idempotent: a repeat call after already being op does nothing.
  becomeOp() {
    if (this.isOp) return;
    this.isOp = true;
    this._ensureOpSettingsRows();
    if (this.grid) this.grid.addOpControls();
    if (this.chat) this.chat.setOp(true);
  }

  // Add the op-only Lock + Quality rows to the ☰ menu, once. Called from _build (if the
  // join role is op) and from becomeOp (mid-call promotion).
  _ensureOpSettingsRows() {
    if (!this.lockBtn) {
      this.lockBtn = el("button", { type: "button", class: "ctl lock", onClick: () => this._toggleLock() });
      this._setLockButton(!!this.locked);
      this.settingsMenu.append(this._settingsRow("Lock room", this.lockBtn));
    }
    if (!this.qualityRow) {
      this.qualityRow = this._settingsRow("Quality", this._buildQualityControl());
      this.settingsMenu.append(this.qualityRow);
    }
    if (!this.pollBtn) {
      this.pollBtn = el("button", { type: "button", class: "ctl poll", text: "New poll…", onClick: () => this._openPollForm() });
      this.settingsMenu.append(this._settingsRow("Poll", this.pollBtn));
    }
  }

  // Op-only session video-quality control: independent Camera and Screen tier
  // dropdowns, inlined into a ☰ menu row. Changing one sends set-quality; the server
  // relays it to everyone (setQualityState reflects the authoritative value back).
  _buildQualityControl() {
    this.qCameraSelect = el("select", { class: "device", "aria-label": "Camera quality", onChange: () => this._send("set-quality", { target: "camera", tier: this.qCameraSelect.value }) });
    this.qScreenSelect = el("select", { class: "device", "aria-label": "Screenshare quality", onChange: () => this._send("set-quality", { target: "screen", tier: this.qScreenSelect.value }) });
    for (const sel of [this.qCameraSelect, this.qScreenSelect]) {
      for (const t of QUALITY_TIERS) sel.append(el("option", { value: t.id, text: t.label }));
    }
    this.setQualityState(this._qCam, this._qScr); // reflect whatever we already know
    return el(
      "div",
      { class: "quality-inline" },
      el("label", { class: "field" }, el("span", { text: "Cam" }), this.qCameraSelect),
      el("label", { class: "field" }, el("span", { text: "Screen" }), this.qScreenSelect),
    );
  }

  // Reflect the authoritative session caps in the op dropdowns. Called for everyone (a
  // no-op for non-ops, who have no menu) so the op UI always shows the live values.
  setQualityState(camera, screen) {
    this._qCam = camera || "auto";
    this._qScr = screen || "auto";
    if (this.qCameraSelect) this.qCameraSelect.value = this._qCam;
    if (this.qScreenSelect) this.qScreenSelect.value = this._qScr;
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
    // Live -> microphone; muted -> slashed microphone. The visible text is gone, so the
    // title/aria-label carry the (action-phrased) accessible name.
    this.muteBtn.replaceChildren(svgIcon(enabled ? MIC_PATHS : MIC_OFF_PATHS));
    this.muteBtn.classList.toggle("active", !enabled);
    // The caret shares the button's active tint so the split control reads as one unit.
    if (this.micArrow) this.micArrow.classList.toggle("active", !enabled);
    const label = enabled ? "Mute microphone" : "Unmute microphone";
    // Advertise push-to-talk on the muted-state tooltip so it's discoverable.
    this.muteBtn.title = enabled ? label : `${label} (or hold Space to talk)`;
    this.muteBtn.setAttribute("aria-label", label);
  }

  _setCameraButton(enabled) {
    // Live -> camera; off -> slashed camera. Accessible name moves to title/aria-label
    // now that the visible text is gone (matches the mic button).
    this.cameraBtn.replaceChildren(svgIcon(enabled ? CAM_PATHS : CAM_OFF_PATHS));
    this.cameraBtn.classList.toggle("active", !enabled);
    if (this.cameraArrow) this.cameraArrow.classList.toggle("active", !enabled);
    const label = enabled ? "Stop video" : "Start video";
    this.cameraBtn.title = label;
    this.cameraBtn.setAttribute("aria-label", label);
  }

  _setShareButton(sharing) {
    this.shareBtn.textContent = sharing ? "Stop share" : "Share";
    this.shareBtn.classList.toggle("active", sharing);
    if (sharing) this.shareMenu.hidden = true; // no menu while a share is active
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
    if (this.backgroundPicker) this.backgroundPicker.destroy();
    if (this.media) {
      this.media.removeEventListener("screen-start", this._onScreenStart);
      this.media.removeEventListener("screen-stop", this._onScreenStop);
    }
    for (const ev of this._activityEvents) {
      window.removeEventListener(ev, this._onActivity);
    }
    this._removeAudioUnlock();
    document.body.classList.remove("ui-idle");
    window.removeEventListener("keydown", this._onKeyDown);
    window.removeEventListener("keyup", this._onKeyUp);
    window.removeEventListener("blur", this._onWinBlur);
    document.removeEventListener("pointerdown", this._onDocPointer);
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
    if (this.pollDialog) {
      if (this.pollDialog.open) this.pollDialog.close();
      this.pollDialog.remove();
      this.pollDialog = null;
    }
  }
}
