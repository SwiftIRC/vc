# Make call sounds play on iOS (countdown + chimes)

## Problem

iPhones don't hear the rocket countdown, and (same area) don't hear the join/drop/
share chimes either. Two independent iOS-Safari issues:

1. **Autoplay gesture policy.** The countdown (`controls.js` `_playCountdown`) and the
   chimes (`lib/sounds.js` `playSound`) are all `HTMLAudioElement.play()` calls made
   from a network-event handler (a `countdown` broadcast; a peer join/drop), never
   from within a user gesture — not even for the person who started the countdown
   (their click only `_send`s; everyone plays from the broadcast). iOS blocks
   `play()` outside a gesture until the specific element has been unlocked by a
   gesture-initiated play; "live WebRTC audio is playing" does not unlock an arbitrary
   `<audio>` on iOS. So iPhones silently reject all of these.
2. **Ogg Vorbis is undecodable on iOS.** The chimes are `.ogg` files, a format iOS
   Safari cannot decode at all — so even with the gesture fix they wouldn't play.

## Decisions

- **Transcode the chimes to MP3** (universally supported). Replace the three `.ogg`
  files with `.mp3` and repoint `sounds.js`.
- **Unlock every sound element on the first in-call user gesture.** Prime each
  `<audio>` (chimes + countdown) with a silent muted play/pause inside a real gesture,
  one-time, so the later network-triggered `play()` is allowed on iOS.
- **Muted (silent) prime**, harmless on desktop; if a target iOS version needs it, an
  unmuted sync `play()`/`pause()` prime is the documented fallback (implement muted
  first, verify on-device).

## Part A — chimes to MP3

- Transcode with ffmpeg (`-codec:a libmp3lame -q:a 4`):
  - `internal/web/assets/door_open.ogg` → `door_open.mp3`
  - `internal/web/assets/sounds_drop.ogg` → `sounds_drop.mp3`
  - `internal/web/assets/sounds_bloop.ogg` → `sounds_bloop.mp3`
- `git rm` the three `.ogg` files; add the three `.mp3` (auto-embedded via `//go:embed
  all:assets`; `RocketCountdown.mp3` is unchanged).
- `internal/web/assets/lib/sounds.js`: repoint `FILES` to the `.mp3` paths and drop
  the "these are .ogg" wording.

## Part B — iOS gesture-unlock

### `internal/web/assets/lib/sounds.js`
- Add `primeAudio(el)`: within a user gesture, silently unlock an `<audio>` element —
  `el.muted = true`, `el.play()` then on resolve `el.pause(); el.currentTime = 0;
  el.muted = false;`, swallowing rejection (and restoring `muted=false` on failure).
  Exported so the countdown can reuse it.
- Add `unlockSounds()`: ensure each `FILES` entry's cached `<audio>` exists (create if
  needed, as `playSound` does lazily) and `primeAudio()` each. Idempotent — safe to
  call more than once.

### `internal/web/assets/ui/controls.js`
- Register a **one-time** first-gesture unlock: a listener for `touchstart` /
  `mousedown` / `keydown` (real activation events; NOT `mousemove`) that runs once,
  primes the countdown element (`primeAudio(this._countdownSound())`) and calls
  `unlockSounds()`, then removes itself. Guard with a `this._audioUnlocked` flag.
- Wire the removal into `destroy()` too (remove the listeners if the unlock never
  fired), so nothing leaks across a leave/rejoin.
- Import `primeAudio, unlockSounds` from `../lib/sounds.js`.

## Testing

- Go: `go test ./internal/web/...` still passes — the embed test references no audio
  filenames, and the new `.mp3`s embed automatically; the removed `.ogg`s are
  referenced nowhere but the old `sounds.js`.
- JS: `node --check` on `sounds.js` and `controls.js`; the existing
  `node --test internal/web/test/*.test.js` suite stays green (no pure logic added).
- Manual (the real verification):
  - **Desktop** — join/drop/share chimes and the countdown still play as before.
  - **iPhone** — after the first tap in the call, the chimes and the countdown are
    audible for everyone (this is what can only be confirmed on-device; the muted
    prime is the standard pattern, with the unmuted-prime fallback noted above).

## Out of scope / notes

- No protocol/server change; the `countdown` broadcast and `playSound` call sites are
  unchanged — only the audio format and a gesture-time unlock are added.
- The inaccurate `controls.js` comment (~746) claiming the starter's `play()` runs in
  their click's call stack should be corrected while touching that area.
