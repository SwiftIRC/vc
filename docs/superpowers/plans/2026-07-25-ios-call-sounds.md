# iOS Call Sounds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the rocket countdown and the join/drop/share chimes audible on iPhones.

**Architecture:** (A) Transcode the `.ogg` chimes to `.mp3` (iOS can't decode Ogg Vorbis). (B) Unlock every sound `<audio>` element on the first in-call user gesture so iOS Safari's autoplay policy lets the later network-triggered `play()`s through.

**Tech Stack:** ffmpeg (asset transcode); vanilla ES modules (client); Go `//go:embed all:assets`.

## Global Constraints

- MP3 for the chimes (universally supported); `RocketCountdown.mp3` is already MP3.
- The gesture-unlock prime is **silent** (muted play → pause → reset) and must be invoked from within a real user-gesture handler (`touchstart`/`mousedown`/`keydown`, NOT `mousemove`). One-time per call, cleaned up on `destroy()`.
- No protocol/server change; the `countdown` broadcast and `playSound` call sites are unchanged.
- `go test ./internal/web/...`, `node --check`, and `node --test internal/web/test/*.test.js` (glob; bare-dir arg fails in this sandbox's Node 22) must pass. Commit messages must NOT include any `Co-Authored-By` trailer.
- The real verification (iOS playback) is manual/on-device — note it pending; do not claim it verified.

---

### Task 1: Transcode the chimes to MP3

**Files:**
- Add (binary): `internal/web/assets/door_open.mp3`, `sounds_drop.mp3`, `sounds_bloop.mp3`
- Remove: `internal/web/assets/door_open.ogg`, `sounds_drop.ogg`, `sounds_bloop.ogg`
- Modify: `internal/web/assets/lib/sounds.js` (`FILES`)

- [ ] **Step 1: Transcode with ffmpeg**

```bash
cd internal/web/assets
ffmpeg -y -loglevel error -i door_open.ogg   -codec:a libmp3lame -q:a 4 door_open.mp3
ffmpeg -y -loglevel error -i sounds_drop.ogg  -codec:a libmp3lame -q:a 4 sounds_drop.mp3
ffmpeg -y -loglevel error -i sounds_bloop.ogg -codec:a libmp3lame -q:a 4 sounds_bloop.mp3
cd -
```
Verify the three `.mp3` exist and are non-empty: `ls -l internal/web/assets/*.mp3` (there should be four including `RocketCountdown.mp3`).

- [ ] **Step 2: Repoint `sounds.js` `FILES` to the MP3s**

In `internal/web/assets/lib/sounds.js`, change the `FILES` map:

```js
const FILES = {
  join: "/door_open.ogg", // a peer joined
  drop: "/sounds_drop.ogg", // a peer disconnected
  bloop: "/sounds_bloop.ogg", // a peer started a share
};
```

to:

```js
const FILES = {
  join: "/door_open.mp3", // a peer joined
  drop: "/sounds_drop.mp3", // a peer disconnected
  bloop: "/sounds_bloop.mp3", // a peer started a share
};
```

- [ ] **Step 3: Remove the `.ogg` files (git)**

```bash
git rm internal/web/assets/door_open.ogg internal/web/assets/sounds_drop.ogg internal/web/assets/sounds_bloop.ogg
```

- [ ] **Step 4: Verify — embed test, syntax, suite**

Run:
```
go test ./internal/web/... && node --check internal/web/assets/lib/sounds.js && node --test internal/web/test/*.test.js
```
Expected: Go embed test PASS (the new `.mp3`s embed via `all:assets`; no test references the removed `.ogg` names), `--check` silent, JS suite green.

- [ ] **Step 5: Commit**

```bash
git add internal/web/assets/door_open.mp3 internal/web/assets/sounds_drop.mp3 internal/web/assets/sounds_bloop.mp3 internal/web/assets/lib/sounds.js
git commit -m "fix(web): transcode call chimes to mp3 so iOS Safari can decode them"
```

---

### Task 2: Unlock sound elements on the first in-call gesture

**Files:**
- Modify: `internal/web/assets/lib/sounds.js` (add `primeAudio`, `unlockSounds`)
- Modify: `internal/web/assets/ui/controls.js` (import; one-time gesture-unlock in the constructor; `_removeAudioUnlock`; `destroy`; fix the stale comment)

**Interfaces:**
- Produces: `primeAudio(el)`, `unlockSounds()` from `lib/sounds.js`.

- [ ] **Step 1: Add `primeAudio` + `unlockSounds` to `sounds.js`**

Append to `internal/web/assets/lib/sounds.js`:

```js
// Unlock an <audio> element for later programmatic play on iOS Safari, which blocks
// play() outside a user gesture until the element has been played once within one.
// MUST be called from a real user-gesture handler. Silent: primes muted, then pauses
// and resets — no sound on any platform. Best-effort; swallows rejection.
export function primeAudio(el) {
  if (!el) return;
  el.muted = true;
  const done = () => {
    el.pause();
    try {
      el.currentTime = 0;
    } catch {
      /* not seekable — harmless */
    }
    el.muted = false;
  };
  const p = el.play();
  if (p && typeof p.then === "function") p.then(done).catch(() => { el.muted = false; });
  else done();
}

// Prime every chime element on a user gesture so iOS lets the later network-triggered
// plays through. Creates each element the way playSound does lazily, then primes it.
// Idempotent — safe to call more than once.
export function unlockSounds() {
  for (const name of Object.keys(FILES)) {
    let audio = cache[name];
    if (!audio) {
      audio = new Audio(FILES[name]);
      cache[name] = audio;
    }
    primeAudio(audio);
  }
}
```

- [ ] **Step 2: Import the helpers in `controls.js`**

Add near controls.js's other `../lib` imports (top of file):

```js
import { primeAudio, unlockSounds } from "../lib/sounds.js";
```

- [ ] **Step 3: One-time gesture-unlock in the constructor**

In the constructor, right after the autohide `_activityEvents` loop (~line 141), add:

```js
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
```

- [ ] **Step 4: Add `_removeAudioUnlock` and call it in `destroy()`**

Add the method (e.g. next to `_countdownSound`):

```js
  _removeAudioUnlock() {
    for (const ev of this._audioUnlockEvents) {
      window.removeEventListener(ev, this._onAudioUnlock);
    }
  }
```

In `destroy()` (~960), add (so the listeners never leak if the unlock never fired):

```js
    this._removeAudioUnlock();
```

- [ ] **Step 5: Fix the stale autoplay comment in `_playCountdown`**

Replace the comment above the `audio.play()` in `_playCountdown` (~746-749):

```js
    // Autoplay policy: for the STARTER this play() runs in the call stack of
    // their click (a user gesture), so it is allowed. For OTHERS it is triggered
    // by a network message and the browser may block it — that is acceptable and
    // best-effort. Swallow the rejection so it is not an unhandled promise.
```

with the accurate version:

```js
    // Best-effort: this runs from the `countdown` broadcast handler for EVERYONE —
    // including the starter, whose click only _send()s — so it is never a user
    // gesture. iOS therefore blocks it unless the element was unlocked on the first
    // in-call gesture (see the audio-unlock in the constructor); desktop permits it
    // once the page has been interacted with. Swallow the rejection either way.
```

- [ ] **Step 6: Verify — syntax + suite**

Run:
```
node --check internal/web/assets/lib/sounds.js && node --check internal/web/assets/ui/controls.js && node --test internal/web/test/*.test.js
```
Expected: `--check` silent on both; suite green.

- [ ] **Step 7: Manual check (note pending for the controller)**

Desktop: chimes and the countdown still play as before. **iPhone (the real verification, not run by the implementer):** after the first tap in the call, everyone hears the chimes and the countdown.

- [ ] **Step 8: Commit** (NO `Co-Authored-By` trailer)

```bash
git add internal/web/assets/lib/sounds.js internal/web/assets/ui/controls.js
git commit -m "fix(web): unlock call sounds on first in-call gesture for iOS Safari"
```

---

## Self-Review

**Spec coverage:**
- Chimes `.ogg`→`.mp3` transcode + `FILES` repoint + `.ogg` removal → Task 1.
- `primeAudio` (silent muted prime) + `unlockSounds` → Task 2 Step 1.
- One-time first-gesture unlock (touchstart/mousedown/keydown) priming countdown + chimes, with destroy cleanup → Task 2 Steps 3–4.
- Corrected stale comment → Task 2 Step 5.
- Tests: Go embed still passes; `node --check` + suite; iOS manual (pending) → both tasks.

**Placeholder scan:** No TBD/TODO; every step has complete code/commands and expected results.

**Type consistency:** `primeAudio(el)` / `unlockSounds()` signatures match between `sounds.js` and the `controls.js` import + call sites; `FILES` keys unchanged (`join`/`drop`/`bloop`), only the `.ogg`→`.mp3` values; `_audioUnlockEvents`/`_onAudioUnlock`/`_removeAudioUnlock` used consistently in the constructor, the method, and `destroy`.
