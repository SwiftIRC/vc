// A frame-rate watchdog for the background compositor. It answers exactly one
// question — "is this device keeping up?" — and does nothing about the answer:
// it owns no tracks, renders nothing, and reads no clock. The caller supplies
// every timestamp.
//
// That purity is the point. Segmentation is expensive enough on low-end phones
// that some of them cannot sustain a usable frame rate, and shipping a 5fps
// slideshow to the whole room is worse than shipping no effect. Deciding when to
// give up is fiddly, timing-dependent logic, so it lives here where `node --test`
// can drive it with synthetic timestamps instead of a real browser.
//
// Two entry points, because they catch different failures:
//   push(now)   record a composited frame.
//   check(now)  render a verdict. Driven from a timer as well as from the render
//               loop, so a TOTAL stall — where push() simply stops being called —
//               is caught. push() alone could never detect that.
//
// It trips at most once: the caller tears the pipeline down on the first true.
// reset() re-arms it when the user picks a different effect, so a device that
// choked on a virtual background still gets to try a cheap blur.

// Model warm-up and first-frame shader compilation are slow by nature; judging
// them would trip on every single start.
export const GRACE_MS = 3000;
// How much recent history a verdict is based on.
export const WINDOW_MS = 5000;
// Below this, no effect beats a stuttering one.
export const MIN_FPS = 12;

export class FpsGuard {
  constructor({ graceMs = GRACE_MS, windowMs = WINDOW_MS, minFps = MIN_FPS } = {}) {
    this.graceMs = graceMs;
    this.windowMs = windowMs;
    this.minFps = minFps;
    this.reset();
  }

  reset() {
    this._start = null;
    this._frames = [];
    this._tripped = false;
  }

  get tripped() {
    return this._tripped;
  }

  // Record one composited frame.
  push(nowMs) {
    if (this._tripped) return;
    if (this._start === null) this._start = nowMs;
    this._frames.push(nowMs);
    this._prune(nowMs);
  }

  // Render a verdict. Returns true exactly once, on the first observation that
  // sustained throughput is too low to continue.
  check(nowMs) {
    if (this._tripped || this._start === null) return false;
    // Judge only once a full window of POST-warm-up history exists. Before that
    // the window is partly filled with warm-up frames (or empty), so any verdict
    // would be about start-up cost rather than steady-state throughput.
    if (nowMs - this._start < this.graceMs + this.windowMs) return false;
    this._prune(nowMs);
    // Frames actually delivered, over the window's real length — not over the
    // span between the frames we happen to hold. A wedged compositor lands here
    // with zero frames and a rate of 0, which is exactly the verdict we want.
    const fps = this._frames.length / (this.windowMs / 1000);
    if (fps >= this.minFps) return false;
    this._tripped = true;
    return true;
  }

  // Drop frames that have aged out, keeping the array O(fps × windowSeconds).
  _prune(nowMs) {
    const cutoff = nowMs - this.windowMs;
    let drop = 0;
    while (drop < this._frames.length && this._frames[drop] < cutoff) drop++;
    if (drop > 0) this._frames.splice(0, drop);
  }
}
