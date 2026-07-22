// Keep the device's screen awake while the user is in a call (Screen Wake Lock API),
// so a video call doesn't dim/sleep the display during a lull in interaction.
//
// The browser AUTO-RELEASES a screen wake lock whenever the document becomes hidden
// (tab switch, minimize, lock screen), so holding one is not enough — we re-acquire it
// on visibilitychange while still active. Everything is best-effort: the API is absent
// in older browsers and insecure contexts, and request() can reject (not visible, or
// blocked by power settings); none of that should ever throw into the call.
export class ScreenWakeLock {
  constructor() {
    this._sentinel = null; // the held WakeLockSentinel, or null
    this._active = false; // whether we WANT the screen kept awake (in a call)
    // Re-acquire when the tab becomes visible again: the browser dropped our lock
    // while hidden, so request() only succeeds once we're back in the foreground.
    this._onVisibility = () => {
      if (this._active && document.visibilityState === "visible") this._request();
    };
  }

  // Start keeping the screen awake. Idempotent; safe to call where the API is missing.
  enable() {
    if (this._active) return;
    this._active = true;
    document.addEventListener("visibilitychange", this._onVisibility);
    this._request();
  }

  // Stop keeping the screen awake and release any held lock. Idempotent.
  async disable() {
    if (!this._active) return;
    this._active = false;
    document.removeEventListener("visibilitychange", this._onVisibility);
    const sentinel = this._sentinel;
    this._sentinel = null;
    if (sentinel) {
      try {
        await sentinel.release();
      } catch {
        /* already released (e.g. auto-released on hide) */
      }
    }
  }

  async _request() {
    if (this._sentinel) return; // already holding one
    if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return;
    try {
      const sentinel = await navigator.wakeLock.request("screen");
      if (!this._active) {
        // disable() ran while the request was in flight — don't keep this lock.
        try {
          await sentinel.release();
        } catch {
          /* ignore */
        }
        return;
      }
      this._sentinel = sentinel;
      // On auto-release (the tab was hidden) drop our reference so the next
      // visibilitychange re-requests a fresh lock instead of thinking one is held.
      sentinel.addEventListener("release", () => {
        this._sentinel = null;
      });
    } catch {
      /* request rejected (not visible / blocked) — best-effort, try again next time */
    }
  }
}
