# Lobby Speaker Picker — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Speaker picker to the pre-join lobby with the same options as the in-call one, plus a Test button that plays a blip through the selected output so the choice is verifiable before joining.

**Architecture:** The lobby and the control bar already fill Camera/Microphone `<select>`s with near-identical private methods, and the in-call Speaker list adds a third near-copy. Task 1 collapses all three into one shared `lib/deviceSelect.js` helper — no behaviour change — so the new lobby picker is a *call*, not a fourth copy. The picker writes the existing `speakerId` media pref, which `Controls` already reads in its constructor and applies in `attachGrid`, so the choice reaches the call with **no new wiring**. The Test button drives a private `<audio>` owned by `Prejoin`, deliberately not `lib/sounds.js`, whose elements are shared with the in-call chimes.

**Tech Stack:** Vanilla ES modules; the existing `.devices` / `.field` CSS plus one new `.speaker-field` rule; `node --check` + `node --test internal/web/test/*.test.js`.

**Spec:** `docs/superpowers/specs/2026-08-20-lobby-speaker-picker-design.md`

## Global Constraints

- **Client-only.** No protocol/server/media-plane change. `media.enumerate()` already returns `speakers` — the lobby simply stops discarding it.
- **No duplicated select-filling logic.** The user ruled explicitly that a shared helper governs over the copy-paste the codebase currently has: `lib/deviceSelect.js` is the single implementation, and `prejoin.js` / `controls.js` both call it. Do not reintroduce a private `_fillSelect` / `_fillDeviceSelect` / `_fillOutputSelect` in either UI module.
- **Task 1 is a pure refactor.** Identical rendered output for every existing case. The empty-list message is `No ${label.toLowerCase()} found`, which for `"Speaker"` yields exactly `No speaker found` — byte-identical to the string it replaces. If any behaviour changes, the refactor is wrong.
- **Feature-detected.** Everything speaker-related in the lobby is gated on `typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype` — the same test as `controls.js:292`. Where it is false (iOS Safari) the field and the button are **both absent**; `el()` skips `null` children (`prejoin.js:64`), so no call site needs a branch.
- **No new pref key.** `speakerId` already exists and is already documented in `prefs.js:5`. Do not add one, and do not change `prefs.js`.
- **Do not touch `lib/sounds.js`.** It caches one shared `<audio>` per sound for the in-call chimes; calling `setSinkId` on a cached element would re-route the in-call join/drop chimes as a side effect of a lobby click.
- **No automated tests for this work — this is a ruling, not an oversight.** `internal/web/test/` is `node:test` over the pure-logic `lib/` modules; the repo has no DOM harness and the user ruled against adding one. Do **not** add jsdom or any DOM test harness, and do not treat the absence of unit tests as a defect. Verification is `node --check`, the existing suite staying green, and new `MANUAL-TEST.md` entries — the shape the in-call picker shipped with (`docs/superpowers/plans/2026-07-26-audio-output-picker.md`).
- Run the suite as a **glob**: `node --test internal/web/test/*.test.js` (a bare-dir arg fails under this sandbox's Node 22).
- No `Co-Authored-By` trailer on any commit.

---

## File Structure

- `internal/web/assets/lib/deviceSelect.js` — **new**; `fillDeviceSelect()` + `trackDeviceId()`, the one implementation both UIs use *(Task 1)*.
- `internal/web/assets/ui/controls.js` — drops `_fillDeviceSelect` and `_fillOutputSelect` in favour of the helper *(Task 1)*.
- `internal/web/assets/ui/prejoin.js` — drops `_fillSelect` for the helper *(Task 1)*; gains the gated Speaker select and `_switchSpeaker` *(Task 2)*; the Test button, `_testSpeaker`/`_endSpeakerTest`, teardown *(Task 3)*.
- `internal/web/assets/style.css` — one `.speaker-field` rule for the full-width row *(Task 2)*.
- `MANUAL-TEST.md` — new **Pre-join screen** entries: the picker, persistence, carry-into-call, iOS absence *(Task 2)*; the Test button *(Task 3)*.

Dependency order: Task 1 (shared helper, no behaviour change) → Task 2 (the picker, calling it) → Task 3 (the Test button layered on).

**Anchor warning for Tasks 2 and 3:** Task 1 deletes ~15 lines from `prejoin.js`, so every line number below `_populateDevices` shifts. Tasks 2 and 3 therefore anchor by **named method**, never by line number. Locate the named neighbour and work relative to it.

---

### Task 1: Extract the shared device-select filler

Collapse three near-identical private methods into one shared helper. Pure refactor: no rendered output changes for any existing picker. This exists so Task 2's Speaker list is a call rather than a fourth copy.

**Files:**
- Create: `internal/web/assets/lib/deviceSelect.js`
- Modify: `internal/web/assets/ui/prejoin.js` (`_populateDevices` 324-334; delete `_fillSelect` 336-350; add an import beside the existing ones at 12-16)
- Modify: `internal/web/assets/ui/controls.js` (`_populateDevices` 684-698; delete `_fillDeviceSelect` 700-714 and `_fillOutputSelect` 716-732; add an import beside the existing ones at 26-31)

**Interfaces:**
- Produces: `fillDeviceSelect(select, list, activeId, label)` → `undefined` (sets `select.disabled`), and `trackDeviceId(track)` → `string`. Both consumed by Task 2.

Call sites are exactly three, all inside the two `_populateDevices` methods — verified, there are no others in the codebase.

- [ ] **Step 1: Create the shared module**

Create `internal/web/assets/lib/deviceSelect.js`:

```js
// Fill a device <select> from an enumerateDevices() list. Shared by the lobby
// (ui/prejoin.js) and the in-call control bar (ui/controls.js), which offer the same
// Camera / Microphone / Speaker pickers in different chrome and previously each kept
// their own near-identical copy of this.
//
// activeId is the deviceId to mark selected. For an INPUT that is the live track's
// device (see trackDeviceId); for an OUTPUT there is no track to read a sink from, so
// it is the persisted choice. "" marks nothing, which leaves the browser showing the
// first option — so a caller acting on the selection should read select.value rather
// than assume activeId is what the user sees.
//
// label ("Camera" / "Microphone" / "Speaker") supplies both the empty-list message and
// the fallback names: enumerateDevices only populates real labels once permission has
// been granted, so an unnamed device still gets "Camera 1" rather than a blank row.
//
// Sets select.disabled — true when there is nothing to choose, false otherwise. A
// caller with a companion control (the lobby's speaker Test button) should follow
// select.disabled rather than re-deriving emptiness.
export function fillDeviceSelect(select, list, activeId, label) {
  select.replaceChildren();
  if (list.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = `No ${label.toLowerCase()} found`;
    select.append(opt);
    select.disabled = true;
    return;
  }
  select.disabled = false;
  list.forEach((d, i) => {
    const opt = document.createElement("option");
    opt.value = d.deviceId;
    opt.textContent = d.label || `${label} ${i + 1}`;
    if (d.deviceId && d.deviceId === activeId) opt.selected = true;
    select.append(opt);
  });
}

// The deviceId a live track is currently using, or "" when there is no track (the
// camera is off, or the device failed to open). Pass the result as fillDeviceSelect's
// activeId for an input picker.
export function trackDeviceId(track) {
  return track ? track.getSettings().deviceId : "";
}
```

`document.createElement` rather than either module's private `el()` helper: this module is shared, and neither `el()` is exported.

- [ ] **Step 2: Point `prejoin.js` at the helper**

Add the import after the existing `mediaErrors` import (line 16):

```js
import { fillDeviceSelect, trackDeviceId } from "../lib/deviceSelect.js";
```

Replace `_populateDevices` **and** the whole `_fillSelect` method that follows it (lines 324-350) with just:

```js
  async _populateDevices() {
    let devices;
    try {
      devices = await this.media.enumerate();
    } catch {
      return;
    }
    if (this.destroyed) return;
    fillDeviceSelect(this.cameraSelect, devices.cameras, trackDeviceId(this.media.cameraTrack), "Camera");
    fillDeviceSelect(this.micSelect, devices.mics, trackDeviceId(this.media.micTrack), "Microphone");
  }
```

`_fillSelect` is deleted outright — it had exactly one caller, this one.

- [ ] **Step 3: Point `controls.js` at the helper**

Add the import after the existing `sounds` import (line 30):

```js
import { fillDeviceSelect, trackDeviceId } from "../lib/deviceSelect.js";
```

Replace `_populateDevices` **and** both fill methods that follow it (lines 684-732) with just:

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
      fillDeviceSelect(this.cameraSelect, devices.cameras, trackDeviceId(this.media.cameraTrack), "Camera");
    } else {
      fillDeviceSelect(this.micSelect, devices.mics, trackDeviceId(this.media.micTrack), "Microphone");
      // No active track to read a sink from, so the persisted choice is what gets marked.
      if (this.speakerSelect) fillDeviceSelect(this.speakerSelect, devices.speakers || [], this._speakerId, "Speaker");
    }
  }
