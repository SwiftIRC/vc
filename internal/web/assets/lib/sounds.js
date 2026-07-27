// Short UI sound effects for room events: someone joins ("join"), disconnects
// ("drop"), or starts a share ("bloop"). Each file is loaded into a single reused
// <audio> the first time it plays, so repeat plays don't refetch it.
//
// play() is best-effort: these are triggered by network events (a peer joining), not
// a user gesture, so a browser's autoplay policy may reject them. In practice the user
// clicked "Join" and live WebRTC audio is already playing, so the page is unlocked —
// but we still swallow the rejection, because a missed blip is harmless.
const FILES = {
  join: "/door_open.mp3", // a peer joined
  drop: "/sounds_drop.mp3", // a peer disconnected
  bloop: "/sounds_bloop.mp3", // a peer started a share
};

const cache = {};

export function playSound(name) {
  const src = FILES[name];
  if (!src) return;
  let audio = cache[name];
  if (!audio) {
    audio = new Audio(src);
    cache[name] = audio;
  }
  try {
    audio.currentTime = 0; // restart if it's still playing from a rapid prior event
  } catch {
    /* not seekable yet — play() below still starts it */
  }
  const p = audio.play();
  if (p && typeof p.catch === "function") p.catch(() => {});
}

// Unlock an <audio> element for later programmatic play on iOS Safari, which blocks
// play() outside a user gesture until the element has been played once within one.
// MUST be called from a real user-gesture handler. Silent on every platform.
// Best-effort; swallows rejection.
//
// The unlock is granted when play() is CALLED inside the gesture, so we pause in the
// SAME turn and never let playback begin. Waiting for the play() promise would not do:
// it only settles once audio is already rendering, which leaves silence resting purely
// on `muted` — and WebKit ignores a `muted` set on a `new Audio(src)` that hasn't
// loaded yet, so the chime and the countdown leaked out on the user's first click.
export function primeAudio(el) {
  // Skip a null element, and one that's ALREADY playing: a playing element is already
  // unlocked, and priming it would mute/pause/rewind a chime or countdown that's mid-play
  // for a real reason (e.g. the user's first gesture landing during the countdown).
  if (!el || !el.paused) return;
  el.muted = true; // belt and braces for a browser that starts faster than we can pause
  const restore = () => {
    try {
      el.currentTime = 0;
    } catch {
      /* not seekable — harmless */
    }
    el.muted = false;
  };
  let p;
  try {
    p = el.play();
  } catch {
    restore(); // the rare synchronous throw — leave nothing muted
    return;
  }
  el.pause();
  // play() now rejects with AbortError (or resolves, if a browser beat us to it); either
  // way the element is paused. Unmute only once it settles — doing it sooner could
  // uncover a play that hasn't observed the pause yet.
  if (p && typeof p.then === "function") p.then(restore, restore);
  else restore();
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
