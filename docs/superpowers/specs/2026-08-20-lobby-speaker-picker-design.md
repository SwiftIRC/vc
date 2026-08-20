# Speaker selection in the lobby

## Problem

The lobby lets you pick a Camera and a Microphone before joining, but not a
Speaker — that control exists only in-call, inside the mic split-button's menu.
Someone whose audio output is wrong (a headset the OS didn't switch to, an HDMI
monitor holding the default sink) can only discover it after joining, and only
then fix it. Add a Speaker picker to the lobby with the same options as the
in-call one, plus a Test button so the choice is verifiable before joining —
in-call the selection reroutes live audio and confirms itself, but in the lobby
nothing is playing.

## Decisions

- **A third field in the existing `.devices` grid**, spanning both columns, with
  the Test button beside the select. Camera and Microphone keep their side-by-side
  row above it.
- **Gated on `"setSinkId" in HTMLMediaElement.prototype`** — the same test
  `controls.js:292` uses. Where output switching is unsupported (iOS Safari), the
  field and the button are both absent, exactly as the in-call Speaker select is.
- **Persisted via the existing `speakerId` media pref.** No new wiring is needed
  to make it take effect: `Controls` reads `loadMediaPrefs().speakerId` in its
  constructor (`controls.js:100`) and applies it in `attachGrid`
  (`controls.js:205`), and it is constructed on join accept (`app.js:337`) —
  after the lobby has written the pref. The lobby choice carries into the call the
  same way the mic/camera on-off prefs already do.
- **The Test sound uses a private `Audio` element**, not `lib/sounds.js`. That
  module caches one shared `<audio>` per sound for the in-call chimes; calling
  `setSinkId` on a cached element would silently re-route the in-call join/drop
  chimes as a side effect of a lobby click. A private element keeps the change
  contained.
- **Test plays through `select.value`, not an internal `_speakerId` field.** With
  no saved preference nothing is marked selected and the browser shows the first
  option, so reading the select tests exactly what is on screen; reading an
  internal `""` (browser default) could play through a different device than the
  one displayed.

## Change — `internal/web/assets/ui/prejoin.js`

**Module-level constants**, beside `POLL_INTERVAL_MS`:

```js
const TEST_SOUND = "/sounds_bloop.mp3"; // short, neutral blip for the speaker test
const TEST_TIMEOUT_MS = 3000; // re-arm the Test button even if "ended" never fires
```

**Constructor** — initialise the two new fields beside the existing `this.pollTimer
= null`, so every piece of instance state is declared in one place as the rest of
the class does:

```js
this._testAudio = null; // lazily created <audio> for the speaker test
this._testTimer = null; // re-arms the Test button if "ended" never fires
```

**`_build()`** — after the existing `micSelect`, build the gated speaker controls:

