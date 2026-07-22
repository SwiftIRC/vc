// Browser WebSocket signaling wrapper. Connects to ws(s)://<host>/ws/<room>,
// auto-reconnects on any unexpected close (with backoff + jitter), and dispatches
// decoded inbound frames to handlers registered by message type.
//
// Security-critical: reconnect happens on ANY close EXCEPT after stop(). The app
// calls stop() on kicked/banned/leave to make the disconnect permanent; on
// server-restarting it does NOT stop, so the socket simply drops and reconnects.
import { encode, decode } from "../lib/protocol.js";
import { backoffDelay } from "../lib/backoff.js";

// Small extra randomness on top of the deterministic backoff so a herd of clients
// reconnecting after the same server event does not stampede in lockstep.
const JITTER_MS = 250;

// Resolve a path like "/ws/room" against the current page origin, choosing wss
// for https pages and ws otherwise. An already-absolute ws(s) URL is left as-is.
function resolveUrl(url) {
  if (/^wss?:\/\//i.test(url)) return url;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const path = url.startsWith("/") ? url : `/${url}`;
  return `${proto}//${location.host}${path}`;
}

export class Signaling {
  constructor(url) {
    this.url = resolveUrl(url);
    this.handlers = new Map(); // type -> [fn]
    this.queue = []; // outbound frames buffered until the socket is open
    this.attempt = 0; // reconnect attempt counter (reset on open)
    this.stopped = false; // once true, never reconnect
    this.ws = null;
    this.reconnectTimer = null;
  }

  // Register an inbound handler for a message type. "*" is a catch-all that fires
  // for every message. Multiple handlers per type are supported.
  on(type, handler) {
    const list = this.handlers.get(type) || [];
    list.push(handler);
    this.handlers.set(type, list);
    return this;
  }

  // Remove a previously-registered handler. Used when the media Peer is rebuilt on a
  // reconnect: the old Peer's offer/answer/candidate/tracks handlers must come off the
  // (persistent) Signaling so the fresh Peer's don't run alongside stale ones.
  off(type, handler) {
    const list = this.handlers.get(type);
    if (!list) return this;
    const i = list.indexOf(handler);
    if (i !== -1) list.splice(i, 1);
    return this;
  }

  connect() {
    if (this.stopped) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.attempt = 0; // successful connection: forget past failures
      const pending = this.queue;
      this.queue = [];
      for (const frame of pending) ws.send(frame);
    });

    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = decode(ev.data);
      } catch {
        return; // ignore malformed frames rather than crash the socket
      }
      this._dispatch(msg);
    });

    ws.addEventListener("close", () => {
      if (this.ws === ws) this.ws = null;
      if (this.stopped) return; // stop() suppresses reconnect
      this._scheduleReconnect();
    });

    // Errors precede a close event; let the close handler drive reconnect.
    ws.addEventListener("error", () => {});
  }

  // Encode and send a frame. If the socket is not open yet, queue it so a join
  // sent immediately after connect() is delivered once the socket opens.
  send(type, fields) {
    const frame = encode(type, fields);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(frame);
    } else {
      this.queue.push(frame);
    }
  }

  // Permanent close: no reconnect. Used after kicked/banned or when the user
  // leaves. This suppression is what Plan 2's ban enforcement relies on.
  stop() {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.close();
    }
  }

  _dispatch(msg) {
    for (const fn of this.handlers.get(msg.type) || []) fn(msg);
    for (const fn of this.handlers.get("*") || []) fn(msg);
  }

  _scheduleReconnect() {
    if (this.reconnectTimer !== null) return; // one pending reconnect at a time
    const delay = backoffDelay(this.attempt) + Math.floor(Math.random() * JITTER_MS);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
