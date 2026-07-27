// The pre-join lobby. Before a socket is ever opened this screen shows a live
// local camera/mic preview, lets the user pick input devices, reports the room's
// current occupancy (polled from GET /api/rooms/<slug>), collects a display name
// (read-only when an invite token already carries the nick), and — only for a
// locked room — a password. Clicking Join hands {name, password, gravatar} back
// to app.js; the socket, the join handshake, and the error/success routing all
// live there.
//
// This module owns no Signaling/Peer state: app.js constructs Media and passes
// it in so the very stream previewed here is the one published once in-call.

import { loadMediaPrefs, saveMediaPrefs, loadName, saveName } from "../lib/prefs.js";
import { applyAvatar, gravatarHash } from "../lib/avatar.js";

const POLL_INTERVAL_MS = 3000;

// Human-readable copy for each server reject code (signal.Error.Code). Anything
// unmapped falls back to the server's own message.
const ERROR_TEXT = {
  "bad-password": "Wrong password for this room.",
  banned: "You are banned from this room.",
  "identified-only": "This room is for registered nicks only — join with an invite from !vc.",
  "not-provisioned": "This room isn't active. Run !vc in its channel to open it.",
  "token-invalid": "Your invite link is invalid.",
  "token-expired": "Your invite link has expired — run !vc again for a fresh one.",
  protocol: "The server rejected the join request.",
  media: "The server could not set up media for this room.",
};

// nickFromToken reads the display name out of a token WITHOUT verifying it: the
// token is base64url(JSON payload) + "." + base64url(sig), and the payload's "n"
// field is the nick. This is prefill/lock convenience only — the server
// re-verifies the token's signature and claims on join, so a forged payload here
// buys nothing. Returns "" for an absent/garbled token.
export function nickFromToken(token) {
  if (!token) return "";
  const seg = String(token).split(".")[0];
  if (!seg) return "";
  try {
    const b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
    const bin = atob(b64 + pad);
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    const claims = JSON.parse(new TextDecoder().decode(bytes));
    return typeof claims.n === "string" ? claims.n : "";
  } catch {
    return "";
  }
}

// Tiny DOM helper: el("div", {class:"x", onClick:fn}, child, "text"...).
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

const EMAIL_KEY = "swiftirc-vc-email";

// loadSavedEmail / saveEmail persist the Gravatar email across visits. Only ever
// read locally to compute the hash; the raw email is never sent to the server.
function loadSavedEmail() {
  try {
    return localStorage.getItem(EMAIL_KEY) || "";
  } catch {
    return "";
  }
}
function saveEmail(email) {
  try {
    if (email) localStorage.setItem(EMAIL_KEY, email);
    else localStorage.removeItem(EMAIL_KEY);
  } catch {
    /* storage unavailable — ignore */
  }
}

export class Prejoin {
  // { root, slug, token, media, onJoin }. onJoin({name, password, gravatar}) is
  // called once per Join click; app.js drives the socket and calls back showError/destroy.
  constructor({ root, slug, token, invite, media, onJoin }) {
    this.root = root;
    this.slug = slug;
    this.token = token || "";
    this.invite = invite || "";
    this.media = media;
    this.onJoin = onJoin;
    this.nick = nickFromToken(this.token); // "" when no token / no nick claim (filled from the invite in mount)
    this.locked = false;
    this.destroyed = false;
    this.pollTimer = null;
    this.gravatar = ""; // live Gravatar hash of the typed email; kept in sync by _onEmailInput
  }

  // Fetch the display name a short invite (#i=) grants, so the name field can be
  // pre-filled + locked exactly like a token link. Best-effort: on failure (or no
  // invite) the field stays a normal editable input.
  async _resolveInviteName() {
    try {
      const r = await fetch("/api/invite/" + encodeURIComponent(this.invite), { cache: "no-store" });
      if (!r.ok) return;
      const d = await r.json();
      if (d && d.name) this.nick = d.name;
    } catch {
      /* leave the name field editable */
    }
  }

  // Build the DOM, start the preview + device lists, and begin polling occupancy.
  async mount() {
    if (this.invite && !this.nick) await this._resolveInviteName(); // fill the name before _build locks the field
    this._build();
    await this._startPreview();
    await this._populateDevices();
    await this._applyMediaPrefs(); // restore the mic/camera choice from last time
    this._syncMediaState(); // now that tracks exist, reflect their presence + enabled state
    this._poll(); // fires immediately, then reschedules itself
  }