```js
// Output-device selection, only where the browser can actually switch sinks
// (Chrome/Edge/Firefox; NOT iOS) — same gate as the in-call control.
this._outputSupported = typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
this.speakerSelect = this._outputSupported
  ? el("select", { class: "device", onChange: () => this._switchSpeaker() })
  : null;
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

The Test button is a **sibling** of the `<label>`, not inside it: a click on a
label activates its associated control, so a button nested in one would also open
the select.

In the `.devices` block, append `this.speakerField` after the Camera and
Microphone fields. `el()` already skips `null` children, so the unsupported case
needs no branch at the call site.

**`_populateDevices()`** — `media.enumerate()` already returns `speakers`; the
lobby currently discards it. Add:

```js
if (this.speakerSelect) this._fillSpeakerSelect(devices.speakers || []);
```

**`_fillSpeakerSelect(list)`** — like `_fillSelect`, but there is no active track
to read the current sink from, so the persisted choice is what gets marked. This
mirrors `_fillOutputSelect` in `controls.js:718`; the two stay parallel the way
`_fillSelect` and `_fillDeviceSelect` already do.

```js
_fillSpeakerSelect(list) {
  const savedId = loadMediaPrefs().speakerId || "";
  const select = this.speakerSelect;
  select.replaceChildren();
  if (list.length === 0) {
    select.append(el("option", { value: "", text: "No speaker found" }));
    select.disabled = true;
    this.testSpeakerBtn.disabled = true; // nothing to play through
    return;
  }
  select.disabled = false;
  this.testSpeakerBtn.disabled = false;
  list.forEach((d, i) => {
    const opt = el("option", { value: d.deviceId, text: d.label || `Speaker ${i + 1}` });
    if (d.deviceId && d.deviceId === savedId) opt.selected = true;
    select.append(opt);
  });
}
```

**`_switchSpeaker()`** — persist and log. There is no grid in the lobby, so
nothing to reroute; the log line matches `grid.js:518` and the `[audio capture]` /
`[audio switch]` habit the manual-test doc leans on when chasing echo.

```js
_switchSpeaker() {
  const id = this.speakerSelect.value;
  saveMediaPrefs({ speakerId: id }); // picked up by Controls on join
  console.info(`[audio output] sink=${id || "(browser default)"}`);
}
```

**`_testSpeaker()`** — route a blip through the displayed device.

```js
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
    /* not seekable yet — play() below still starts it */
  }
  try {
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

_endSpeakerTest() {
  clearTimeout(this._testTimer);
  this._testTimer = null;
  if (!this.destroyed && this.testSpeakerBtn) this.testSpeakerBtn.disabled = false;
}
```

`currentTime` is reset outside the reporting `try` deliberately: it throws on a
not-yet-seekable element, and that is harmless — letting it land in the catch
would report a playback failure that didn't happen.

The `await` before `play()` is safe here. Autoplay policy keys off *sticky*
activation, not transient, and by the time this button exists the user has already
granted microphone/camera permission — which unblocks autoplay on its own in both
Chrome and Firefox. This is the one chime in the app that is gesture-driven rather
than network-triggered, so it needs none of `lib/sounds.js`'s iOS priming.

**`destroy()`** — release the element alongside the existing teardown:

```js
clearTimeout(this._testTimer);
if (this._testAudio) {
  this._testAudio.pause();
  this._testAudio.removeAttribute("src");
  this._testAudio = null;
}
```

## Change — `internal/web/assets/style.css`

Beside the existing `.devices` rules:

```css
/* The Speaker row spans the Camera/Microphone columns and carries its Test button
   beside the select. flex-end aligns the button to the select's baseline, under
   the field's label span. */
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

The existing `.devices .field { min-width: 0 }` and `.devices select { width: 100% }`
still match the nested field (both are descendant selectors), so a long device name
cannot force the row wider. The button inherits the global `input, select, button`
styling — no new rule needed. The 30rem breakpoint already collapses `.devices` to a
single column; the speaker row stays intact inside it.

## Prefs

`speakerId` already exists and is already documented in `prefs.js`. No change to
`prefs.js` — its merge is generic, and the in-call control writes the same key.

## Edge cases

- **No outputs enumerated** → `No speaker found`, both the select and Test disabled,
  matching the in-call empty-list behaviour and the lobby's own camera/mic handling.
- **`setSinkId` rejects** (permission, or a device that vanished between enumeration
  and the click) → the reason lands in the existing `errorLabel` and the button
  re-arms, rather than a click that silently does nothing.
- **Device unplugged after mount** → the list is populated once at mount, like the
  Camera and Microphone selects. Same limitation, same behaviour; the in-call menu
  repopulates per open because it is a popover.
- **Test clicked repeatedly** → the button is disabled for the clip's duration, and
  `currentTime = 0` restarts a still-playing element on the next click.
- **Leaving the lobby mid-test** → `destroy()` pauses and releases the element, and
  `_endSpeakerTest` is guarded on `this.destroyed`, so no timer touches a dead button.
- **No saved preference** → nothing is marked selected and the browser shows the
  first option; Test reads the select, so it plays through what is displayed.

## Testing

DOM/UI with no pure logic to unit-test — `internal/web/test/` is `node:test` over the
`lib/` modules and the repo has no DOM harness. Verification:

- `node --check internal/web/assets/ui/prejoin.js`.
- The existing `node --test internal/web/test/*.test.js` suite stays green.
- New `MANUAL-TEST.md` entries under **Pre-join screen**, beside the existing
  **Device pickers** item:
  - The Speaker dropdown lists your outputs, and Test plays a blip through the
    selected one — switching to a headset and pressing Test again plays from the
    headset, not the previous device.
  - A speaker chosen in the lobby is the one carrying remote audio after Join,
    with no further selection in-call, and the in-call Speaker select shows it.
  - The choice survives a reload of the lobby.
  - On iOS Safari there is no Speaker field and no Test button (output switching
    is unsupported), while Camera and Microphone still work.

## Out of scope

- **In-call chimes keep using the default sink.** `lib/sounds.js` never calls
  `setSinkId`, so the join/drop/bloop chimes play through the browser default even
  when a speaker is chosen. That is pre-existing, affects the in-call control
  equally, and is deliberately untouched here.
- No protocol/server/media change; `media.enumerate()` already returns `speakers`.
- No live re-enumeration on `devicechange` in the lobby — the Camera and Microphone
  pickers don't do it either, and adding it is a separate change across all three.
