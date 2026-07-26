# Mobile call-volume audio + output-device picker + deafen

## Problem

Two related audio gaps, both mobile-motivated but with a desktop payoff:

1. **On mobile the call audio is controlled by the *media* volume, not the *call*
   volume.** Remote audio plays through plain `<audio class="sink" autoplay>`
   elements and nothing sets an audio-session category, so mobile browsers pick a
   default playback/media session. The volume rocker then adjusts "media", which is
   unintuitive during a call and mixes with other media.

2. **There is no way to choose the audio *output* device.** You can pick the mic and
   camera in-call, but not which speaker/headset the call plays out of.

While adding the output picker, also add a **deafen** (mute-all-incoming) toggle — a
frequently-wanted one-click action in a call.

## Decisions

- **Call-volume via the Web Audio Session API.** Set `navigator.audioSession.type =
  "play-and-record"` once at call start. This ties output to the communication/call
  path (Safari/iOS 16.4+). Chrome/Firefox/older Safari don't implement the API, so it
  is a **feature-detected no-op** there — desktop behaviour is unchanged.
  - The user has accepted iOS's routing consequences: a communication session on iOS
    may default output to the earpiece, and iOS applies its own voice processing
    (which can stack with the app's noise-suppression worklet — harmless, still
    toggleable). We do **not** try to force the loud speaker (browsers don't expose
    that on iOS).

- **Output-device picker folded into the microphone menu** (not a separate control
  bar button — saves space, per the user). The mic split-button's caret menu today
  holds one *Microphone* `<select>`; it gains a second *Speaker* `<select>` beneath
  it. The Speaker row is only rendered where output selection is actually supported
  (`'setSinkId' in HTMLMediaElement.prototype`) — so it is absent on iOS, where the
  audio-session change alone does the work.

- **Deafen as its own compact icon toggle** in the control bar, next to the mic
  control. It is a one-click action whose state should be visible at a glance, so it
  gets a `.ctl.icon` button (speaker-off glyph) rather than being buried in the menu.
  Deafen is **transient** — every call starts un-deafened, so a user never rejoins
  unexpectedly silent. (Contrast the mic-mute state, which is persisted.)

- **The chosen output device is persisted** (like `micId`/`cameraId`) so it is
  restored on the next call; deafen is not.

- **Client-only.** No protocol/server/media-plane change. The output device and
  deafen affect only local playback; other participants are unaffected.

## Architecture

```
call start ──> lib/audioSession.js  useCommunicationAudio()
                 └─ navigator.audioSession.type = "play-and-record"  (feature-detected)

controls.js (mic split-button menu)
  ├─ Microphone <select>  (existing)
  └─ Speaker    <select>  (new; only if setSinkId supported)
        onChange ─> grid.setAudioOutput(deviceId) + saveMediaPrefs({ speakerId })

controls.js (new deafen icon button)
        onClick ─> grid.setDeafened(on)  (transient)

grid.js
  ├─ setAudioOutput(deviceId): setSinkId() on every audio.sink + the AudioContext
  │                            (the >100% boost plays through ctx.destination)
  └─ setDeafened(on):          _applyVolume guard mutes element AND zeroes gain
                               (a boosted remote is audible only via the gain)

net/media.js  enumerate() ─> { cameras, mics, speakers }   (speakers = audiooutput)
lib/prefs.js  media prefs gain speakerId (generic merge; no code change needed)
lib/icons.js  SPEAKER_PATHS / SPEAKER_OFF_PATHS for the deafen glyph
```

## Change — `internal/web/assets/lib/audioSession.js` (new)

A tiny module with one export:

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

Called once when the call starts (the same place the grid/controls are wired up in
`app.js`, after the join gesture). Exact call site chosen during planning to match the
existing call-start flow.

## Change — `internal/web/assets/net/media.js`

`enumerate()` returns speakers too:

```js
async enumerate() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cameras = devices.filter((d) => d.kind === "videoinput");
  const mics = devices.filter((d) => d.kind === "audioinput");
  const speakers = devices.filter((d) => d.kind === "audiooutput");
  if (cameras.length > 0) this.cameraAvailable = true;
  return { cameras, mics, speakers };
}
```

(Existing callers destructure `{ cameras, mics }` and are unaffected by the extra key.)

## Change — `internal/web/assets/ui/grid.js`

