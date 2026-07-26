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
// MUST be called from a real user-gesture handler. Silent: primes muted, then pauses
// and resets — no sound on any platform. Best-effort; swallows rejection.
export function primeAudio(el) {
  // Skip a null element, and one that's ALREADY playing: a playing element is already
  // unlocked, and priming it would mute/pause/rewind a chime or countdown that's mid-play
  // for a real reason (e.g. the user's first gesture landing during the countdown).
  if (!el || !el.paused) return;
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
  let p;
  try {
    p = el.play();
  } catch {
    el.muted = false; // the rare synchronous throw — leave nothing muted
    return;
  }
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
