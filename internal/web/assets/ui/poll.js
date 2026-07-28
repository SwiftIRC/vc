// One poll card, rendered into the chat log.
//
// Tallies are NEVER optimistic: the card re-renders from each server broadcast, so the
// numbers on screen are always what the server counted. The viewer's own selection IS
// local — the broadcast deliberately carries no per-recipient field, so the highlight
// is applied on click and restored after a reconnect from the join snapshot.
//
// Injection-safety: the question, the option text and the creator's name are
// participant-controlled and are written through el()'s "text" key (textContent),
// exactly as chat.js requires. No innerHTML.

import { tallyPercents, totalVotes } from "../lib/poll.js";

// Local DOM helper, matching the one in each other ui/*.js (chat, grid, controls,
// prejoin). The "text" key sets textContent, so caller strings can never inject markup.
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

export class PollCard {
  // { poll, isOp, myVote, onVote, onClose }. `poll` is the wire shape:
  // { id, question, options, tallies, by, open }.
  constructor({ poll, isOp = false, myVote = null, onVote, onClose } = {}) {
    this.poll = poll || {};
    this.isOp = !!isOp;
    this.myVote = Number.isInteger(myVote) ? myVote : null;
    this.onVote = typeof onVote === "function" ? onVote : () => {};
    this.onClose = typeof onClose === "function" ? onClose : () => {};
    this.el = el("div", { class: "poll-card", role: "group", "aria-label": "Poll" });
    this.render();
  }

  get id() {
    return this.poll && this.poll.id;
  }

  // Apply a newer server state for the SAME poll (an "update" or "close").
  update(poll) {
    this.poll = poll || {};
    this.render();
  }

  // The local role changed (an op promotion mid-poll), so the Close button appears.
  setOp(isOp) {
    this.isOp = !!isOp;
    this.render();
  }

  render() {
    const p = this.poll || {};
    const options = Array.isArray(p.options) ? p.options : [];
    const tallies = Array.isArray(p.tallies) ? p.tallies : [];
    const pct = tallyPercents(tallies);
    const total = totalVotes(tallies);
    const open = !!p.open;
    // Winner is only meaningful once voting has stopped.
    const best = open || !total ? -1 : pct.reduce((bi, v, i, a) => (v > a[bi] ? i : bi), 0);

    this.el.replaceChildren(
      el("div", { class: "poll-q", text: p.question || "" }),
      ...options.map((label, i) =>
        el(
          "button",
          {
            class: "poll-option" + (this.myVote === i ? " poll-mine" : "") + (i === best ? " poll-win" : ""),
            type: "button",
            disabled: !open,
            "aria-pressed": this.myVote === i ? "true" : "false",
            onClick: () => this._vote(i),
          },
          el("span", { class: "poll-bar", style: `width:${pct[i] || 0}%` }),
          el("span", { class: "poll-label", text: label }),
          el("span", { class: "poll-count", text: `${tallies[i] || 0} · ${pct[i] || 0}%` }),
        ),
      ),
      el(
        "div",
        { class: "poll-foot" },
        el("span", {
          class: "poll-meta",
          text: `${total} vote${total === 1 ? "" : "s"} · by ${p.by || "an op"}${open ? "" : " · closed"}`,
        }),
        this.isOp && open
          ? el("button", { class: "poll-close", type: "button", onClick: () => this.onClose(this.id) }, "Close poll")
          : null,
      ),
    );
  }

  _vote(i) {
    if (!this.poll || !this.poll.open) return;
    this.myVote = i; // local: the server never echoes who voted what
    this.onVote(this.id, i);
    this.render();
  }
}