  // Apply the persisted mic/camera on-off preference to the freshly-started preview,
  // so someone who last joined muted / camera-off lands back in that state. start()
  // brings both up ON, so we only need to turn things OFF here; _syncMediaState (the
  // caller) then reflects it on the toggles + overlay.
  async _applyMediaPrefs() {
    const prefs = loadMediaPrefs();
    // Default OFF on a first-ever join (no saved preference); a returning user's saved
    // choice (mic:true / camera:true) re-enables. start() brings both up ON, so we only
    // ever turn things OFF here.
    if (prefs.mic !== true && this.media.micTrack && this.media.micTrack.enabled) {
      this.media.toggleMic(); // mute (device stays open)
    }
    if (prefs.camera !== true && this.media.cameraTrack) {
      this.media.disableCamera(); // release the camera
    }
  }

  _build() {
    // `mirror` gives the local preview a selfie (horizontally flipped) view.
    this.video = el("video", { class: "preview mirror", autoplay: true, muted: true, playsinline: true });
    this.video.muted = true; // attribute + property: some browsers honour only the property

    // Camera-off placeholder: a disabled video track just freezes or blacks the last
    // frame, so make the off-state explicit. Shows the participant's initial in an
    // IRC-palette circle (see lib/avatar.js), or a neutral "?" until a name is typed.
    // Sits inside .preview-wrap; shown/hidden by _setCameraToggle and repainted live
    // as the name field changes.
    this.cameraOffAvatar = el("span", { class: "cam-off-avatar", "aria-hidden": "true" });
    this.cameraOffOverlay = el("div", { class: "cam-off", hidden: true }, this.cameraOffAvatar);

    // Pre-join mic/camera toggles: let a participant join already muted and/or with
    // the camera off. Each flips the SHARED Media instance's track.enabled, which
    // carries unchanged into the call (app.js reuses this very Media — it is never
    // recreated on join, and nothing re-enables the tracks at call start). A missing
    // track disables its button, mirroring the in-call control bar.
    this.micGlyph = el("span", { class: "glyph" });
    this.micLabel = el("span", { class: "label" });
    this.micToggle = el(
      "button",
      { type: "button", class: "toggle mic", onClick: () => this._toggleMic() },
      this.micGlyph,
      this.micLabel,
    );
    this.cameraGlyph = el("span", { class: "glyph" });
    this.cameraLabel = el("span", { class: "label" });
    this.cameraToggle = el(
      "button",
      { type: "button", class: "toggle cam", onClick: () => this._toggleCamera() },
      this.cameraGlyph,
      this.cameraLabel,
    );

    this.cameraSelect = el("select", { class: "device", onChange: () => this._switchCamera() });
    this.micSelect = el("select", { class: "device", onChange: () => this._switchMic() });

    this.nameInput = el("input", {
      class: "name",
      type: "text",
      placeholder: "Display name",
      maxlength: "32",
      autocomplete: "off",
      onInput: () => applyAvatar(this.cameraOffAvatar, this._avatarName(), this.gravatar),
    });
    if (this.nick) {
      this.nameInput.value = this.nick;
      this.nameInput.readOnly = true;
      this.nameInput.title = "Name provided by your invite link";
    } else {
      // Prefill the display name from last time (saved on join). An invite-link
      // nick always wins over this.
      this.nameInput.value = loadName();
    }

    this.emailInput = el("input", {
      class: "email",
      type: "email",
      placeholder: "Email for Gravatar (optional)",
      autocomplete: "email",
      maxlength: "254",
      onInput: () => this._onEmailInput(),
    });
    this.emailInput.value = loadSavedEmail();

    this.passwordInput = el("input", { class: "password", type: "password", placeholder: "Room password (if locked)", autocomplete: "off" });
    // Always shown: it's optional (an unlocked room ignores it server-side), and
    // the /api/rooms poll can't always tell us a room is locked before we try
    // (e.g. a not-yet-active channel room), so let the user enter one preemptively.
    this.passwordField = el("label", { class: "field" }, el("span", { text: "Password" }), this.passwordInput);

    this.countLabel = el("span", { class: "count", text: "…" });
    this.errorLabel = el("p", { class: "error", role: "alert" });

    this.joinButton = el("button", { class: "join", type: "button", onClick: () => this._submit() }, "Join");

    const form = el(
      "div",
      { class: "prejoin" },
      el("h1", { text: `Join #${this.slug}` }),
      el("div", { class: "count-row" }, this.countLabel),
      el("div", { class: "preview-wrap" }, this.video, this.cameraOffOverlay),
      el("div", { class: "media-toggles" }, this.micToggle, this.cameraToggle),
      el("div", { class: "devices" },
        el("label", { class: "field" }, el("span", { text: "Camera" }), this.cameraSelect),
        el("label", { class: "field" }, el("span", { text: "Microphone" }), this.micSelect),
      ),
      el("label", { class: "field" }, el("span", { text: "Display name" }), this.nameInput),
      el("label", { class: "field" }, el("span", { text: "Gravatar email" }), this.emailInput),
      this.passwordField,
      this.errorLabel,
      this.joinButton,
    );

    this.root.replaceChildren(form);
    this._syncMediaState(); // initial (pre-permission) state: no tracks yet -> disabled
    this._applyEmailGravatar(); // compute the hash for any prefilled email (fire-and-forget)
  }

