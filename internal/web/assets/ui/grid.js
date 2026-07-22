// The in-call tile grid. One base tile per participant (self + each remote),
// plus a SEPARATE tile for any active screen-share. A base tile carries the
// participant's name, an op/+voice role badge, their camera video, and mic/av
// indicators. Screen-shares are their own tiles so a share never displaces the
// sharer's camera.
//
// Tiles are driven by two event sources, wired from app.js:
//   - Peer      "remote-track" {participantId, kind, stream} / "peer-gone"
//               {participantId, kind}  — remote media coming and going. kind is
//               "mic" | "camera" | "screen".
//   - Signaling "peer-joined" {id,name,role,mic,camera} / "peer-left" {id} —
//               roster changes, which name/role a tile shows and when a
//               participant's tiles go away.
//   - Media     mic-track / camera-track / screen-start / screen-stop — the SELF
//               tile's own media (its preview and its screen-share tile).
//
// Remote mic/camera INDICATOR pills are driven by setPeerMedia (fed from the
// roster and the authoritative peer-media-state broadcast), NOT by track
// presence: a self-muted track is still published (silence / black frames), so a
// toggle fires no track-end and track presence cannot tell muted from live.
//
// Active-speaker highlight: a single AudioContext feeds one AnalyserNode per
// REMOTE mic stream; a light polling loop reads each analyser's level and marks
// the loudest tile ".active". Every source/analyser is torn down when its tile
// (or the whole grid) goes away — no leaked audio nodes.
//
// Injection-safety: every participant-controlled string (name, role) is written
// via textContent (the el() "text" key), never innerHTML.

import { playSound } from "../lib/sounds.js";

// Tiny DOM helper: el("div", {class:"x", onClick:fn}, child, "text"...). The
// "text" key sets textContent, so caller-supplied strings can never inject markup.
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

// How often (ms) to re-read audio levels for the active-speaker highlight. Fast
// enough to feel live, slow enough to cost nothing.
const LEVEL_INTERVAL_MS = 150;
// RMS level (0..1) a stream must exceed to be considered "speaking"; also the
// floor a tile must beat to steal the highlight, so background hiss stays quiet.
const ACTIVE_THRESHOLD = 0.03;

// Desired tile aspect ratio (width / height). The grid picks the column count that
// keeps tiles closest to this — so 4 participants become a 2x2 block of ~16:9
// tiles rather than a 1x4 row of slivers.
const TILE_ASPECT = 16 / 9;

export class Grid {
  // { selfId, selfName, selfRole, media, opActionsFor, screenOpActionsFor }.
  // opActionsFor(participant) returns a base-tile op-controls node (kick/mute/ban)
  // or null for non-ops; screenOpActionsFor(participant) returns a screen-tile
  // op-controls node ("stop screenshare") or null. Both are owned by controls.js
  // and only placed here.
  constructor({ selfId, selfName, selfRole, media, opActionsFor, screenOpActionsFor } = {}) {
    this.selfId = selfId;
    this.selfName = selfName || "You";
    this.media = media || null;
    this.opActionsFor = typeof opActionsFor === "function" ? opActionsFor : () => null;
    this.screenOpActionsFor = typeof screenOpActionsFor === "function" ? screenOpActionsFor : () => null;

    this.el = el("div", { class: "grid" });
    this._focusedEl = null; // the tile element shown large in focus mode, or null for the normal grid
    // A handle — visible only in focus mode — that hides/shows the right-hand strip
    // of the other cameras. Absolute-positioned, so it is never a grid cell.
    this._stripGlyph = el("span", { class: "glyph", text: "›" });
    this._stripToggle = el(
      "button",
      { class: "strip-toggle", type: "button", title: "Hide/show camera strip", "aria-label": "Toggle camera strip", onClick: () => this._toggleStrip() },
      this._stripGlyph,
    );
    this.el.append(this._stripToggle);
    // Shown centered while focused with no one else in the call (no strip to toggle):
    // a clear way to leave the maximized view.
    this._minimizeBtn = el(
      "button",
      { class: "focus-minimize", type: "button", title: "Minimize", "aria-label": "Minimize", onClick: () => this._clearFocus() },
      el("span", { class: "glyph", text: "⤡" }),
    );
    this.el.append(this._minimizeBtn);

    this.tiles = new Map(); // participantId -> base-tile record
    this.screens = new Map(); // participantId -> screen-tile element
    this.audio = new Map(); // participantId -> { audioEl, source, analyser, data }
    // Authoritative mic/camera state for a peer whose tile does not exist yet
    // (a peer-media-state that races ahead of the roster / track). Applied when
    // the tile is built, then cleared. participantId -> { mic, camera }.
    this.pendingMedia = new Map();

    this.activeId = null; // participantId of the currently highlighted tile
    this._audioCtx = null; // shared AudioContext (lazy: created with the first remote mic)
    this._levelTimer = null; // active-speaker polling handle (null when idle)

    // Bound Media listeners for the self tile; kept so destroy() can detach them.
    this._onMicTrack = () => {
      this._attachSelfAnalyser(); // re-point the self active-speaker meter at the new mic track
      this.refreshSelf();
    };
    this._onCameraTrack = () => {
      if (this._selfTile && this.media) this._selfTile.cameraVideo.srcObject = this.media.stream;
      this.refreshSelf();
    };
    this._onScreenStart = () => this._addScreenTile(this.selfId, this.selfName, this.media && this.media.screenStream);
    this._onScreenStop = () => this._removeScreenTile(this.selfId);
    if (this.media) {
      this.media.addEventListener("mic-track", this._onMicTrack);
      this.media.addEventListener("camera-track", this._onCameraTrack);
      this.media.addEventListener("screen-start", this._onScreenStart);
      this.media.addEventListener("screen-stop", this._onScreenStop);
    }

    // Re-pick the column/row split whenever the grid's box changes (window resize,
    // chat panel opening). The grid isn't in the DOM yet, so the first real layout
    // comes from the observer firing once it is mounted and has a size.
    this._resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => this._relayout()) : null;
    if (this._resizeObserver) this._resizeObserver.observe(this.el);

