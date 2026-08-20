# Lobby Speaker Picker — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Speaker picker to the pre-join lobby with the same options as the in-call one, plus a Test button that plays a blip through the selected output so the choice is verifiable before joining.

**Architecture:** A third field in the lobby's existing `.devices` grid, gated on `setSinkId` support exactly as the in-call control is. It writes the existing `speakerId` media pref — which `Controls` already reads in its constructor and applies in `attachGrid` — so the choice reaches the call with **no new wiring**. The Test button drives a private `<audio>` owned by `Prejoin`, deliberately not `lib/sounds.js`, whose elements are shared with the in-call chimes.

**Tech Stack:** Vanilla ES modules; the existing `.devices` / `.field` CSS plus one new `.speaker-field` rule; `node --check` + `node --test internal/web/test/*.test.js`.

**Spec:** `docs/superpowers/specs/2026-08-20-lobby-speaker-picker-design.md`

## Global Constraints

- **Client-only.** No protocol/server/media-plane change. `media.enumerate()` already returns `speakers` — the lobby simply stops discarding it.
- **Feature-detected.** Everything speaker-related is gated on `typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype` — the same test as `controls.js:292`. Where it is false (iOS Safari) the field and the button are **both absent**; `el()` skips `null` children (`prejoin.js:64`), so no call site needs a branch.
- **No new pref key.** `speakerId` already exists and is already documented in `prefs.js:5`. Do not add one, and do not change `prefs.js`.
- **Do not touch `lib/sounds.js`.** It caches one shared `<audio>` per sound for the in-call chimes; calling `setSinkId` on a cached element would re-route the in-call join/drop chimes as a side effect of a lobby click.
- **No DOM test harness exists.** `internal/web/test/` is `node:test` over the pure-logic `lib/` modules. Do **not** add jsdom or a new harness. Verification is `node --check`, the existing suite staying green, and new `MANUAL-TEST.md` entries — the same shape the in-call picker's plan used (`docs/superpowers/plans/2026-07-26-audio-output-picker.md`).
- Run the suite as a **glob**: `node --test internal/web/test/*.test.js` (a bare-dir arg fails under this sandbox's Node 22).
- No `Co-Authored-By` trailer on any commit.

---

## File Structure

- `internal/web/assets/ui/prejoin.js` — the gated Speaker select, `_fillSpeakerSelect`, `_switchSpeaker` *(Task 1)*; the Test button, `_testSpeaker`/`_endSpeakerTest`, teardown *(Task 2)*.
- `internal/web/assets/style.css` — one `.speaker-field` rule for the full-width row *(Task 1)*.
- `MANUAL-TEST.md` — new **Pre-join screen** entries: the picker, persistence, carry-into-call, iOS absence *(Task 1)*; the Test button *(Task 2)*.

Dependency order: Task 1 (the picker — independently shippable and useful on its own) → Task 2 (the Test button layered onto it).

---

### Task 1: Speaker select in the lobby

The picker itself: a gated third device field that lists audio outputs, marks the persisted choice, and saves it so the call picks it up. Independently shippable — without the Test button it is exactly the in-call control, moved earlier.

**Files:**
- Modify: `internal/web/assets/ui/prejoin.js` (`_build` 210-211 and 271-274; `_populateDevices` 324-334; new `_fillSpeakerSelect` after `_fillSelect` 336-350; new `_switchSpeaker` after `_switchMic` 367-376)
- Modify: `internal/web/assets/style.css:137` (after the `.devices select` block)
- Modify: `MANUAL-TEST.md:36` (after the **Device pickers** item)

**Interfaces:**
- Consumes: `media.enumerate()` → `{ cameras, mics, speakers }` (existing, `net/media.js:227`); `loadMediaPrefs`/`saveMediaPrefs` (already imported at `prejoin.js:12`).
- Produces: `this._outputSupported` (boolean), `this.speakerSelect` (`HTMLSelectElement | null`), `this.speakerField` (`HTMLDivElement | null`), and `_fillSpeakerSelect(list)` — all consumed by Task 2.

- [ ] **Step 1: Build the gated Speaker select**

In `_build()`, replace the two device-select lines (210-211):

```js
    this.cameraSelect = el("select", { class: "device", onChange: () => this._switchCamera() });
    this.micSelect = el("select", { class: "device", onChange: () => this._switchMic() });
```

with:

```js
    this.cameraSelect = el("select", { class: "device", onChange: () => this._switchCamera() });
    this.micSelect = el("select", { class: "device", onChange: () => this._switchMic() });

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

Still in `_build()`, replace the `.devices` block (271-274):

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

Replace `_populateDevices` (324-334):

```js
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
    if (this.speakerSelect) this._fillSpeakerSelect(devices.speakers || []);
  }