  async _startPreview() {
    try {
      // Open the last-selected mic/camera from a previous visit (ideal constraints,
      // so a missing device falls back to the default rather than failing).
      const prefs = loadMediaPrefs();
      await this.media.start({ cameraId: prefs.cameraId, micId: prefs.micId });
      if (this.destroyed) return;
      this.video.srcObject = this.media.stream;
    } catch {
      // Permission denied / no device: keep the lobby usable. The user can still
      // join (audio-only or view-only); a note explains the missing preview.
      if (!this.destroyed) this.errorLabel.textContent = "Camera/microphone unavailable — you can still join.";
    }
  }

  async _populateDevices() {
    let devices;
    try {
      devices = await this.media.enumerate();
    } catch {
      return;
    }
    if (this.destroyed) return;
    this._fillSelect(this.cameraSelect, devices.cameras, this.media.cameraTrack, "Camera");
    this._fillSelect(this.micSelect, devices.mics, this.media.micTrack, "Microphone");
  }

  _fillSelect(select, list, activeTrack, label) {
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

  async _switchCamera() {
    if (!this.cameraSelect.value) return; // no real device id (no permission) — nothing to switch to
    // useDevices acquires the chosen camera even when the camera is currently OFF, so
    // picking a device from the list turns it on with that camera. This is how you
    // recover when the default camera can't be opened (busy/in use): select a working
    // one. Selecting a device is a deliberate "use this camera" action.
    try {
      await this.media.useDevices({ cameraId: this.cameraSelect.value });
      saveMediaPrefs({ cameraId: this.cameraSelect.value }); // remember this camera for next time
      this._syncMediaState(); // reflect the switch on the button + overlay
    } catch {
      this._syncMediaState(); // media.js emits its own error; reflect whatever state we ended in
    }
  }

  async _switchMic() {
    if (!this.micSelect.value) return; // no real device id (no permission) — nothing to switch to
    try {
      await this.media.useDevices({ micId: this.micSelect.value });
      saveMediaPrefs({ micId: this.micSelect.value }); // remember this mic for next time
      this._syncMediaState(); // the new mic inherits the old mute state; reflect it
    } catch {
      /* keep the previous device */
    }
  }

  // --- pre-join mic/camera toggles ---

  // Reflect the live camera+mic tracks on the two toggle buttons (and the camera-off
  // placeholder). The mic button follows track presence; the camera button follows
  // cameraAvailable (a camera EXISTS) rather than a live track, since turning the
  // camera off releases its track but must stay re-enable-able. Called once tracks
  // exist and again after any device switch or camera on/off.
  _syncMediaState() {
    const cam = this.media.cameraTrack;
    const mic = this.media.micTrack;
    this._setCameraToggle(!!cam, this.media.cameraAvailable);
    this._setMicToggle(mic ? mic.enabled : false, !!mic);
  }

  _toggleMic() {
    if (!this.media.micTrack) return; // button is disabled without a track; guard anyway
    const on = this.media.toggleMic();
    this._setMicToggle(on, true);
    saveMediaPrefs({ mic: on });
  }

  async _toggleCamera() {
    if (!this.media.cameraAvailable) return; // no camera on this machine
    // Camera OFF releases the device (light off); ON re-acquires it, honoring the
    // selected device. Guard the button across the async re-acquire.
    this.cameraToggle.disabled = true;
    try {
      if (this.media.cameraTrack) this.media.disableCamera();
      else await this.media.enableCamera(this.cameraSelect.value || undefined);
    } catch {
      /* re-acquire failed: stay off (media.js emits its own error) */
    }
    this._syncMediaState();
    saveMediaPrefs({ camera: !!this.media.cameraTrack });
  }

  _setMicToggle(enabled, present) {
    const off = present && !enabled;
    this.micToggle.disabled = !present;
    this.micToggle.classList.toggle("off", off);
    this.micToggle.setAttribute("aria-pressed", off ? "true" : "false");
    this.micGlyph.textContent = off ? "🔇" : "🎤";
    this.micLabel.textContent = off ? "Mic off" : "Mic on";
  }

  // The name the avatar should reflect: a locked/invite nick wins over the typed
  // field, matching how join() resolves the name.
  _avatarName() {
    return this.nick || this.nameInput.value.trim();
  }

  _setCameraToggle(on, available) {
    const off = available && !on;
    this.cameraToggle.disabled = !available;
    this.cameraToggle.classList.toggle("off", off);
    this.cameraToggle.setAttribute("aria-pressed", off ? "true" : "false");
    this.cameraGlyph.textContent = off ? "🚫" : "🎥";
    this.cameraLabel.textContent = off ? "Camera off" : "Camera on";
    // Placeholder over the (now black/frozen) preview whenever a camera is available
    // but currently off.
    if (off) applyAvatar(this.cameraOffAvatar, this._avatarName(), this.gravatar);
    this.cameraOffOverlay.hidden = !off;
  }

  // Recompute the Gravatar hash as the email changes and repaint the self-preview.
  // Debounced so each keystroke doesn't fire a (mostly-404) Gravatar request — and a
  // partial-email hash — to gravatar.com.
  _onEmailInput() {
    clearTimeout(this._emailTimer);
    this._emailTimer = setTimeout(() => this._applyEmailGravatar(), 250);
  }

  // Hash the current email and repaint the self-preview. Guarded against out-of-order
  // async results (latest value wins) and against a repaint after unmount.
  async _applyEmailGravatar() {
    const email = this.emailInput.value;
    const hash = await gravatarHash(email);
    if (this.destroyed || this.emailInput.value !== email) return;
    this.gravatar = hash;
    applyAvatar(this.cameraOffAvatar, this._avatarName(), this.gravatar);
  }

  async _poll() {
    if (this.destroyed) return;
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(this.slug)}`, { headers: { Accept: "application/json" } });
      if (res.ok) {
        const data = await res.json();
        if (!this.destroyed) this._renderCount(data);
      }
    } catch {
      /* transient: try again on the next tick */
    }
    if (!this.destroyed) this.pollTimer = setTimeout(() => this._poll(), POLL_INTERVAL_MS);
  }

  _renderCount({ count, locked }) {
    const n = Number.isFinite(count) ? count : 0;
    this.countLabel.textContent = locked ? `${n} in call · locked` : `${n} in call`;
    this.locked = !!locked;
  }

  async _submit() {
    const name = this._avatarName();
    if (!this.nick) saveName(name); // remember the typed name for next visit
    const email = this.emailInput.value;
    saveEmail(email);
    const password = this.passwordInput.value; // sent always; unlocked rooms ignore it server-side
    this.errorLabel.textContent = "";
    this.joinButton.disabled = true;
    this.joinButton.textContent = "Joining…";
    const gravatar = await gravatarHash(email);
    this.onJoin({ name, password, gravatar });
  }

  // Called by app.js when the server rejects the join: surface the reason and
  // re-arm the Join button so the user can correct and retry.
  showError(code, message) {
    this.errorLabel.textContent = ERROR_TEXT[code] || message || "Could not join the room.";
    this.joinButton.disabled = false;
    this.joinButton.textContent = "Join";
    if (this.locked) this.passwordInput.focus();
  }

  // Stop polling and detach the preview. Media itself is NOT stopped — app.js
  // reuses the same stream in-call; leaving the call is what releases it.
  destroy() {
    this.destroyed = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    clearTimeout(this._emailTimer);
    if (this.video) this.video.srcObject = null;
    this.root.replaceChildren();
  }
}