**Critical constraint (from `_applyVolume`, grid.js:420):** a remote at volume `> 100%`
is played with its `<audio>` element **muted**, its sound coming entirely from a
WebAudio `gain → ctx.destination` path off a cloned track. So `element.muted` does not
silence a boosted remote, and `element.setSinkId` does not route it — both deafen and
output-selection MUST also touch the shared `AudioContext` / gain nodes, not just the
elements. The active-speaker meter is a *parallel* `analyser` tap off the same source
(grid.js:834), independent of both the element and the gain, so deafen silences
playback while the speaking indicator keeps working.

State in the constructor: `this._sinkId = ""` (empty = browser default) and
`this._deafened = false`.

**Output device — cover both the element path and the boost path:**

```js
  // Route ALL remote audio to a chosen output device: the <audio class="sink"> elements
  // (the 0-100% path) AND the shared AudioContext used for the >100% boost, since a
  // boosted remote plays through ctx.destination, not its (muted) element. Every call is
  // caught, so a vanished device / unsupported API just falls back to the default.
  setAudioOutput(deviceId) {
    this._sinkId = deviceId || "";
    for (const a of this.el.querySelectorAll("audio.sink")) {
      if (typeof a.setSinkId === "function") a.setSinkId(this._sinkId).catch(() => {});
    }
    if (this._audioCtx && typeof this._audioCtx.setSinkId === "function") {
      this._audioCtx.setSinkId(this._sinkId).catch(() => {}); // Chrome-only; no-op elsewhere
    }
  }
```

- `_ensureAudioCtx()` — after creating `this._audioCtx`, apply the remembered sink so a
  context created *after* the device was chosen still routes there:
  `if (this._sinkId && typeof this._audioCtx.setSinkId === "function") this._audioCtx.setSinkId(this._sinkId).catch(() => {});`
- `_attachAudio()` (and the screen-share sink-creation path) — after creating the
  `audioEl`, apply the remembered sink:
  `if (this._sinkId && typeof audioEl.setSinkId === "function") audioEl.setSinkId(this._sinkId).catch(() => {});`

**Deafen — enforced inside `_applyVolume` so both audible paths are covered** and late
joiners inherit it (both `_attachAudio` and `_setVolume` already route through
`_applyVolume`):

```js
  _applyVolume(a, v) {
    if (this._deafened) {          // deafen wins over any volume/boost
      if (a.audioEl) a.audioEl.muted = true;
      if (a.gain) a.gain.gain.value = 0;
      return;
    }
    const boost = v > 1 && a.gain != null;   // ── unchanged below ──
    if (a.audioEl) {
      a.audioEl.muted = boost;
      a.audioEl.volume = boost ? 1 : Math.min(1, v);
    }
    if (a.gain) a.gain.gain.value = boost ? v : 0;
  }

  // Mute/unmute ALL incoming audio (deafen). Transient; not persisted. Re-applies
  // volume across every live audio entry so the guard above takes/loses effect.
  setDeafened(on) {
    this._deafened = !!on;
    for (const [id, a] of this.audio) this._applyVolume(a, this.tiles.get(id)?.volume ?? 1);
    // Screen-share audio shares this._deafened via the same _applyVolume (its `a` has the
    // same {audioEl, gain} shape); re-apply across the screen audio entries here too.
  }
```

Because a boosted remote is audible only through the gain node, deafen that only set
`element.muted` would leak boosted audio — hence the guard lives in `_applyVolume`,
which owns both the element and the gain.

## Change — `internal/web/assets/ui/controls.js`

**Speaker select in the mic menu.** Build a `speakerSelect` and add it to the existing
mic menu, guarded by support:

```js
this.micSelect = el("select", { class: "device", onChange: () => this._switchMicDevice() });
this._outputSupported = "setSinkId" in HTMLMediaElement.prototype;
this.speakerSelect = this._outputSupported
  ? el("select", { class: "device", onChange: () => this._switchSpeakerDevice() })
  : null;
this.micMenu = this._deviceMenu2("Microphone", this.micSelect, "Speaker", this.speakerSelect);
```

`_deviceMenu2(labelA, selectA, labelB, selectB)` generalises the existing
`_deviceMenu` to render one or two labelled fields (the second omitted when
`selectB` is null). Opening the mic menu populates both:

```js
async _populateDevices(kind) {
  if (!this.media) return;
  let devices;
  try { devices = await this.media.enumerate(); } catch { return; }
  if (kind === "camera") {
    this._fillDeviceSelect(this.cameraSelect, devices.cameras, this.media.cameraTrack, "Camera");
  } else {
    this._fillDeviceSelect(this.micSelect, devices.mics, this.media.micTrack, "Microphone");
    if (this.speakerSelect) this._fillOutputSelect(devices.speakers);
  }
}
```