```

`_fillDeviceSelect` and `_fillOutputSelect` are deleted outright — one caller each, both here.

- [ ] **Step 4: Verify — syntax, no stragglers, suite**

Run from the repo root:

```
node --check internal/web/assets/lib/deviceSelect.js
node --check internal/web/assets/ui/prejoin.js
node --check internal/web/assets/ui/controls.js
grep -rn "_fillSelect\|_fillDeviceSelect\|_fillOutputSelect" internal/web/assets/
node --test internal/web/test/*.test.js
```

Expected: all three `--check` silent (no output, exit 0); the `grep` prints **nothing** and exits 1 — any hit means a deleted method or a stale call site survived; suite green (161 pass, 0 fail).

- [ ] **Step 5: Commit**

```bash
git add internal/web/assets/lib/deviceSelect.js internal/web/assets/ui/prejoin.js internal/web/assets/ui/controls.js
git commit -m "refactor(web): one device-select filler for the lobby and the control bar"
```

---

### Task 2: Speaker select in the lobby

The picker itself: a gated third device field that lists audio outputs, marks the persisted choice, and saves it so the call picks it up.

**Files:**
- Modify: `internal/web/assets/ui/prejoin.js` (in `_build`, the `cameraSelect`/`micSelect` pair and the `.devices` block; `_populateDevices`; a new `_switchSpeaker` after `_switchMic`)
- Modify: `internal/web/assets/style.css:137` (after the `.devices select` block, before `.row {`)
- Modify: `MANUAL-TEST.md:36` (after the **Device pickers** item)

**Interfaces:**
- Consumes: `fillDeviceSelect(select, list, activeId, label)` (Task 1); `media.enumerate()` → `{ cameras, mics, speakers }` (existing, `net/media.js:227`); `loadMediaPrefs`/`saveMediaPrefs` (already imported at `prejoin.js:12`).
- Produces: `this._outputSupported` (boolean), `this.speakerSelect` (`HTMLSelectElement | null`), `this.speakerField` (`HTMLDivElement | null`) — all consumed by Task 3.

- [ ] **Step 1: Build the gated Speaker select**

In `_build()`, find the two device-select lines:

```js
    this.cameraSelect = el("select", { class: "device", onChange: () => this._switchCamera() });
    this.micSelect = el("select", { class: "device", onChange: () => this._switchMic() });
```

and append the speaker block directly after them:

```js
    // Output-device selection, only where the browser can actually switch sinks
    // (Chrome/Edge/Firefox; NOT iOS) — the same gate the in-call control uses. Where
    // it's unsupported these stay null and el() skips them, so the lobby looks exactly
    // as it did before.
    this._outputSupported = typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
    this.speakerSelect = this._outputSupported
      ? el("select", { class: "device", onChange: () => this._switchSpeaker() })
      : null;
    this.speakerField = this._outputSupported
      ? el("div", { class: "speaker-field" }, el("label", { class: "field" }, el("span", { text: "Speaker" }), this.speakerSelect))
      : null;
```

- [ ] **Step 2: Add the field to the `.devices` grid**

Still in `_build()`, replace the `.devices` block:

```js
      el("div", { class: "devices" },
        el("label", { class: "field" }, el("span", { text: "Camera" }), this.cameraSelect),
        el("label", { class: "field" }, el("span", { text: "Microphone" }), this.micSelect),
      ),
```

with:

```js
      el("div", { class: "devices" },
        el("label", { class: "field" }, el("span", { text: "Camera" }), this.cameraSelect),
        el("label", { class: "field" }, el("span", { text: "Microphone" }), this.micSelect),
        this.speakerField, // null where output switching is unsupported — el() skips it
      ),
```

- [ ] **Step 3: Populate the Speaker select at mount**

In `_populateDevices` (as Task 1 left it), add a third fill call after the Microphone one, so the body ends:

```js
    fillDeviceSelect(this.cameraSelect, devices.cameras, trackDeviceId(this.media.cameraTrack), "Camera");
    fillDeviceSelect(this.micSelect, devices.mics, trackDeviceId(this.media.micTrack), "Microphone");
    // No active track to read a sink from, so the PERSISTED choice is what gets marked.
    if (this.speakerSelect) fillDeviceSelect(this.speakerSelect, devices.speakers || [], loadMediaPrefs().speakerId || "", "Speaker");
  }
```

- [ ] **Step 4: Add `_switchSpeaker`**

Immediately after the `_switchMic` method, add:

```js
  // There is no remote audio in the lobby, so a chosen output has nothing to reroute
  // here — persisting it IS the effect. Controls reads speakerId in its constructor and
  // applies it via attachGrid, and it is built on join accept (app.js), i.e. after this.
  // The log line matches grid.js's, so the [audio capture] / [audio switch] /
  // [audio output] trio MANUAL-TEST.md leans on for echo chasing is complete from the
  // lobby onward.
  _switchSpeaker() {
    const id = this.speakerSelect.value;
    saveMediaPrefs({ speakerId: id }); // picked up by Controls on join
    console.info(`[audio output] sink=${id || "(browser default)"}`);
  }
```

- [ ] **Step 5: Add the row's CSS**

In `internal/web/assets/style.css`, immediately after the `.devices select { … }` block (ends line 137) and before `.row {`, insert:

```css
/* The Speaker row spans the Camera/Microphone columns and carries its Test button
   beside the select. flex-end aligns the button to the bottom of the select, clear
   of the field's label span above it. The existing `.devices .field { min-width: 0 }`
   and `.devices select { width: 100% }` still match the nested field, so a long
   device name can't force the row wider. */
