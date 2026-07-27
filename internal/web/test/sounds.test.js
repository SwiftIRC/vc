import { test } from "node:test";
import assert from "node:assert/strict";
import { primeAudio } from "../assets/lib/sounds.js";

// A stand-in for an <audio> element whose play() promise settles only when the test
// says so — the way a real one settles only once playback has actually begun. That
// gap is where a prime can leak sound, so the tests assert what happens BEFORE it.
function fakeAudio({ rejectPlay = false, throwPlay = false } = {}) {
  const calls = [];
  let settle = null;
  const el = {
    paused: true,
    muted: false,
    currentTime: 12.5, // mid-file, so a reset is visible
    play() {
      calls.push("play");
      if (throwPlay) throw new Error("blocked");
      el.paused = false;
      return new Promise((resolve, reject) => {
        settle = () => (rejectPlay ? reject(new Error("AbortError")) : resolve());
      });
    },
    pause() {
      calls.push("pause");
      el.paused = true;
    },
  };
  // Settle the play() promise and let the .then/.catch handlers run.
  const settlePlay = async () => {
    if (settle) settle();
    await Promise.resolve();
    await Promise.resolve();
  };
  return { el, calls, settlePlay };
}

test("prime pauses in the same turn as play, so no audio can render", () => {
  const { el, calls } = fakeAudio();
  primeAudio(el);
  // Synchronously after the call — before the play() promise has settled.
  assert.deepEqual(calls, ["play", "pause"]);
  assert.equal(el.paused, true);
  assert.equal(el.muted, true, "stays muted until play() settles");
});

test("prime restores the element once play() settles", async () => {
  const { el, settlePlay } = fakeAudio();
  primeAudio(el);
  await settlePlay();
  assert.equal(el.paused, true);
  assert.equal(el.muted, false);
  assert.equal(el.currentTime, 0);
});

test("a rejected play (the AbortError our own pause causes) still restores", async () => {
  const { el, settlePlay } = fakeAudio({ rejectPlay: true });
  primeAudio(el);
  await settlePlay();
  assert.equal(el.paused, true);
  assert.equal(el.muted, false);
  assert.equal(el.currentTime, 0);
});

test("a synchronous play() throw leaves nothing muted", () => {
  const { el, calls } = fakeAudio({ throwPlay: true });
  primeAudio(el);
  assert.deepEqual(calls, ["play"]);
  assert.equal(el.muted, false);
});

test("an already-playing element is left alone", () => {
  const { el, calls } = fakeAudio();
  el.paused = false; // a chime or the countdown is mid-play for a real reason
  el.currentTime = 3;
  primeAudio(el);
  assert.deepEqual(calls, []);
  assert.equal(el.currentTime, 3);
  assert.equal(el.muted, false);
});

test("a missing element is a no-op", () => {
  assert.doesNotThrow(() => primeAudio(null));
  assert.doesNotThrow(() => primeAudio(undefined));
});