`_fillOutputSelect(list)` mirrors `_fillDeviceSelect` but marks the option matching
the persisted `this._speakerId` as selected (there is no "active track" to read a
current output from). An empty list disables the select.

```js
async _switchSpeakerDevice() {
  if (!this.grid || !this.speakerSelect) return;
  this._speakerId = this.speakerSelect.value;
  this.grid.setAudioOutput(this._speakerId);
  saveMediaPrefs({ speakerId: this._speakerId });
  this._closeMenus();
}
```

Constructor reads `this._speakerId = loadMediaPrefs().speakerId || "";`.

**Deafen icon toggle.** A `.ctl.icon` button using new speaker glyphs:

```js
this.deafenBtn = el("button", {
  type: "button", class: "ctl deafen icon",
  "aria-label": "Deafen (mute all incoming audio)",
  onClick: () => this._toggleDeafen(),
});
this._deafened = false;
this._setDeafenButton();
```

added to the control `children` next to the mic control, with:

```js
_setDeafenButton() {
  this.deafenBtn.replaceChildren(svgIcon(this._deafened ? SPEAKER_OFF_PATHS : SPEAKER_PATHS));
  this.deafenBtn.classList.toggle("active", this._deafened);
  const label = this._deafened ? "Undeafen (restore incoming audio)" : "Deafen (mute all incoming audio)";
  this.deafenBtn.title = label;
  this.deafenBtn.setAttribute("aria-label", label);
}
_toggleDeafen() {
  this._deafened = !this._deafened;
  this._setDeafenButton();
  if (this.grid) this.grid.setDeafened(this._deafened);
}
```

**Restore on attach.** `attachGrid(grid)` applies the saved output device (mirrors the
columns / self-hidden restore already there):

```js
if (this.grid && this._speakerId) this.grid.setAudioOutput(this._speakerId);
```

(Deafen is transient, so nothing to restore.)

## Change — `internal/web/assets/lib/icons.js`

Add Material-Design "volume_up" / "volume_off" path sets, exported like the mic/cam/eye
paths:

```js
// Material Design "volume_up" and "volume_off" (a speaker with waves, and one with a slash).
export const SPEAKER_PATHS = [
  "M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z",
];
export const SPEAKER_OFF_PATHS = [
  "M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z",
];
```

## Change — `internal/web/assets/lib/prefs.js`

No code change: `speakerId` rides in the existing media prefs via the generic merge.
The header comment is updated to list `speakerId` alongside `micId`/`cameraId`.

## Edge cases

- **iOS / unsupported output selection** — `setSinkId` absent → the Speaker row is not
  rendered and `setAudioOutput` is a no-op; only the audio-session change applies.
- **Selected output device removed** — `setSinkId` rejects; caught, playback falls back
  to the default device. Next menu open re-lists what's present.
- **Deafen + a peer joining while deafened** — `_attachAudio` ends by calling
  `_applyVolume`, whose deafen guard mutes the element and zeroes the gain, so late
  joiners (and boosted ones) are silent too until undeafened.
- **Deafen and the active-speaker meter** — the meter is a parallel `analyser` tap off
  a *cloned* track (grid.js:834), independent of both `element.muted` and the boost
  `gain`, so deafen silences playback while the speaking indicator keeps working
  (confirmed against `_applyVolume`/`_attachAudio`).
- **audioSession + noise suppression** — iOS voice processing may stack with the NS
  worklet; acceptable and user-toggleable. No code interaction.

## Testing

- `node --check` on the new/changed modules.
- `node --input-type=module` smoke: `SPEAKER_PATHS`/`SPEAKER_OFF_PATHS` are arrays;
  `useCommunicationAudio()` doesn't throw when `navigator.audioSession` is absent.
- Existing `node --test internal/web/test/*.test.js` suite stays green.
- Manual (device-dependent, note pending): on desktop Chrome, the mic menu shows a
  Speaker list and switching it moves call audio to that device; deafen mutes/unmutes
  all incoming audio; the choice persists across a refresh. On iOS, the call responds
  to the *call* volume (no Speaker row expected).

## Out of scope

- Forcing the loud speaker on iOS (browsers don't expose it).
- Per-remote individual volume sliders; a test-tone / output preview.
- Persisting deafen across sessions.
- Any server/protocol/media-plane change.