.speaker-field {
  grid-column: 1 / -1;
  display: flex;
  align-items: flex-end;
  gap: 0.5rem;
}

.speaker-field .field {
  flex: 1;
}
```

- [ ] **Step 6: Add the manual-test entries**

In `MANUAL-TEST.md`, immediately after the **Device pickers** item (ends line 36) and before **Audio processing is reported**, insert:

```markdown
- [ ] **Speaker picker lists your outputs** — the lobby shows a Speaker dropdown
      below the Camera / Microphone row, listing your audio outputs. Selecting one
      logs an `[audio output] sink=…` line naming it.
- [ ] **The lobby speaker carries into the call** — pick a non-default output (a
      headset), then Join. Remote audio arrives on that device with no further
      selection in-call, and the in-call mic caret menu's Speaker list shows the
      same device already selected. Reload the lobby: the choice is still selected.
- [ ] **No Speaker field where output switching is unsupported** — on iOS Safari
      (no `setSinkId`) the lobby shows no Speaker field, while Camera and
      Microphone still work and Join is unaffected.
```

- [ ] **Step 7: Verify — syntax + suite**

Run from the repo root:

```
node --check internal/web/assets/ui/prejoin.js
node --test internal/web/test/*.test.js
```

Expected: `--check` silent (no output, exit 0); suite green. Device enumeration and sink routing are DOM/device-dependent — they are covered by the Step 6 manual entries, not by this suite.

- [ ] **Step 8: Commit**

```bash
git add internal/web/assets/ui/prejoin.js internal/web/assets/style.css MANUAL-TEST.md
git commit -m "feat(web): pick your speaker in the lobby, not just in the call"
```

---

### Task 3: Test button

Makes the lobby choice verifiable. In-call, selecting a speaker reroutes live audio and confirms itself; in the lobby nothing is playing, so a blip on demand is the only confirmation available.

**Files:**
- Modify: `internal/web/assets/ui/prejoin.js` (module constants after `POLL_INTERVAL_MS:18`; constructor after `this.pollTimer = null;`; the `speakerField` assignment in `_build`; `_populateDevices`; a new `_testSpeaker`/`_endSpeakerTest` after `_switchSpeaker`; `destroy`)
- Modify: `MANUAL-TEST.md` (after the **No Speaker field where output switching is unsupported** item added in Task 2)

**Interfaces:**
- Consumes: `this._outputSupported`, `this.speakerSelect`, `this.speakerField` (Task 2); `this.errorLabel` (existing); `this.destroyed` (existing).
- Produces: `this.testSpeakerBtn` (`HTMLButtonElement | null`), `_testSpeaker()`, `_endSpeakerTest()`.

- [ ] **Step 1: Add the module constants**

In `internal/web/assets/ui/prejoin.js`, immediately after `const POLL_INTERVAL_MS = 3000;` (line 18), add:

```js
const TEST_SOUND = "/sounds_bloop.mp3"; // short, neutral blip for the speaker test
const TEST_TIMEOUT_MS = 3000; // re-arm the Test button even if "ended" never fires
```

- [ ] **Step 2: Declare the instance state**

In the constructor, immediately after `this.pollTimer = null;`, add:

```js
    this._testAudio = null; // lazily created <audio> for the speaker test
    this._testTimer = null; // re-arms the Test button if "ended" never fires
```

- [ ] **Step 3: Build the Test button into the speaker field**

In `_build()`, replace the `speakerField` assignment added in Task 2 Step 1:

```js
    this.speakerField = this._outputSupported
      ? el("div", { class: "speaker-field" }, el("label", { class: "field" }, el("span", { text: "Speaker" }), this.speakerSelect))
      : null;
```

with:

```js
    // The button is a SIBLING of the <label>, never inside it: a click on a label
    // activates its associated control, so a button nested in one would also pop the
    // select open.
    this.testSpeakerBtn = this._outputSupported
      ? el("button", { type: "button", class: "test-speaker", onClick: () => this._testSpeaker() }, "Test")
      : null;
    this.speakerField = this._outputSupported
      ? el(
          "div",
          { class: "speaker-field" },
          el("label", { class: "field" }, el("span", { text: "Speaker" }), this.speakerSelect),
          this.testSpeakerBtn,
        )
      : null;
```

- [ ] **Step 4: Disable Test when there is nothing to play through**

In `_populateDevices`, extend the speaker branch added in Task 2 Step 3 so the button follows the select's own enabled state (`fillDeviceSelect` sets `select.disabled` — do not re-derive emptiness):

```js
    // No active track to read a sink from, so the PERSISTED choice is what gets marked.
    if (this.speakerSelect) {
      fillDeviceSelect(this.speakerSelect, devices.speakers || [], loadMediaPrefs().speakerId || "", "Speaker");
      this.testSpeakerBtn.disabled = this.speakerSelect.disabled; // nothing to play through
    }
```

- [ ] **Step 5: Add `_testSpeaker` and `_endSpeakerTest`**

Immediately after `_switchSpeaker` (added in Task 2 Step 4), add:

```js
  // Play a blip through the DISPLAYED output so the choice is verifiable before
  // joining. Reads the select rather than a stored id: with no saved preference
  // nothing is marked selected and the browser shows the first option, so reading the
  // select always tests exactly what's on screen.
  //
  // A private <audio>, NOT lib/sounds.js: that module caches one shared element per
  // sound for the in-call chimes, and calling setSinkId on a cached element would
  // re-route the in-call join/drop chimes as a side effect of a lobby click.
  async _testSpeaker() {
    if (!this.testSpeakerBtn || this.testSpeakerBtn.disabled) return;
    if (!this._testAudio) {
      this._testAudio = new Audio(TEST_SOUND);
      this._testAudio.addEventListener("ended", () => this._endSpeakerTest());
    }
    const audio = this._testAudio;
    this.testSpeakerBtn.disabled = true;
    try {
      audio.currentTime = 0; // restart if a previous test is still running
    } catch {
      /* not seekable yet — play() below still starts it. Deliberately outside the
         reporting try: this throw is harmless and must not be reported as a
         playback failure that never happened. */
    }
    try {
      // Awaiting before play() is safe: autoplay policy keys off STICKY user
      // activation, not transient, and by the time this button exists the user has
      // granted mic/camera permission — which unblocks autoplay on its own in both
      // Chrome and Firefox. This is the one chime in the app that is gesture-driven
      // rather than network-triggered, so it needs none of sounds.js's iOS priming.
      await audio.setSinkId(this.speakerSelect.value || ""); // "" = browser default
      await audio.play();
    } catch (err) {
      this.errorLabel.textContent = `Could not play a test sound through that speaker (${err.name || "error"}).`;
      this._endSpeakerTest();
      return;
    }
    if (this.destroyed) return;
    this._testTimer = setTimeout(() => this._endSpeakerTest(), TEST_TIMEOUT_MS);
  }

  // Re-arm the button. Guarded on destroyed so a late timer never touches a dead one.
  _endSpeakerTest() {
    clearTimeout(this._testTimer);
    this._testTimer = null;
    if (!this.destroyed && this.testSpeakerBtn) this.testSpeakerBtn.disabled = false;
  }
