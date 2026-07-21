// The pre-join lobby. Before a socket is ever opened this screen shows a live
// local camera/mic preview, lets the user pick input devices, reports the room's
// current occupancy (polled from GET /api/rooms/<slug>), collects a display name
// (read-only when an invite token already carries the nick), and — only for a
// locked room — a password. Clicking Join hands {name, password} back to app.js;
// the socket, the join handshake, and the error/success routing all live there.
//
// This module owns no Signaling/Peer state: app.js constructs Media and passes
// it in so the very stream previewed here is the one published once in-call.

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

export class Prejoin {
  // { root, slug, token, media, onJoin }. onJoin({name, password}) is called once
  // per Join click; app.js drives the socket and calls back showError/destroy.
  constructor({ root, slug, token, media, onJoin }) {
    this.root = root;
    this.slug = slug;
    this.token = token || "";
    this.media = media;
    this.onJoin = onJoin;
    this.nick = nickFromToken(this.token); // "" when no token / no nick claim
    this.locked = false;
    this.destroyed = false;
    this.pollTimer = null;
  }

  // Build the DOM, start the preview + device lists, and begin polling occupancy.
  async mount() {
    this._build();
    await this._startPreview();
    await this._populateDevices();
    this._poll(); // fires immediately, then reschedules itself
  }

  _build() {
    this.video = el("video", { class: "preview", autoplay: true, muted: true, playsinline: true });
    this.video.muted = true; // attribute + property: some browsers honour only the property

    this.cameraSelect = el("select", { class: "device", onChange: () => this._switchCamera() });
    this.micSelect = el("select", { class: "device", onChange: () => this._switchMic() });

    this.nameInput = el("input", {
      class: "name",
      type: "text",
      placeholder: "Display name",
      maxlength: "32",
      autocomplete: "off",
    });
    if (this.nick) {
      this.nameInput.value = this.nick;
      this.nameInput.readOnly = true;
      this.nameInput.title = "Name provided by your invite link";
    }

    this.passwordInput = el("input", { class: "password", type: "password", placeholder: "Room password", autocomplete: "off" });
    this.passwordField = el("label", { class: "field" }, el("span", { text: "Password" }), this.passwordInput);
    this.passwordField.hidden = true; // revealed only when the room is locked

    this.countLabel = el("span", { class: "count", text: "…" });
    this.errorLabel = el("p", { class: "error", role: "alert" });

    this.joinButton = el("button", { class: "join", type: "button", onClick: () => this._submit() }, "Join");

    const form = el(
      "div",
      { class: "prejoin" },
      el("h1", { text: `Join #${this.slug}` }),
      el("div", { class: "count-row" }, this.countLabel),
      this.video,
      el("div", { class: "devices" },
        el("label", { class: "field" }, el("span", { text: "Camera" }), this.cameraSelect),
        el("label", { class: "field" }, el("span", { text: "Microphone" }), this.micSelect),
      ),
      el("label", { class: "field" }, el("span", { text: "Display name" }), this.nameInput),
      this.passwordField,
      this.errorLabel,
      this.joinButton,
    );

    this.root.replaceChildren(form);
  }

  async _startPreview() {
    try {
      await this.media.start();
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
    try {
      await this.media.useDevices({ cameraId: this.cameraSelect.value });
    } catch {
      /* keep the previous device; media.js emits its own error event */
    }
  }

  async _switchMic() {
    try {
      await this.media.useDevices({ micId: this.micSelect.value });
    } catch {
      /* keep the previous device */
    }
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
    this.countLabel.textContent = `${n} in call`;
    this.locked = !!locked;
    this.passwordField.hidden = !this.locked;
  }

  _submit() {
    const name = this.nick || this.nameInput.value.trim();
    const password = this.locked ? this.passwordInput.value : "";
    this.errorLabel.textContent = "";
    this.joinButton.disabled = true;
    this.joinButton.textContent = "Joining…";
    this.onJoin({ name, password });
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
    if (this.video) this.video.srcObject = null;
    this.root.replaceChildren();
  }
}
