// The audio constraints for a microphone capture, in one place so the acquisition
// sites cannot drift apart.
//
// echoCancellation and autoGainControl are PINNED rather than inherited. Every
// current browser defaults both on for getUserMedia, so this changes nothing today
// — the point is that it stops being an accident. Previously neither appeared
// anywhere in the codebase, which meant a call's echo cancellation depended
// entirely on a browser default nobody had written down: a browser changing its
// mind, or a future constraints object built without them, would have shipped
// calls with no cancellation and left nothing in the source to notice.
//
// noiseSuppression is deliberately NOT pinned, and that is a decision rather than
// an omission. This app runs its own RNNoise worklet (on by default), so the
// browser's suppressor is a second pass over the same audio — plausibly why some
// mics sound processed. But pinning it OFF would strip suppression entirely from
// anyone who disables the worklet, which is worse than double-processing. Choosing
// correctly needs to know what browsers actually apply in practice, which is what
// Media.micProcessing() now reports; until there is data, the browser's default
// stands rather than a guess.

// micConstraints(micId, {exact}) -> a MediaTrackConstraints object for `audio`.
// A falsy micId omits deviceId entirely (any microphone). exact=false asks for the
// device as `ideal`, so a since-removed one falls back to the default instead of
// failing the capture; exact=true is for a deliberate device switch, where quietly
// landing on a different microphone would be a bug rather than a fallback.
export function micConstraints(micId, { exact = false } = {}) {
  const audio = { echoCancellation: true, autoGainControl: true };
  if (micId) audio.deviceId = exact ? { exact: micId } : { ideal: micId };
  return audio;
}
