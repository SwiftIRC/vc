// The in-call chat panel and moderation feed. One scrollable log carries two
// kinds of entries, interleaved in arrival order:
//
//   - chat messages   — inbound `chat` {from, text, ts}. A late joiner receives
//     up to 200 replayed messages as a burst of `chat` frames right after
//     `joined`; each is just another inbound frame, so appending in arrival
//     order replays the history in order for free. The server echoes a sender's
//     own message back over the same broadcast, so we never locally echo — the
//     line appears once, when the server confirms it.
//   - moderation lines — inbound `moderation` {actor, action, target, kind?}
//     rendered as feed text ("alice kicked bob", "alice muted bob (mic)",
//     "alice locked the room"). The authoritative lock INDICATOR is owned by
//     controls.js (it reflects room-locked / room-unlocked), so this panel only
//     narrates lock/unlock in the feed and does not draw its own indicator.
//
// Sending: the compose box submits `chat` {text} on Enter or the Send button.
//
// Injection-safety: EVERY participant-controlled string — from, text, actor,
// target — is written via textContent (the el() "text" key), never innerHTML. A
// hostile chat body or display name like "<img src=x onerror=…>" is therefore
// inert text, never parsed as markup. Links are the one place a message becomes
// something other than a text node, and they are built the same way: lib/linkify
// only ever recognises http/https, so an <a href> can never carry a javascript:
// or data: scheme, and the anchor's own text is set with textContent like the rest.

import { linkSegments } from "../lib/linkify.js";

// Tiny DOM helper: el("div", {class:"x", onClick:fn}, child, "text"...). The
// "text" key sets textContent, so caller-supplied strings can never inject markup.
function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) node.setAttribute(k, "");
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const kid of kids) if (kid != null) node.append(kid);
  return node;
}

// Cap on retained log entries so a long-running call (plus the 200-message
// replay) can't grow the DOM without bound; oldest lines are dropped first.
const MAX_ENTRIES = 500;

// Format a unix-seconds timestamp as local HH:MM. Missing/zero ts falls back to
// "now" so a locally-timed line still reads sensibly.
function hhmm(ts) {
  const d = Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000) : new Date();
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

// Human-readable moderation feed text. actor/target are remote-controlled but
// this only builds a STRING; the caller writes it via textContent.
function moderationText({ actor, action, target, kind } = {}) {
  const who = actor || "someone";
  switch (action) {
    case "kick":
      return `${who} kicked ${target || "a participant"}`;
    case "ban":
      return `${who} banned ${target || "a participant"}`;
    case "mute":
      return kind
        ? `${who} muted ${target || "a participant"} (${kind})`
        : `${who} muted ${target || "a participant"}`;
    case "lock":
      return `${who} locked the room`;
    case "unlock":
      return `${who} unlocked the room`;
    case "op":
      return `${who} made ${target || "a participant"} an op`;
    case "quality": {
      const tier = !kind || kind === "auto" ? "Auto" : kind.charAt(0).toUpperCase() + kind.slice(1);
      return `${who} set ${target || "video"} quality to ${tier}`;
    }
    default:
      // Unknown action: still narrate it, safely, rather than drop it silently.
      return target ? `${who} ${action || "acted on"} ${target}` : `${who} ${action || "acted"}`;
  }
}

export class Chat {
  // { signaling }. app.js routes inbound `chat` -> onChat and `moderation` ->
  // onModeration; sending goes back out through the same signaling socket.
  constructor({ signaling } = {}) {
    this.signaling = signaling || null;
    this._build();
  }

  _build() {
    this.log = el("div", { class: "chat-log", role: "log", "aria-live": "polite", "aria-label": "Chat and moderation feed" });

    this.input = el("input", {
      class: "chat-input",
      type: "text",
      placeholder: "Message",
      autocomplete: "off",
      maxlength: "2000",
    });
    const sendBtn = el("button", { class: "chat-send", type: "submit" }, "Send");

    // A <form> gives Enter-to-send for free; preventDefault keeps the page from
    // navigating on submit.
    this.form = el(
      "form",
      { class: "chat-compose", onSubmit: (e) => { e.preventDefault(); this._submit(); } },
      this.input,
      sendBtn,
    );

    this.el = el("div", { class: "chat" }, el("h2", { class: "chat-title", text: "Chat" }), this.log, this.form);

    // Hidden by default; the control bar's Chat toggle reveals it (setVisible).
    this.visible = false;
    this.el.hidden = true;
  }

  // Show or hide the panel. controls.js owns the toggle; focus the compose box on
  // reveal so the user can type immediately.
  setVisible(visible) {
    this.visible = !!visible;
    this.el.hidden = !this.visible;
    if (this.visible) this.input.focus();
  }

  // --- outbound ---

  _submit() {
    const text = this.input.value.trim();
    if (!text) return;
    if (this.signaling) this.signaling.send("chat", { text });
    this.input.value = "";
    this.input.focus();
    // No local echo: the server broadcasts the message back to us and onChat
    // renders it then, so it appears exactly once.
  }

  // --- inbound ---

  // Inbound `chat` {from, text, ts}. Also the path the replay burst takes.
  onChat({ from, text, ts } = {}) {
    if (text == null) return;
    const line = el(
      "div",
      { class: "chat-msg" },
      el("span", { class: "chat-time", text: hhmm(ts) }),
      el("span", { class: "chat-from", text: from || "guest" }),
      this._body(String(text)),
    );
    this._append(line);
  }

  // The message body: plain runs as text nodes, http/https runs as anchors that open
  // in a new tab. rel="noopener" denies the opened page a handle on this one (it could
  // otherwise redirect the call away via window.opener); "noreferrer" also withholds
  // the Referer, which would hand the room's URL — an invite link — to whatever site
  // someone posts.
  _body(text) {
    const span = el("span", { class: "chat-text" });
    for (const seg of linkSegments(text)) {
      // append(string) makes a TEXT node — the non-link runs stay inert markup-wise.
      span.append(
        seg.href
          ? el("a", { class: "chat-link", href: seg.href, target: "_blank", rel: "noopener noreferrer", text: seg.text })
          : seg.text,
      );
    }
    return span;
  }

  // Inbound `moderation` {actor, action, target, kind?} -> one feed line.
  onModeration(msg = {}) {
    const line = el("div", { class: "chat-mod", text: moderationText(msg) });
    this._append(line);
  }

  _append(line) {
    // Auto-scroll only when the user is already pinned to the bottom, so reading
    // back through history isn't yanked away by an incoming message.
    const atBottom = this.log.scrollTop + this.log.clientHeight >= this.log.scrollHeight - 4;
    this.log.append(line);
    while (this.log.childElementCount > MAX_ENTRIES) this.log.firstElementChild.remove();
    if (atBottom) this.log.scrollTop = this.log.scrollHeight;
  }

  // Empty the log without tearing the panel down. Used on a reconnect re-join,
  // where the server replays chat history again: clearing first keeps the replay
  // from stacking a duplicate copy on top of what's already shown.
  clear() {
    this.log.replaceChildren();
  }

  // Detach from the DOM and drop references. app.js stops the socket separately;
  // there is nothing else to unwind here.
  destroy() {
    this.signaling = null;
    if (this.el) this.el.replaceChildren();
  }
}
