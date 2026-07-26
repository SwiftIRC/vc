# Mobile Call-Volume Audio + Output Picker + Deafen — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On mobile, make the *call* volume (not media volume) control call audio; add an audio-output-device picker folded into the mic menu; and add a deafen (mute-all-incoming) toggle.

**Architecture:** A tiny `lib/audioSession.js` sets `navigator.audioSession.type = "play-and-record"` at call start (feature-detected; no-op off Safari/iOS). `grid.js` gains `setAudioOutput`/`setDeafened` that cover BOTH the `<audio class="sink">` elements and the shared `AudioContext` boost path (a >100% remote is audible only through the gain node). `controls.js` drives them: a Speaker `<select>` inside the existing mic menu, and a standalone deafen icon toggle. Client-only; no protocol/server/media-plane change.

**Tech Stack:** Vanilla ES modules; existing `.ctl.icon` / `.device-menu` / `.split-ctl` CSS (no `style.css` change); `node --check` + `node --test internal/web/test/*.test.js`.

## Global Constraints

- **Client-only.** No protocol/server/media-plane change; other participants are unaffected.
- **Feature-detected everywhere.** `navigator.audioSession`, `HTMLMediaElement.prototype.setSinkId`, and `AudioContext.setSinkId` are each guarded; absent APIs are silent no-ops (desktop Chrome/Firefox unaffected by the session change; iOS simply shows no Speaker row).
- **Deafen is transient** (never persisted); the **output device is persisted** in the existing media prefs under `speakerId`.
- **The WebAudio boost path is load-bearing:** `_applyVolume` mutes the `<audio>` element and routes a `>100%` remote entirely through `gain → ctx.destination`. So deafen and output-routing MUST touch the gain/AudioContext, not just the element.
- No `Co-Authored-By` trailer on any commit. `node --check` + `node --test internal/web/test/*.test.js` (glob; a bare-dir arg fails under this sandbox's Node 22) stay green.

---

## File Structure

- `internal/web/assets/lib/icons.js` — add `SPEAKER_PATHS` / `SPEAKER_OFF_PATHS` (deafen glyph). *(Task 1)*
- `internal/web/assets/net/media.js` — `enumerate()` returns `speakers` too. *(Task 1)*
- `internal/web/assets/lib/audioSession.js` — **new**; `useCommunicationAudio()`. *(Task 1)*
- `internal/web/assets/app.js` — call `useCommunicationAudio()` at call start. *(Task 1)*
- `internal/web/assets/lib/prefs.js` — header comment lists `speakerId` (no code change). *(Task 1)*
- `internal/web/assets/ui/grid.js` — `_sinkId`/`_deafened` state; `setAudioOutput`; `setDeafened`; `_applyVolume` deafen guard; sink applied in `_ensureAudioCtx`/`_attachAudio`/`_attachScreenAudio`. *(Task 2)*
- `internal/web/assets/ui/controls.js` — Speaker `<select>` in the mic menu; `_deviceMenu2`; `_fillOutputSelect`; `_switchSpeakerDevice`; deafen button + `_setDeafenButton`/`_toggleDeafen`; `attachGrid` restore. *(Task 3)*

Dependency order: Task 1 (primitives + standalone mobile fix) → Task 2 (grid mechanics) → Task 3 (controls UI consumes both).

---

### Task 1: Primitives + mobile call-volume fix

Adds the leaf pieces the UI consumes (deafen icons, `speakers` enumeration) and independently ships the mobile call-volume fix (the audio-session module, wired at call start).

**Files:**
- Modify: `internal/web/assets/lib/icons.js` (append two path arrays)
- Modify: `internal/web/assets/net/media.js:108-118` (`enumerate`)
- Create: `internal/web/assets/lib/audioSession.js`
- Modify: `internal/web/assets/app.js:28` (import) and `:290-294` (`renderInCall`)
- Modify: `internal/web/assets/lib/prefs.js:1-9` (header comment)

**Interfaces:**
- Produces: `SPEAKER_PATHS`, `SPEAKER_OFF_PATHS` (arrays of SVG path strings); `useCommunicationAudio()`; `media.enumerate()` → `{ cameras, mics, speakers }`.

- [ ] **Step 1: Add the deafen glyph paths to `lib/icons.js`**

Append at the end of the file (Material Design "volume_up" / "volume_off"):

```js
// Material Design "volume_up" and "volume_off" (a speaker with waves, and one with a slash).
// Used by the deafen toggle: SPEAKER when hearing, SPEAKER_OFF when deafened.
export const SPEAKER_PATHS = [
  "M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z",
];
export const SPEAKER_OFF_PATHS = [
  "M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z",
];
```

- [ ] **Step 2: Return `speakers` from `media.enumerate()`**

In `internal/web/assets/net/media.js`, replace the `enumerate()` body (lines 108-118) with:

```js
  async enumerate() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter((d) => d.kind === "videoinput");
    const mics = devices.filter((d) => d.kind === "audioinput");
    const speakers = devices.filter((d) => d.kind === "audiooutput");
    // A camera EXISTS even if the default one failed to open (busy/in use by another
    // app). Mark it available so the camera toggle stays enabled — otherwise a failed
    // default would disable the toggle and leave the user unable to pick a working
    // camera from the list. Only "no camera hardware at all" leaves this false.
    if (cameras.length > 0) this.cameraAvailable = true;
    return { cameras, mics, speakers };
  }
```

(Existing callers destructure `{ cameras, mics }`; the extra key is inert for them.)

- [ ] **Step 3: Create `lib/audioSession.js`**

Create `internal/web/assets/lib/audioSession.js`:

```js
// Ask the browser to treat this page's audio as a two-way call ("play and record")
// rather than media playback, so on mobile the CALL volume — not the media/ringer
// volume — controls it. Only Safari/iOS 16.4+ implements navigator.audioSession;
// everywhere else this is a no-op, so desktop Chrome/Firefox are unaffected.
// Idempotent and cheap; safe to call on every join.
export function useCommunicationAudio() {
  try {
    if (navigator.audioSession) navigator.audioSession.type = "play-and-record";
  } catch {
    /* unsupported or blocked — leave the default session */
  }
}
```

- [ ] **Step 4: Wire it into the call-start flow in `app.js`**

Add the import after line 32 (`import { formatDuration } ...`):

```js
import { useCommunicationAudio } from "./lib/audioSession.js";
```

Then in `renderInCall(msg)` make it the first statement of the body (currently the body opens at line 294 with `peer = new Peer(signaling);`):

```js
function renderInCall(msg) {
  // Tag this as a communication session so mobile uses the CALL volume (no-op off iOS).
  useCommunicationAudio();
  // Media plane. Peer registers its own offer/answer/candidate/tracks handlers in
  // its constructor; that must happen before start() sends the first offer, and
  // synchronously here so it precedes any inbound SFU frame on this socket.
  peer = new Peer(signaling);
```

- [ ] **Step 5: Note `speakerId` in the prefs header comment**

In `internal/web/assets/lib/prefs.js`, extend the header comment (lines 3-4) so the persisted keys list includes `speakerId`:

```js
//   - mic / camera / ns  booleans — the mic/camera/noise-suppression on-off state.
//   - micId / cameraId   deviceId strings — the last input device explicitly selected.
//   - speakerId          deviceId string — the last audio-OUTPUT device explicitly selected.
```

- [ ] **Step 6: Verify — syntax, exports, session no-throw, suite**

Run from the repo root:

```
node --check internal/web/assets/lib/icons.js
node --check internal/web/assets/net/media.js
node --check internal/web/assets/lib/audioSession.js
node --check internal/web/assets/app.js
node --input-type=module -e 'import("./internal/web/assets/lib/icons.js").then(m=>{const ok=Array.isArray(m.SPEAKER_PATHS)&&m.SPEAKER_PATHS.length===1&&Array.isArray(m.SPEAKER_OFF_PATHS)&&m.SPEAKER_OFF_PATHS.length===1;console.log(ok?"speaker paths OK":"MISSING");process.exit(ok?0:1)})'
node --input-type=module -e 'import("./internal/web/assets/lib/audioSession.js").then(m=>{m.useCommunicationAudio();console.log("audioSession no-throw OK")}).catch(e=>{console.error(e);process.exit(1)})'
node --test internal/web/test/*.test.js
```

Expected: `--check` silent; prints `speaker paths OK` and `audioSession no-throw OK`; suite green.

- [ ] **Step 7: Commit**

```bash
git add internal/web/assets/lib/icons.js internal/web/assets/net/media.js internal/web/assets/lib/audioSession.js internal/web/assets/app.js internal/web/assets/lib/prefs.js
git commit -m "feat(web): communication audio session + speaker enumeration + deafen icons"
```

---

### Task 2: Grid audio-output routing + deafen mechanics

Gives the grid the WebAudio-correct machinery to route all remote audio to a chosen device and to deafen — covering the `<audio>` elements AND the boost gain / AudioContext.

**Files:**
- Modify: `internal/web/assets/ui/grid.js` (constructor ~111; `_applyVolume` 420-427; new methods; `_ensureAudioCtx` 790-797; `_attachAudio` 813-815; `_attachScreenAudio` 685-686)

**Interfaces:**
- Produces: `grid.setAudioOutput(deviceId)` and `grid.setDeafened(on)` (both consumed by Task 3).
- Consumes: nothing new (self-contained on the existing audio graph).

- [ ] **Step 1: Add output/deafen state to the constructor**

In `grid.js`, right after `this._levelTimer = null;` (line 111), add:

```js
    // Local audio-output routing + deafen (both apply to CURRENT and FUTURE sinks).
    this._sinkId = ""; // chosen audio-output deviceId (setSinkId); "" = browser default
    this._deafened = false; // when true, ALL incoming audio is muted (transient)
```

- [ ] **Step 2: Add the deafen guard to `_applyVolume`**

Replace `_applyVolume` (lines 420-427) with:

```js
  _applyVolume(a, v) {
    // Deafen wins over any volume/boost: mute the element AND zero the boost gain, so a
    // >100% remote (audible only through the gain node) is silenced too.
    if (this._deafened) {
      if (a.audioEl) a.audioEl.muted = true;
      if (a.gain) a.gain.gain.value = 0;
      return;
    }
    const boost = v > 1 && a.gain != null;
    if (a.audioEl) {
      a.audioEl.muted = boost;
      a.audioEl.volume = boost ? 1 : Math.min(1, v);
    }
    if (a.gain) a.gain.gain.value = boost ? v : 0;
  }
```

- [ ] **Step 3: Add `setAudioOutput` and `setDeafened`**

Immediately after the `_applyVolume` method (before `_showVolLabel`), add:

```js
  // --- audio output device + deafen (local only) ---

  // Route ALL remote audio to a chosen output device: the <audio class="sink"> elements
  // (the 0-100% path) AND the shared AudioContext used for the >100% boost, since a
  // boosted remote plays through ctx.destination, not its (muted) element. setSinkId is
  // Chrome/Edge/Firefox on elements, Chrome-only on AudioContext; every call is caught so
  // a vanished device / unsupported API just falls back to the default output.
  setAudioOutput(deviceId) {
    this._sinkId = deviceId || "";
    for (const a of this.el.querySelectorAll("audio.sink")) {
      if (typeof a.setSinkId === "function") a.setSinkId(this._sinkId).catch(() => {});
    }
    if (this._audioCtx && typeof this._audioCtx.setSinkId === "function") {
      this._audioCtx.setSinkId(this._sinkId).catch(() => {});
    }
  }

  // Mute/unmute ALL incoming audio (deafen). Transient — not persisted. Re-applies volume
  // across every live participant AND screen-share audio entry so the _applyVolume deafen
  // guard takes (or releases) effect on both the element and the boost gain.
  setDeafened(on) {
    this._deafened = !!on;
    for (const [id, a] of this.audio) this._applyVolume(a, this.tiles.get(id)?.volume ?? 1);
    for (const rec of this.screens.values()) {
      if (rec.audioEl) this._applyVolume(rec, rec.volumeEl ? Number(rec.volumeEl.value) || 1 : 1);
    }
  }
```

- [ ] **Step 4: Apply the sink when the AudioContext is created**

Replace `_ensureAudioCtx` (lines 790-797) with:

```js
  _ensureAudioCtx() {
    if (!this._audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this._audioCtx = new Ctx();
      // Inherit any already-chosen output device for the >100% boost path.
      if (this._sinkId && typeof this._audioCtx.setSinkId === "function") {
        this._audioCtx.setSinkId(this._sinkId).catch(() => {});
      }
    }
    if (this._audioCtx.state === "suspended") this._audioCtx.resume().catch(() => {});
    return this._audioCtx;
  }
```

- [ ] **Step 5: Apply the sink to a new participant audio element**

In `_attachAudio`, just after the element is appended (lines 813-815), add the sink line:

```js
    const audioEl = el("audio", { class: "sink", autoplay: true });
    audioEl.srcObject = stream;
    tile.el.append(audioEl);
    // Inherit the chosen output device (no-op when unsupported or "" default).
    if (this._sinkId && typeof audioEl.setSinkId === "function") audioEl.setSinkId(this._sinkId).catch(() => {});
```

(The method already ends with `this._applyVolume(a, vol)`, so a peer joining while deafened is silenced automatically.)

- [ ] **Step 6: Apply the sink to a new screen-share audio element**

In `_attachScreenAudio`, inside the `if (!rec.audioEl)` block, right after `rec.el.append(rec.audioEl);` (line 686), add:

```js
      rec.audioEl = el("audio", { class: "sink", autoplay: true });
      rec.el.append(rec.audioEl);
      // Inherit the chosen output device (no-op when unsupported or "" default).
      if (this._sinkId && typeof rec.audioEl.setSinkId === "function") rec.audioEl.setSinkId(this._sinkId).catch(() => {});
```

(The method already ends with `this._applyVolume(rec, ...)`, so a screen-share starting while deafened is silenced automatically.)

- [ ] **Step 7: Verify — syntax + suite (routing is manual)**

Run:

```
node --check internal/web/assets/ui/grid.js
node --test internal/web/test/*.test.js
```

Expected: `--check` silent; suite green. (Actual output-device routing + deafen are device/DOM-dependent — manual, note pending: see Task 3 Step 8.)

- [ ] **Step 8: Commit**

```bash
git add internal/web/assets/ui/grid.js
git commit -m "feat(web): grid setAudioOutput + setDeafened covering the WebAudio boost path"
```

---

### Task 3: Controls — Speaker select in the mic menu + deafen toggle

Wires the user-facing controls: a Speaker `<select>` folded into the existing mic menu (shown only where output switching works) and a standalone deafen icon toggle.

**Files:**
- Modify: `internal/web/assets/ui/controls.js` (import 28; constructor ~96; `_build` mic section 270-274 and near 311; children 363; `attachGrid` 201-205; `_deviceMenu` area 503; `_populateDevices` 580-590; new `_fillOutputSelect`/`_switchSpeakerDevice`; deafen methods near 544)

**Interfaces:**
- Consumes: `SPEAKER_PATHS`/`SPEAKER_OFF_PATHS`/`svgIcon` (Task 1); `media.enumerate()` → `{ …, speakers }` (Task 1); `grid.setAudioOutput`/`grid.setDeafened` (Task 2); `loadMediaPrefs`/`saveMediaPrefs` (existing).

- [ ] **Step 1: Import the deafen glyphs**

Replace the icons import (line 28) with:

```js
import { svgIcon, MIC_PATHS, MIC_OFF_PATHS, CAM_PATHS, CAM_OFF_PATHS, EYE_PATHS, EYE_OFF_PATHS, SPEAKER_PATHS, SPEAKER_OFF_PATHS } from "../lib/icons.js";
```

- [ ] **Step 2: Read the persisted output device in the constructor**

Right after the hide-self line `this._selfHidden = !!loadLayoutPrefs().selfHidden;` (line 96), add:

```js
    // Chosen audio-output device (setSinkId), restored; "" = the browser default output.
    this._speakerId = loadMediaPrefs().speakerId || "";
```

- [ ] **Step 3: Build the Speaker select into the mic menu**

Replace the mic-control build block (lines 270-274) with:

```js
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
```

- [ ] **Step 4: Add the two-field menu helper**

Right after the existing `_deviceMenu` method (lines 503-505), add:

```js
  // Like _deviceMenu but renders one OR two labelled fields; the second is omitted when
  // selectB is null (e.g. where output selection is unsupported). Used by the mic menu,
  // which carries both the Microphone and Speaker selects.
  _deviceMenu2(labelA, selectA, labelB, selectB) {
    const fields = [el("label", { class: "field" }, el("span", { text: labelA }), selectA)];
    if (selectB) fields.push(el("label", { class: "field" }, el("span", { text: labelB }), selectB));
    return el("div", { class: "device-menu", hidden: true }, ...fields);
  }
```

- [ ] **Step 5: Populate the Speaker select when the mic menu opens**

Replace `_populateDevices` (lines 580-590) with:

```js
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
```

- [ ] **Step 6: Add `_fillOutputSelect` and `_switchSpeakerDevice`**

Right after `_fillDeviceSelect` (ends at line 606), add:

```js
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
```

- [ ] **Step 7: Build the deafen button and its handlers**

In `_build`, right after the hide-self button block (lines 311-316), add:

```js
    // Deafen: mute ALL incoming audio locally. Its own compact toggle (not in a menu) so
    // its state is visible and one click away. Transient — every call starts un-deafened.
    this.deafenBtn = el("button", {
      type: "button", class: "ctl deafen icon",
      "aria-label": "Deafen (mute all incoming audio)",
      onClick: () => this._toggleDeafen(),
    });
    this._deafened = false;
    this._setDeafenButton();
```

Right after `_toggleSelfHidden` (ends at line 557), add:

```js
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
```

Then add `this.deafenBtn` to the control `children` array (line 363), just after `this.cameraWrap`:

```js
    const children = [this.micWrap, this.cameraWrap, this.deafenBtn, this.shareWrap, this.nsBtn, this.colsWrap, this.hideSelfBtn, this.lowBwBtn, this.countdownBtn, this.chatBtn];
```

- [ ] **Step 8: Restore the saved output device in `attachGrid`**

Replace `attachGrid` (lines 201-205) with:

```js
  attachGrid(grid) {
    this.grid = grid || null;
    if (this.grid && this._cols) this.grid.setColumns(this._cols); // apply the restored choice
    if (this.grid) this.grid.setSelfHidden(this._selfHidden); // restore hide-self-view
    if (this.grid && this._speakerId) this.grid.setAudioOutput(this._speakerId); // restore output device
  }
```

- [ ] **Step 9: Verify — syntax + suite**

Run:

```
node --check internal/web/assets/ui/controls.js
node --test internal/web/test/*.test.js
```

Expected: `--check` silent; suite green.

- [ ] **Step 10: Manual check (note pending for the controller)**

- **Desktop Chrome, ≥1 remote:** open the mic caret menu → it shows *Microphone* and *Speaker* lists; pick a different speaker/headset → call audio moves to it; it persists across a refresh. Boost a remote past 100% then switch output → the boosted audio follows too.
- **Deafen:** click the deafen icon → all incoming audio (including a boosted remote and a screen-share audio) goes silent and the glyph flips to muted + highlights; a peer joining while deafened is silent; click again → audio returns; deafen resets to off on the next call.
- **iOS Safari:** no Speaker row appears; the call responds to the *call* volume rocker.

(No browser needed from the implementer — note pending.)

- [ ] **Step 11: Commit**

```bash
git add internal/web/assets/ui/controls.js
git commit -m "feat(web): speaker picker in the mic menu + deafen toggle"
```

---

## Self-Review

**Spec coverage:**
- Call-volume via `navigator.audioSession` (`play-and-record`, feature-detected, at call start) → Task 1 Steps 3-4.
- `enumerate()` returns `speakers` → Task 1 Step 2.
- Output picker folded into the mic menu, gated on `setSinkId` support → Task 3 Steps 3-6, 8.
- Deafen as its own transient icon toggle → Task 3 Step 7 (+ Task 1 Step 1 icons).
- Grid `setAudioOutput`/`setDeafened` covering BOTH the elements and the boost gain / AudioContext → Task 2 Steps 2-6.
- `speakerId` persisted in media prefs; deafen not persisted → Task 3 Steps 2, 6, 7; Task 1 Step 5.
- Client-only; existing CSS reused → no `style.css` / server changes anywhere.
- Testing: `node --check` + smoke + suite + manual → every task's verify step.

**Placeholder scan:** No TBD/TODO; every code step carries complete code, exact anchors, and expected output.

**Type consistency:** `SPEAKER_PATHS`/`SPEAKER_OFF_PATHS` identical across `icons.js`, the `controls.js` import, and the `svgIcon(...)` calls. `setAudioOutput(deviceId)`/`setDeafened(on)` signatures match between `grid.js` (Task 2) and the `controls.js` call sites (Task 3: `attachGrid`, `_switchSpeakerDevice`, `_toggleDeafen`). `media.enumerate()` returns `{ cameras, mics, speakers }` (Task 1) and `_populateDevices` reads `devices.speakers` (Task 3). `speakerId` key consistent across `loadMediaPrefs`/`saveMediaPrefs` uses. `_deviceMenu2`, `_fillOutputSelect`, `_switchSpeakerDevice`, `speakerSelect`, `_speakerId`, `deafenBtn`, `_deafened` names used consistently within `controls.js`.