    this._addSelfTile(selfRole);
    this._attachSelfAnalyser(); // light the self tile's outline when the local user talks
  }

  // Choose the column count (and thus rows) that keeps tiles closest to TILE_ASPECT
  // for the current tile count and container size, and apply it as the grid template.
  // No-op in focus mode (the focused tile fills the grid via .has-focus). Cheap;
  // called on every tile add/remove and on resize.
  _relayout() {
    if (!this.el) return;
    const tiles = [...this.el.querySelectorAll(":scope > .tile")];
    for (const t of tiles) t.classList.remove("pos3-a", "pos3-b", "pos3-c"); // recomputed below
    if (this._focusedEl) {
      this._layoutFocus(tiles);
      return;
    }
    const n = tiles.length;
    if (!n) return;
    const w = this.el.clientWidth;
    const h = this.el.clientHeight;
    if (!w || !h) return; // not mounted/sized yet; the ResizeObserver will call again
    // 3-up special case: two tiles on top, the third centered on the bottom — all
    // the same (half) width. A 4-column grid lets the top two span cols 1-2 and 3-4
    // and the third span the middle cols 2-3 (centered) on row 2.
    if (n === 3) {
      this.el.style.gridTemplateColumns = "repeat(4, 1fr)";
      this.el.style.gridTemplateRows = "repeat(2, 1fr)";
      tiles[0].classList.add("pos3-a");
      tiles[1].classList.add("pos3-b");
      tiles[2].classList.add("pos3-c");
      return;
    }
    let bestCols = 1;
    let bestArea = -1;
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      let tw = w / cols;
      let th = h / rows;
      // Fit TILE_ASPECT inside the cell (letterbox), then score by resulting area.
      if (tw / th > TILE_ASPECT) tw = th * TILE_ASPECT;
      else th = tw / TILE_ASPECT;
      const area = tw * th;
      if (area > bestArea) {
        bestArea = area;
        bestCols = cols;
      }
    }
    const rows = Math.ceil(n / bestCols);
    this.el.style.gridTemplateColumns = `repeat(${bestCols}, 1fr)`;
    this.el.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
  }

  // Focus layout: the focused tile fills the main area (grid column 1, all rows) and
  // the other tiles stack in a right-hand strip (column 2). When the strip is hidden
  // (or the focused tile is the only one), the focused tile is full-width. The strip
  // width lives in the --strip-w CSS var so this and the .strip-toggle stay in sync.
  _layoutFocus(tiles) {
    const others = tiles.filter((t) => t !== this._focusedEl).length;
    // Alone (no one else): no strip — show the central minimize icon instead (CSS).
    this.el.classList.toggle("focus-alone", others === 0);
    if (!others || this.el.classList.contains("strip-hidden")) {
      this.el.style.gridTemplateColumns = "1fr";
      this.el.style.gridTemplateRows = "1fr";
    } else {
      this.el.style.gridTemplateColumns = "1fr var(--strip-w)";
      this.el.style.gridTemplateRows = `repeat(${others}, 1fr)`;
    }
  }

  _toggleStrip() {
    this.el.classList.toggle("strip-hidden");
    this._setStripGlyph();
    this._relayout();
  }

  _setStripGlyph() {
    // "›" = strip visible (click to collapse it rightward); "‹" = hidden (click to show).
    if (this._stripGlyph) this._stripGlyph.textContent = this.el.classList.contains("strip-hidden") ? "‹" : "›";
  }

  // Toggle a tile between the normal grid and filling the whole window. Clicking the
  // focused tile again (or another tile) restores/switches. Driven by a click on the
  // tile's video (the controls sit above it, so they still work).
  _toggleFocus(tileEl) {
    if (this._focusedEl === tileEl) {
      this._clearFocus();
      return;
    }
    if (this._focusedEl) this._focusedEl.classList.remove("focused");
    this._focusedEl = tileEl;
    tileEl.classList.add("focused");
    this.el.classList.add("has-focus");
    this.el.classList.remove("strip-hidden"); // each new focus starts with the strip visible
    this._setStripGlyph();
    this._relayout();
  }

  _clearFocus() {
    if (this._focusedEl) this._focusedEl.classList.remove("focused");
    this._focusedEl = null;
    this.el.classList.remove("has-focus");
    this._relayout();
  }

  // Called after a tile element is removed from the grid: if it was the focused
  // tile, drop focus (which relayouts); otherwise just relayout for the new count.
  _afterRemove(removedEl) {
    if (this._focusedEl === removedEl) this._clearFocus();
    else this._relayout();
  }

  // --- roster ---

  // Add or update a remote participant's base tile (name/role). No-op for self.
  addPeer(peer) {
    if (!peer || !peer.id || peer.id === this.selfId) return;
    const tile = this._ensureTile(peer.id, peer.name, peer.role);
    if (peer.name != null && peer.name !== "") this._setName(tile, peer.name);
    if (peer.role != null) this._setRole(tile, peer.role);
  }

  // A participant left the room: drop their base tile, any screen tile, and their
  // audio analyser/playback so nothing leaks.
  removePeer(id) {
    if (!id || id === this.selfId) return;
    this.pendingMedia.delete(id);
    this._detachAudio(id);
    this._removeScreenTile(id);
    const tile = this.tiles.get(id);
    if (tile) {
      if (tile.cameraVideo) tile.cameraVideo.srcObject = null; // release the stream, matching the other removal paths
      tile.el.remove();
      this.tiles.delete(id);
      this._afterRemove(tile.el);
    }
    if (this.activeId === id) this._setActive(null);
  }

  // --- remote media ---

  // A forwarded remote track arrived. Camera fills the base tile's video, mic wires
  // playback + the active-speaker analyser, and screen gets its own tile. The
  // mic/camera indicator PILLS are NOT touched here: a self-muted track is still
  // published, so track presence cannot tell muted from live — setPeerMedia (the
  // media-state broadcast) is the authoritative source for those indicators.
  onRemoteTrack({ participantId, kind, stream } = {}) {
    if (!participantId) return;
    if (kind === "screen") {
      const known = this.tiles.get(participantId);
      this._addScreenTile(participantId, (known && known.name) || "guest", stream);
      return;
    }
    if (kind === "screen-audio") {
      const known = this.tiles.get(participantId);
      this._attachScreenAudio(participantId, (known && known.name) || "guest", stream);
      return;
    }
    const tile = this._ensureTile(participantId);
    if (kind === "camera") {
      tile.cameraVideo.srcObject = stream;
      tile.cameraVideo.play().catch(() => {}); // nudge playback in case autoplay stalled (black tile)
      tile.hasCamera = true;
    } else if (kind === "mic") {
      this._attachAudio(participantId, stream);
    }
  }

  // A forwarded remote track ended (publisher left mid-track, or a device/track
  // was truly removed). Tear down the video/audio wiring; the indicator pills stay
  // driven by setPeerMedia (the authoritative media-state broadcast), not by track
  // presence — a toggle keeps the track published, so no track-end fires for it.
  onPeerGone({ participantId, kind } = {}) {
    if (!participantId) return;
    if (kind === "screen") {
      this._removeScreenTile(participantId);
      return;
    }
    if (kind === "screen-audio") {
      this._detachScreenAudio(participantId);
      return;
    }
    const tile = this.tiles.get(participantId);
    if (kind === "camera") {
      if (tile) {
        tile.cameraVideo.srcObject = null;
        tile.hasCamera = false;
      }
    } else if (kind === "mic") {
      this._detachAudio(participantId);
    }
  }

  // Drop all REMOTE media (video, audio, screen tiles) — used when the peer is rebuilt
  // on a reconnect: those streams came from the now-dead PC. The participant TILES stay
  // (the roster reconcile keeps them); the fresh peer's forwards repopulate the media.
  // Self media is untouched.
  resetRemoteMedia() {
    for (const [id, tile] of this.tiles) {
      if (id === this.selfId) continue;
      tile.cameraVideo.srcObject = null;
      tile.hasCamera = false;
    }
    for (const id of [...this.audio.keys()]) {
      if (id !== this.selfId) this._detachAudio(id);
    }
    // Skip our OWN screen tile: it renders the local screenStream (which survives the
    // reconnect), not a forward from the dead PC. Removing it made the share vanish for
    // the sharer while everyone else — fed by the re-published track — still saw it.
    for (const id of [...this.screens.keys()]) {
      if (id !== this.selfId) this._removeScreenTile(id);
    }
  }

  // Authoritative remote mic/camera state from a roster entry or a peer-media-state
  // broadcast: crossed-out pill when off, live when on. No-op for self (the self
  // tile is driven locally by refreshSelf). If the peer's tile does not exist yet
  // (state raced ahead of the roster / track), remember it and apply when the tile
  // is built (see _ensureTile). Non-boolean fields are ignored, so a partial or
  // legacy payload leaves the corresponding pill untouched.
  setPeerMedia(id, { mic, camera } = {}) {
    if (!id || id === this.selfId) return;
    const tile = this.tiles.get(id);
    if (!tile) {
      this.pendingMedia.set(id, { mic, camera });
      return;
    }
    this._applyPeerMedia(tile, { mic, camera });
  }

  _applyPeerMedia(tile, { mic, camera } = {}) {
    if (typeof mic === "boolean") this._setIndicator(tile.micPill, mic);
    if (typeof camera === "boolean") {
      this._setIndicator(tile.avPill, camera);
      tile.camOff.hidden = camera; // cover the frozen/black frame when their camera is off
    }
  }

  // Set a remote participant's local playback volume (0..1). Purely client-side:
  // remembers the level on the tile (so a later mic (re)attach honors it) and
  // applies it to the currently-attached <audio> sink if any.
  _setVolume(id, value) {
    const v = Math.min(2, Math.max(0, Number.isFinite(value) ? value : 1)); // 0-200%
    const tile = this.tiles.get(id);
    if (tile) tile.volume = v;
    const a = this.audio.get(id);
    if (a) this._applyVolume(a, v);
  }

  // Apply a 0-2 volume to an audio record { audioEl, gain }. The <audio> element covers
  // 0-100% via element.volume — the reliable, cross-browser way to set WebRTC remote
  // audio level — and a WebAudio gain node adds the >100% BOOST. Exactly one path is
  // audible at a time (the element is muted while WebAudio boosts), so nothing doubles;
  // with no gain node the element still covers the full 0-100%.
  _applyVolume(a, v) {
    const boost = v > 1 && a.gain != null;
    if (a.audioEl) {
      a.audioEl.muted = boost;
      a.audioEl.volume = boost ? 1 : Math.min(1, v);
    }
    if (a.gain) a.gain.gain.value = boost ? v : 0;
  }

  // Update a participant's role badge from a role-change broadcast (op promotion).
  // Works for self too — the self tile carries a badge like any other.
  setPeerRole(id, role) {
    const tile = this.tiles.get(id);
    if (tile) this._setRole(tile, role);
  }

  // The local participant just became an op: retrofit op-action buttons onto every
  // existing remote tile / screen tile. New tiles get them at build time, since
  // opActionsFor / screenOpActionsFor now return markup (controls.isOp flipped true).
  addOpControls() {
    for (const [id, tile] of this.tiles) {
      if (id === this.selfId || tile.el.querySelector(".op-actions")) continue;
      const ops = this.opActionsFor({ id, name: tile.name, role: tile.role });
      if (ops) tile.el.append(ops);
    }
    for (const [id, rec] of this.screens) {
      if (id === this.selfId || rec.el.querySelector(".op-actions")) continue;
      const ops = this.screenOpActionsFor({ id, name: rec.nameEl.textContent });
      if (ops) rec.el.append(ops);
    }
  }

  // --- self tile ---

  // Re-read the local media's live enabled state onto the self tile's indicators.
  // Called by controls.js after a mute/camera toggle (which fires no Media event).
  refreshSelf() {
    const tile = this._selfTile;
    if (!tile) return;
    const mic = this.media ? this.media.micTrack : null;
    const cam = this.media ? this.media.cameraTrack : null;
    const camOn = !!(cam && cam.enabled);
    this._setIndicator(tile.micPill, !!(mic && mic.enabled));
    this._setIndicator(tile.avPill, camOn);
    tile.camOff.hidden = camOn; // show the placeholder when your own camera is off
  }

  _addSelfTile(role) {
    const tile = this._buildTile(this.selfId, this.selfName, role, { self: true });
    tile.cameraVideo.muted = true; // never monitor your own mic
    if (this.media && this.media.stream) tile.cameraVideo.srcObject = this.media.stream;
    this._selfTile = tile;
    this.tiles.set(this.selfId, tile);
    this.el.append(tile.el);
    this._relayout();
    this.refreshSelf();
  }

  // --- tile construction ---

  _ensureTile(id, name, role) {
    let tile = this.tiles.get(id);
    if (tile) return tile;
    tile = this._buildTile(id, name || "guest", role, { self: false });
    this.tiles.set(id, tile);
    this.el.append(tile.el);
    this._relayout();
    // Apply any media state that arrived before this tile existed.
    const pending = this.pendingMedia.get(id);
    if (pending) {
      this.pendingMedia.delete(id);
      this._applyPeerMedia(tile, pending);
    }
    return tile;
  }

  _buildTile(id, name, role, { self }) {
    // Only the local (self) camera is mirrored — a selfie view, as call apps do.
    // Screen-share tiles are built separately (_addScreenTile) and never mirrored.
    const cameraVideo = el("video", { class: self ? "cam mirror" : "cam", autoplay: true, playsinline: true });
    // Camera-off placeholder over the video: a released camera (or a remote peer
    // reporting camera off) leaves the <video> black/frozen, so cover it. Driven by
    // refreshSelf (self) and _applyPeerMedia (remotes); hidden until camera is known off.
    const camOff = el(
      "div",
      { class: "cam-off", hidden: true },
      el("span", { class: "cam-off-icon", text: "🎥" }),
      el("span", { class: "cam-off-text", text: "Camera off" }),
    );
    const nameEl = el("span", { class: "name", text: self ? `${name} (you)` : name });
    const badgeEl = el("span", { class: "badge", hidden: true });
    const micPill = el("span", { class: "pill mic", text: "mic" });
    const avPill = el("span", { class: "pill av", text: "cam" });

    // Per-participant volume (remote tiles only): a purely LOCAL slider that sets
    // this participant's playback <audio>.volume. No wire message — everyone
    // controls the level for themselves. Default 1.0; reapplied whenever the mic
    // stream is (re)attached (see _attachAudio). Numeric attributes only, so it is
    // injection-safe.
    let volumeEl = null;
    if (!self) {
      volumeEl = el("input", {
        type: "range",
        class: "vol",
        min: "0",
        max: "2",
        step: "0.05",
        value: "1",
        title: "Volume (up to 200%)",
        "aria-label": "Volume",
        onInput: (e) => this._setVolume(id, Number(e.target.value)),
      });
    }

    // Volume lives at the tile's top-right (a direct child, not in the meta row),
    // above the video so dragging it never triggers the click-to-focus on the video.
    const meta = el("div", { class: "meta" }, nameEl, badgeEl, el("span", { class: "pills" }, micPill, avPill));

    const tileEl = el("div", { class: self ? "tile self" : "tile", "data-id": id }, cameraVideo, camOff, meta);
    if (volumeEl) tileEl.append(volumeEl);
    // Click the video to blow this tile up to fill the window; click again to restore.
    cameraVideo.title = "Click to focus";
    cameraVideo.addEventListener("click", () => this._toggleFocus(tileEl));

    const tile = { el: tileEl, cameraVideo, camOff, nameEl, badgeEl, micPill, avPill, volumeEl, volume: 1, name, hasCamera: false, self };
    this._setRole(tile, role);
    this._setIndicator(micPill, false);
    this._setIndicator(avPill, false);

    if (!self) {
      const ops = this.opActionsFor({ id, name, role });
      if (ops) tileEl.append(ops);
    }
    return tile;
  }

  _setName(tile, name) {
    tile.name = name;
    tile.nameEl.textContent = tile.self ? `${name} (you)` : name;
    const screen = this.screens.get(tile.el.getAttribute("data-id"));
    if (screen) screen.nameEl.textContent = `${name} (screen)`;
  }

  // op -> "op" badge; voice -> "+" badge; everything else -> no badge.
  _setRole(tile, role) {
    tile.role = role;
    const badge = tile.badgeEl;
    if (role === "op") {
      badge.textContent = "op";
      badge.className = "badge op";
      badge.hidden = false;
    } else if (role === "voice") {
      badge.textContent = "+";
      badge.className = "badge voice";
      badge.hidden = false;
    } else {
      badge.textContent = "";
      badge.hidden = true;
    }
    // If op-action buttons are already on this tile (local user is op), refresh them so
    // "+op" is dropped once the target becomes an op (and would return on a demotion).
    // Skipped during _buildTile: the actions aren't appended yet, so there's nothing to
    // rebuild until the initial opActionsFor call runs with the correct role.
    const existing = tile.el.querySelector(".op-actions");
    if (existing && !tile.self) {
      const id = tile.el.getAttribute("data-id");
      const fresh = this.opActionsFor({ id, name: tile.name, role });
      if (fresh) existing.replaceWith(fresh);
    }
  }

  _setIndicator(pill, on) {
    pill.classList.toggle("on", !!on);
    pill.classList.toggle("off", !on);
  }

  // --- screen tiles ---

  // Build the screen tile skeleton if absent. The video is ALWAYS muted: a local
  // share must not echo your own audio, and a REMOTE share's audio arrives as a
  // separate "screen-audio" track played via _attachScreenAudio. Op controls and the
  // click-to-focus are wired here.
  _ensureScreenTile(id, name) {
    let rec = this.screens.get(id);
    if (rec) return rec;
    const video = el("video", { class: "cam", autoplay: true, playsinline: true });
    video.muted = true;
    // Shown when the share carries no video (an audio-only share); hidden once a video
    // track arrives (see _addScreenTile). pointer-events:none (.cam-off) so a click
    // still focuses the tile.
    const placeholder = el(
      "div",
      { class: "cam-off" },
      el("span", { class: "cam-off-icon", text: "🔊" }),
      el("span", { class: "cam-off-text", text: "Sharing audio" }),
    );
    const nameEl = el("span", { class: "name", text: `${name} (screen)` });
    const elNode = el("div", { class: "tile screen" }, video, placeholder, el("div", { class: "meta" }, nameEl));
    video.title = "Click to focus";
    video.addEventListener("click", () => this._toggleFocus(elNode));
    // Ops can stop a remote participant's screenshare (never your own tile).
    if (id !== this.selfId) {
      const ops = this.screenOpActionsFor({ id, name });
      if (ops) elNode.append(ops);
    }
    rec = { el: elNode, video, nameEl, placeholder, audioEl: null, volumeEl: null, source: null, gain: null, meterTrack: null };
    this.screens.set(id, rec);
    this.el.append(elNode);
    this._relayout();
    // A screen tile just came into existence = someone (self or a peer) started a
    // share. This is the single creation point for all share kinds (video, audio-only,
    // or both funnel through here) and is idempotent, so a reconnect that re-forwards
    // an existing share reuses the tile and does NOT re-chime.
    playSound("bloop");
    return rec;
  }

  _addScreenTile(id, name, stream) {
    if (!stream) return;
    const rec = this._ensureScreenTile(id, name);
    rec.nameEl.textContent = `${name} (screen)`;
    rec.video.srcObject = stream;
    rec.video.play().catch(() => {}); // nudge playback in case autoplay stalled
    if (rec.placeholder) rec.placeholder.hidden = stream.getVideoTracks().length > 0;
  }

  // Attach a REMOTE screen share's audio (its own "screen-audio" track) so it is
  // audible, with a purely-local volume slider at the tile's top-right. Never called
  // for self — you already hear your own shared audio directly.
  _attachScreenAudio(id, name, stream) {
    if (!stream) return;
    const rec = this._ensureScreenTile(id, name);
    if (!rec.audioEl) {
      // The <audio> element itself is the audible 0-100% sink (reliable); WebAudio adds
      // the >100% boost off a clone. Same reliable pattern as _attachAudio / _applyVolume.
      rec.audioEl = el("audio", { class: "sink", autoplay: true });
      rec.el.append(rec.audioEl);
      rec.volumeEl = el("input", {
        type: "range",
        class: "vol",
        min: "0",
        max: "2",
        step: "0.05",
        value: "1",
        title: "Screen volume (up to 200%)",
        "aria-label": "Screen volume",
        onInput: () => this._applyVolume(rec, Math.min(2, Math.max(0, Number(rec.volumeEl.value)))),
      });
      rec.el.append(rec.volumeEl);
    }
    // Tear down any prior WebAudio graph + its clone before re-pointing.
    if (rec.source) {
      try { rec.source.disconnect(); } catch { /* already gone */ }
    }
    if (rec.gain) {
      try { rec.gain.disconnect(); } catch { /* already gone */ }
    }
    if (rec.meterTrack) {
      try { rec.meterTrack.stop(); } catch { /* already stopped */ }
    }
    rec.source = null;
    rec.gain = null;
    rec.meterTrack = null;

    rec.audioEl.srcObject = stream;
    try {
      const raw = stream.getAudioTracks()[0];
      if (raw) {
        const ctx = this._ensureAudioCtx();
        rec.meterTrack = raw.clone();
        rec.source = ctx.createMediaStreamSource(new MediaStream([rec.meterTrack]));
        rec.gain = ctx.createGain();
        rec.gain.gain.value = 0; // silent unless _applyVolume boosts past 100%
        rec.source.connect(rec.gain).connect(ctx.destination);
      }
    } catch {
      // WebAudio unavailable: the element alone still covers 0-100%.
      rec.source = null;
      rec.gain = null;
      if (rec.meterTrack) { try { rec.meterTrack.stop(); } catch { /* ignore */ } rec.meterTrack = null; }
    }
    this._applyVolume(rec, rec.volumeEl ? Math.min(2, Math.max(0, Number(rec.volumeEl.value))) : 1);
    rec.audioEl.play().catch(() => {});
  }

  _detachScreenAudio(id) {
    const rec = this.screens.get(id);
    if (!rec || !rec.audioEl) return;
    if (rec.source) {
      try { rec.source.disconnect(); } catch { /* already gone */ }
    }
    if (rec.gain) {
      try { rec.gain.disconnect(); } catch { /* already gone */ }
    }
    if (rec.meterTrack) {
      try { rec.meterTrack.stop(); } catch { /* already stopped */ }
    }
    rec.source = null;
    rec.gain = null;
    rec.meterTrack = null;
    rec.audioEl.srcObject = null;
    rec.audioEl.remove();
    rec.audioEl = null;
    if (rec.volumeEl) {
      rec.volumeEl.remove();
      rec.volumeEl = null;
    }
  }

  _removeScreenTile(id) {
    const rec = this.screens.get(id);
    if (!rec) return;
    if (rec.source) {
      try { rec.source.disconnect(); } catch { /* already gone */ }
    }
    if (rec.gain) {
      try { rec.gain.disconnect(); } catch { /* already gone */ }
    }
    if (rec.meterTrack) {
      try { rec.meterTrack.stop(); } catch { /* already stopped */ }
    }
    rec.video.srcObject = null;
    if (rec.audioEl) rec.audioEl.srcObject = null;
    rec.el.remove();
    this.screens.delete(id);
    this._afterRemove(rec.el);
  }

  // --- active-speaker (WebAudio) ---

  _ensureAudioCtx() {
    if (!this._audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this._audioCtx = new Ctx();
    }
    if (this._audioCtx.state === "suspended") this._audioCtx.resume().catch(() => {});
    return this._audioCtx;
  }

  // Wire a remote mic stream to (a) a hidden <audio> so it is audible and (b) an
  // AnalyserNode for the active-speaker meter. Idempotent per participant.
  _attachAudio(id, stream) {
    this._detachAudio(id);
    const tile = this.tiles.get(id);
    if (!tile || !stream) return;

    const vol = typeof tile.volume === "number" ? tile.volume : 1;
    // Play the remote mic through the <audio> element itself: element.volume is the
    // reliable, cross-browser control for WebRTC remote audio. (The old design muted the
    // element and routed playback through a WebAudio gain node, so the slider did nothing
    // whenever createMediaStreamSource produced no audible output.) WebAudio is now used
    // ONLY for the >100% boost and the active-speaker meter, and it taps a CLONE of the
    // track so tapping can never silence the element. See _applyVolume.
    const audioEl = el("audio", { class: "sink", autoplay: true });
    audioEl.srcObject = stream;
    tile.el.append(audioEl);

    let source = null;
    let gain = null;
    let analyser = null;
    let data = null;
    let meterTrack = null;
    try {
      const raw = stream.getAudioTracks()[0];
      if (raw) {
        const ctx = this._ensureAudioCtx();
        meterTrack = raw.clone();
        source = ctx.createMediaStreamSource(new MediaStream([meterTrack]));
        gain = ctx.createGain();
        gain.gain.value = 0; // silent unless _applyVolume raises it past 100%
        source.connect(gain).connect(ctx.destination);
        analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.8;
        source.connect(analyser); // parallel tap for the active-speaker meter
        data = new Uint8Array(analyser.fftSize);
      }
    } catch {
      // WebAudio unavailable: the element alone still covers 0-100%.
      source = null;
      gain = null;
      analyser = null;
      data = null;
      if (meterTrack) {
        try { meterTrack.stop(); } catch { /* ignore */ }
        meterTrack = null;
      }
    }

    const a = { audioEl, source, gain, analyser, data, meterTrack };
    this.audio.set(id, a);
    this._applyVolume(a, vol);
    audioEl.play().catch(() => {}); // unmuted autoplay is allowed under the join gesture
    this._ensureLevelLoop();
  }

  // Analyse the LOCAL mic so the self tile joins the active-speaker highlight — the
  // user sees the same blue outline when they talk, confirming their mic is live.
  // No <audio> element (never play your own mic back — that's echo); the analyser is
  // for the meter only. A muted mic is a disabled track = silence = no outline, which
  // correctly reads as "not transmitting". Re-run on every mic-track change (device
  // switch, noise-suppression swap).
  _attachSelfAnalyser() {
    this._detachAudio(this.selfId); // drop any prior source before re-pointing it
    const track = this.media ? this.media.micTrack : null;
    if (!track) return;
    let source = null;
    let analyser = null;
    let data = null;
    try {
      const ctx = this._ensureAudioCtx();
      source = ctx.createMediaStreamSource(new MediaStream([track]));
      analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      source.connect(analyser); // analysis only — never connected to the destination
      data = new Uint8Array(analyser.fftSize);
    } catch {
      return; // WebAudio unavailable/blocked: skip the self highlight
    }
    this.audio.set(this.selfId, { audioEl: null, source, analyser, data });
    this._ensureLevelLoop();
  }

  // Tear down a participant's playback + analyser. Safe to call when absent.
  _detachAudio(id) {
    const a = this.audio.get(id);
    if (!a) return;
    this.audio.delete(id);
    if (a.source) {
      try {
        a.source.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    if (a.analyser) {
      try {
        a.analyser.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    if (a.gain) {
      try {
        a.gain.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    if (a.meterTrack) {
      try {
        a.meterTrack.stop(); // the clone that fed the WebAudio boost/meter
      } catch {
        /* already stopped */
      }
    }
    if (a.audioEl) {
      a.audioEl.srcObject = null;
      a.audioEl.remove();
    }
    if (this.activeId === id) this._setActive(null);
    if (this.audio.size === 0) this._stopLevelLoop();
  }

  _ensureLevelLoop() {
    if (this._levelTimer !== null || this.audio.size === 0) return;
    const tick = () => {
      this._computeActive();
      this._levelTimer = setTimeout(tick, LEVEL_INTERVAL_MS);
    };
    this._levelTimer = setTimeout(tick, LEVEL_INTERVAL_MS);
  }

  _stopLevelLoop() {
    if (this._levelTimer !== null) {
      clearTimeout(this._levelTimer);
      this._levelTimer = null;
    }
  }

  _computeActive() {
    let bestId = null;
    let bestLevel = ACTIVE_THRESHOLD;
    for (const [id, a] of this.audio) {
      if (!a.analyser || !a.data) continue;
      a.analyser.getByteTimeDomainData(a.data);
      let sum = 0;
      for (let i = 0; i < a.data.length; i++) {
        const v = (a.data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / a.data.length);
      if (rms > bestLevel) {
        bestLevel = rms;
        bestId = id;
      }
    }
    this._setActive(bestId);
  }

  _setActive(id) {
    if (this.activeId === id) return;
    if (this.activeId) {
      const prev = this.tiles.get(this.activeId);
      if (prev) prev.el.classList.remove("active");
    }
    this.activeId = id;
    if (id) {
      const next = this.tiles.get(id);
      if (next) next.el.classList.add("active");
    }
  }

  // --- teardown ---

  // Detach Media listeners, tear down every audio node, close the AudioContext,
  // and empty the grid. After this the Grid holds no timers or media references.
  destroy() {
    this._stopLevelLoop();
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    this._focusedEl = null;
    for (const id of [...this.audio.keys()]) this._detachAudio(id);
    if (this._audioCtx) {
      try {
        this._audioCtx.close();
      } catch {
        /* already closed */
      }
      this._audioCtx = null;
    }
    if (this.media) {
      this.media.removeEventListener("mic-track", this._onMicTrack);
      this.media.removeEventListener("camera-track", this._onCameraTrack);
      this.media.removeEventListener("screen-start", this._onScreenStart);
      this.media.removeEventListener("screen-stop", this._onScreenStop);
    }
    for (const tile of this.tiles.values()) tile.cameraVideo.srcObject = null;
    for (const rec of this.screens.values()) rec.video.srcObject = null;
    this.tiles.clear();
    this.screens.clear();
    this.pendingMedia.clear();
    this._selfTile = null;
    this.el.replaceChildren();
  }
}