```

- [ ] **Step 4: Add `_fillSpeakerSelect`**

Immediately after `_fillSelect` (ends at line 350), add:

```js
  // Like _fillSelect, but for audio OUTPUTS: there is no active track to read the
  // current sink from, so the PERSISTED choice is what gets marked. Mirrors
  // _fillOutputSelect in ui/controls.js, which the in-call Speaker list uses.
  _fillSpeakerSelect(list) {
    const savedId = loadMediaPrefs().speakerId || "";
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
      if (d.deviceId && d.deviceId === savedId) opt.selected = true;
      select.append(opt);
    });
  }
```

- [ ] **Step 5: Add `_switchSpeaker`**

Immediately after `_switchMic` (ends at line 376), add:

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

- [ ] **Step 6: Add the row's CSS**

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

- [ ] **Step 7: Add the manual-test entries**

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

- [ ] **Step 8: Verify — syntax + suite**

Run from the repo root:

```
node --check internal/web/assets/ui/prejoin.js
node --test internal/web/test/*.test.js
```

Expected: `--check` silent (no output, exit 0); suite green. Device enumeration and sink routing are DOM/device-dependent — they are covered by the Step 7 manual entries, not by this suite.

- [ ] **Step 9: Commit**

```bash
git add internal/web/assets/ui/prejoin.js internal/web/assets/style.css MANUAL-TEST.md
git commit -m "feat(web): pick your speaker in the lobby, not just in the call"
```

---

### Task 2: Test button

Makes the lobby choice verifiable. In-call, selecting a speaker reroutes live audio and confirms itself; in the lobby nothing is playing, so a blip on demand is the only confirmation available.

**Files:**
- Modify: `internal/web/assets/ui/prejoin.js` (module constants after `POLL_INTERVAL_MS:18`; constructor after `this.pollTimer = null;`:101; `_build` speaker block from Task 1; `_fillSpeakerSelect` from Task 1; new `_testSpeaker`/`_endSpeakerTest`; `destroy` 504-514)
- Modify: `MANUAL-TEST.md` (after the **No Speaker field where output switching is unsupported** item added in Task 1)

**Interfaces:**
- Consumes: `this._outputSupported`, `this.speakerSelect`, `this.speakerField`, `_fillSpeakerSelect(list)` (all Task 1); `this.errorLabel` (existing, `prejoin.js:248`); `this.destroyed` (existing).
- Produces: `this.testSpeakerBtn` (`HTMLButtonElement | null`), `_testSpeaker()`, `_endSpeakerTest()`.

- [ ] **Step 1: Add the module constants**

In `internal/web/assets/ui/prejoin.js`, immediately after `const POLL_INTERVAL_MS = 3000;` (line 18), add:

```js
const TEST_SOUND = "/sounds_bloop.mp3"; // short, neutral blip for the speaker test
const TEST_TIMEOUT_MS = 3000; // re-arm the Test button even if "ended" never fires
```

- [ ] **Step 2: Declare the instance state**

In the constructor, immediately after `this.pollTimer = null;` (line 101), add:

```js
    this._testAudio = null; // lazily created <audio> for the speaker test
    this._testTimer = null; // re-arms the Test button if "ended" never fires
```

- [ ] **Step 3: Build the Test button into the speaker field**

In `_build()`, replace the `speakerField` assignment added in Task 1 Step 1:

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

In `_fillSpeakerSelect` (added in Task 1 Step 4), add the two `testSpeakerBtn` lines so the button tracks the select's own enabled state:

```js
    if (list.length === 0) {
      select.append(el("option", { value: "", text: "No speaker found" }));
      select.disabled = true;
      this.testSpeakerBtn.disabled = true; // nothing to play through
      return;
    }
    select.disabled = false;
    this.testSpeakerBtn.disabled = false;
```

- [ ] **Step 5: Add `_testSpeaker` and `_endSpeakerTest`**

Immediately after `_switchSpeaker` (added in Task 1 Step 5), add:

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

Replace `destroy()` (504-514):

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

In `MANUAL-TEST.md`, immediately after the **No Speaker field where output switching is unsupported** item added in Task 1 Step 7, insert:

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
- Third field in the `.devices` grid, spanning both columns → Task 1 Steps 1, 2, 6.
- Gated on `setSinkId` support, field and button both absent when false → Task 1 Step 1 (`_outputSupported`, null field), Task 2 Step 3 (null button); manual entry Task 1 Step 7.
- Populated from the already-returned `devices.speakers`, `Speaker N` fallback labels, `No speaker found` + disabled → Task 1 Steps 3, 4; Test disabled with it → Task 2 Step 4.
- Persisted choice marked selected (no active track to read a sink from) → Task 1 Step 4.
- `saveMediaPrefs({ speakerId })` + `[audio output]` log; no new wiring into the call → Task 1 Step 5.
- Private `Audio`, not `lib/sounds.js` → Task 2 Steps 1, 3, 5.
- Test reads `select.value`, not an internal id → Task 2 Step 5.
- Button sibling of the `<label>`, not inside it → Task 2 Step 3.
- `currentTime` reset outside the reporting `try` → Task 2 Step 5.
- Awaited `setSinkId` before `play()` justified → Task 2 Step 5 comment.
- Button disabled for the clip; `ended` plus a timeout fallback → Task 2 Steps 3, 5.
- `setSinkId` rejection reported in `errorLabel` → Task 2 Step 5.
- Teardown pauses and releases the element → Task 2 Step 6.
- No `prefs.js` change → asserted in Global Constraints; no task touches it.
- Testing: `node --check` + suite + `MANUAL-TEST.md` entries → Task 1 Steps 7, 8; Task 2 Steps 7, 8, 10.

**Placeholder scan:** No TBD/TODO. Every code step carries complete code and an exact anchor (file + line range or named neighbour method); every verify step names its command and expected output.

**Type consistency:** `_outputSupported`, `speakerSelect`, `speakerField`, `testSpeakerBtn`, `_fillSpeakerSelect`, `_switchSpeaker`, `_testSpeaker`, `_endSpeakerTest`, `_testAudio`, `_testTimer` are spelled identically at every definition and use across both tasks. `_fillSpeakerSelect(list)` takes the `devices.speakers` array in Task 1 Step 3 and is defined with that one parameter in Step 4; Task 2 Step 4 edits its body without changing the signature. The `speakerId` pref key matches `prefs.js:5` and the `controls.js` reader. `TEST_SOUND`/`TEST_TIMEOUT_MS` are defined in Task 2 Step 1 and used only in Step 5. The `.speaker-field` class in the CSS (Task 1 Step 6) matches the class on the element (Task 1 Step 1 / Task 2 Step 3).

**Task-boundary check:** Task 1 leaves the tree working and shippable on its own — a Speaker picker with no Test button, which is precisely the in-call control moved earlier. Task 2 only adds. The two `testSpeakerBtn.disabled` lines in Task 2 Step 4 are the sole edit-back into Task 1's code, and they are quoted in full rather than described.