```

- [ ] **Step 6: Release the element on teardown**

Replace the `destroy()` method:

```js
  destroy() {
    this.destroyed = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    clearTimeout(this._emailTimer);
    clearTimeout(this._testTimer);
    if (this._testAudio) {
      this._testAudio.pause();
      this._testAudio.removeAttribute("src"); // drop the decoded buffer
      this._testAudio = null;
    }
    if (this.video) this.video.srcObject = null;
    if (this.backgroundPicker) this.backgroundPicker.destroy();
    this.root.replaceChildren();
  }
```

- [ ] **Step 7: Add the manual-test entry**

In `MANUAL-TEST.md`, immediately after the **No Speaker field where output switching is unsupported** item added in Task 2 Step 6, insert:

```markdown
- [ ] **Test plays through the selected speaker** — press Test beside the lobby's
      Speaker dropdown: a short blip plays on the selected device and the button is
      briefly disabled. Switch to a headset and press Test again — the blip comes
      from the headset, not the previous device. With no outputs at all the dropdown
      reads "No speaker found" and Test is disabled. Leaving the lobby mid-blip
      (Join, or back to the home screen) must not throw.
```

- [ ] **Step 8: Verify — syntax + suite**

Run from the repo root:

```
node --check internal/web/assets/ui/prejoin.js
node --test internal/web/test/*.test.js
```

Expected: `--check` silent (no output, exit 0); suite green.

- [ ] **Step 9: Confirm the sound file is actually served**

The path in `TEST_SOUND` must match a real asset — a 404 would surface only as a
failed play at runtime:

```
ls internal/web/assets/sounds_bloop.mp3
grep -n "sounds_bloop" internal/web/assets/lib/sounds.js
```

Expected: the file exists, and `sounds.js` maps `bloop` to the same `/sounds_bloop.mp3`
path (assets are served from the root of the asset dir).

- [ ] **Step 10: Manual check (note pending for the controller)**

- **Desktop Chrome/Firefox:** the lobby's Speaker row shows a Test button; pressing it blips through the selected device; switching device and pressing again blips through the new one.
- **No-output machine:** the dropdown reads "No speaker found" and Test is disabled.
- **Leaving mid-blip:** Join while the blip is playing — no console error, and the button's re-arm timer touches nothing.

(No browser needed from the implementer — note pending.)

- [ ] **Step 11: Commit**

```bash
git add internal/web/assets/ui/prejoin.js MANUAL-TEST.md
git commit -m "feat(web): test the lobby speaker before you join on it"
```

---

## Self-Review

**Spec coverage:**
- Shared filler replacing the three copies (user ruling, overrides the spec's duplicate-to-match note) → Task 1 Steps 1-3.
- Third field in the `.devices` grid, spanning both columns → Task 2 Steps 1, 2, 5.
- Gated on `setSinkId` support, field and button both absent when false → Task 2 Step 1 (`_outputSupported`, null field), Task 3 Step 3 (null button); manual entry Task 2 Step 6.
- Populated from the already-returned `devices.speakers`, `Speaker N` fallback labels, `No speaker found` + disabled → Task 1 Step 1 (helper) + Task 2 Step 3; Test disabled with it → Task 3 Step 4.
- Persisted choice marked selected (no active track to read a sink from) → Task 2 Step 3.
- `saveMediaPrefs({ speakerId })` + `[audio output]` log; no new wiring into the call → Task 2 Step 4.
- Private `Audio`, not `lib/sounds.js` → Task 3 Steps 1, 3, 5.
- Test reads `select.value`, not an internal id → Task 3 Step 5.
- Button sibling of the `<label>`, not inside it → Task 3 Step 3.
- `currentTime` reset outside the reporting `try` → Task 3 Step 5.
- Awaited `setSinkId` before `play()` justified → Task 3 Step 5 comment.
- Button disabled for the clip; `ended` plus a timeout fallback → Task 3 Steps 3, 5.
- `setSinkId` rejection reported in `errorLabel` → Task 3 Step 5.
- Teardown pauses and releases the element → Task 3 Step 6.
- No `prefs.js` change → asserted in Global Constraints; no task touches it.
- Testing: `node --check` + suite + `MANUAL-TEST.md` entries → Task 1 Step 4; Task 2 Steps 6, 7; Task 3 Steps 7, 8, 10.

**Placeholder scan:** No TBD/TODO. Every code step carries complete code and an exact anchor (file + line range for Task 1, named method for Tasks 2-3 where Task 1 shifts the numbers); every verify step names its command and expected output.

**Type consistency:** `fillDeviceSelect(select, list, activeId, label)` and `trackDeviceId(track)` are defined in Task 1 Step 1 and called with exactly those arities in Task 1 Steps 2-3, Task 2 Step 3, and Task 3 Step 4. `_outputSupported`, `speakerSelect`, `speakerField`, `testSpeakerBtn`, `_switchSpeaker`, `_testSpeaker`, `_endSpeakerTest`, `_testAudio`, `_testTimer` are spelled identically at every definition and use. The `speakerId` pref key matches `prefs.js:5` and the `controls.js` reader. `TEST_SOUND`/`TEST_TIMEOUT_MS` are defined in Task 3 Step 1 and used only in Step 5. The `.speaker-field` class in the CSS (Task 2 Step 5) matches the class on the element (Task 2 Step 1 / Task 3 Step 3).

**Task-boundary check:** Task 1 is behaviour-preserving and shippable alone. Task 2 leaves a working picker with no Test button — the in-call control, moved earlier. Task 3 only adds. Task 3 Step 4's edit into Task 2's speaker branch is the sole edit-back, and it is quoted in full rather than described.
