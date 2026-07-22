// Reconnect-aware chimes for the join/leave sounds.
//
// A dropped socket rejoins with a FRESH participant id but the SAME server-issued
// session `ref` (see signal.PeerInfo.Ref). So a brief reconnect — the exact thing a
// screenshare's link contention can trigger — shows up to other clients as a peer-left
// followed by a peer-joined for what is really the same person, which naively rings the
// "drop" then "join" chime for a member who never actually left.
//
// Presence tracks live sessions per ref to tell those apart from a genuine come-and-go:
//   - joined(ref): a ref already present (its old socket still lingers) or with a
//     deferred drop pending (it left an instant ago) is a reconnect — stay silent.
//   - left(ref): a ref whose OTHER session is still present (the reconnect's old socket
//     dropping after the new one joined) stays silent; otherwise the drop chime is
//     DEFERRED by a grace, so a rejoin within the window cancels it. Only a real
//     departure — no rejoin within the grace — ever chimes.
//
// seed() resets to an authoritative roster (the `joined` frame, initial or on our own
// reconnect). A "" ref (client sent no session nonce) is untrackable, so it always
// chimes — the pre-existing behaviour.
export class Presence {
  constructor({ onJoinChime, onDropChime, graceMs = 6000, timers = globalThis } = {}) {
    this._join = onJoinChime || (() => {});
    this._drop = onDropChime || (() => {});
    this._grace = graceMs;
    // Injectable timers so tests can drive the deferred drop deterministically.
    this._setTimeout = timers.setTimeout.bind(timers);
    this._clearTimeout = timers.clearTimeout.bind(timers);
    this._present = new Map(); // ref -> count of currently-present sessions
    this._pending = new Map(); // ref -> timer id for a deferred "drop" chime
  }

  // Reset to an authoritative roster. Cancels any deferred drops — the roster is the
  // source of truth now, so a pending drop for someone the roster still lists (or no
  // longer lists) must not fire spuriously.
  seed(peers) {
    this._cancelPending();
    this._present.clear();
    for (const p of peers || []) {
      if (p && p.ref) this._present.set(p.ref, (this._present.get(p.ref) || 0) + 1);
    }
  }

  // A peer joined. Chimes only for a genuinely new session.
  joined(ref) {
    const reconnect = !!ref && ((this._present.get(ref) || 0) > 0 || this._pending.has(ref));
    if (ref && this._pending.has(ref)) {
      this._clearTimeout(this._pending.get(ref));
      this._pending.delete(ref);
    }
    if (ref) this._present.set(ref, (this._present.get(ref) || 0) + 1);
    if (!reconnect) this._join();
  }

  // A peer left. Chimes only for a real departure.
  left(ref) {
    if (!ref) {
      this._drop(); // untrackable — chime immediately, as before refs existed
      return;
    }
    const remaining = (this._present.get(ref) || 0) - 1;
    if (remaining > 0) {
      // Another session for this ref is still here: the reconnect's OLD socket dropping
      // after its new one already joined. Stay silent.
      this._present.set(ref, remaining);
      return;
    }
    this._present.delete(ref);
    // Defer: a rejoin within the grace (joined() above) cancels this, so only a real
    // departure chimes.
    const t = this._setTimeout(() => {
      this._pending.delete(ref);
      this._drop();
    }, this._grace);
    this._pending.set(ref, t);
  }

  // Cancel every deferred drop. Call on teardown so none fire after leaving the call.
  clear() {
    this._cancelPending();
    this._present.clear();
  }

  _cancelPending() {
    for (const t of this._pending.values()) this._clearTimeout(t);
    this._pending.clear();
  }
}
