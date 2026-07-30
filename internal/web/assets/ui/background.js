// The background picker: a strip of thumbnail chips for the blur and virtual
// background effects. Mounted twice — in the pre-join lobby, and as a row in the
// in-call settings menu (`compact`, which wraps to a grid so the popover stays a
// sane width).
//
// Chips are grouped into a labelled row per backgrounds.js GROUPS: the blur and
// painted "Effects", then the photographic "Scenes".
//
// A painted chip is drawn by the SAME painter that draws the real background, at
// 48x27, so it is an exact preview. A scene chip cannot be: it shows a 48x27 crop
// of the asset, which conveys the colour and little else, so its label carries the
// meaning. Scene chips paint the effect's fallback colour immediately and redraw
// when the bitmap decodes — which also warms the cache, so the image is normally
// ready before anyone clicks.
//
// The ~3.4MB MediaPipe runtime is loaded on first use, not on page load, so the
// disabled/pending state here matters: it is the only feedback during a load that
// can take a few seconds on a slow connection. This mirrors how the noise
// suppression button handles its ~2MB worklet.

import { GROUPS, drawImageBackground, effectById } from "../lib/backgrounds.js";
import { loadBackgroundImage } from "../lib/backgroundImages.js";

const THUMB_W = 48;
const THUMB_H = 27;

// Tiny DOM helper: el("button", {class:"x", onClick:fn}, "text"). The "text" key
// sets textContent, so any caller string is inert markup-wise.
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

// Draw an effect's chip preview. "paint" effects call their own painter; the blur
// chips get a schematic stand-in (there is no camera frame to blur at chip size,
// and faking one would be more misleading than a glyph).
function drawThumb(canvas, effect) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, THUMB_W, THUMB_H);
  if (effect.kind === "image") {
    // The fallback now, the real image when it decodes. Requesting it here is also
    // what warms the loader's cache before the user picks anything.
    drawImageBackground(ctx, null, effect.fallback, THUMB_W, THUMB_H);
    loadBackgroundImage(effect.src).then((bitmap) => {
      if (!bitmap) return; // a dead asset keeps its fallback colour
      ctx.clearRect(0, 0, THUMB_W, THUMB_H);
      drawImageBackground(ctx, bitmap, effect.fallback, THUMB_W, THUMB_H);
    });
    return;
  }
  if (effect.kind === "paint") {
    effect.paint(ctx, THUMB_W, THUMB_H);
    return;
  }
  ctx.fillStyle = "#2b2f37"; // --border
  ctx.fillRect(0, 0, THUMB_W, THUMB_H);
  if (effect.kind === "blur") {
    // A soft blob behind a sharp one: reads as "subject sharp, background soft".
    if (ctx.filter !== undefined) ctx.filter = `blur(${effect.id === "blur-strong" ? 4 : 2}px)`;
    ctx.fillStyle = "rgba(76, 141, 255, 0.55)";
    ctx.fillRect(THUMB_W * 0.1, THUMB_H * 0.2, THUMB_W * 0.8, THUMB_H * 0.7);
    ctx.filter = "none";
    ctx.fillStyle = "#e6e8ec"; // --fg
    ctx.beginPath();
    ctx.arc(THUMB_W / 2, THUMB_H * 0.62, THUMB_H * 0.28, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  // "none": a diagonal slash.
  ctx.strokeStyle = "#9aa1ac"; // --muted
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(6, THUMB_H - 6);
  ctx.lineTo(THUMB_W - 6, 6);
  ctx.stroke();
}

export class BackgroundPicker {
  // { media, compact, onChange }. `compact` is the in-menu variant. onChange is
  // called after every settled change with (effectId, reverted) — reverted=true
  // means the effect was not the user's own doing (a build failure, a
  // device-switch race, or the watchdog bailing) and callers must NOT persist it.
  constructor({ media, compact = false, onChange } = {}) {
    this.media = media || null;
    this.onChange = typeof onChange === "function" ? onChange : () => {};
    this.busy = false;
    this._effectsDisabled = false; // latched by _disableEffects when WebGL is absent
    this.chips = new Map();

    this.notice = el("p", { class: "bg-notice", role: "status", hidden: true });
    this.strip = el("div", { class: "bg-strip", role: "radiogroup", "aria-label": "Background" });

    for (const group of GROUPS) {
      const chips = el("div", { class: "bg-row-chips" });
      for (const effect of group.effects) {
        const canvas = el("canvas", { class: "bg-thumb", width: THUMB_W, height: THUMB_H, "aria-hidden": "true" });
        drawThumb(canvas, effect);
        const chip = el(
          "button",
          {
            type: "button",
            class: "bg-chip",
            role: "radio",
            "aria-checked": "false",
            title: effect.label,
            onClick: () => this._choose(effect.id),
          },
          canvas,
          el("span", { class: "bg-label", text: effect.label }),
        );
        this.chips.set(effect.id, chip);
        chips.append(chip);
      }
      this.strip.append(
        el("div", { class: "bg-row" }, el("span", { class: "bg-row-label", text: group.label }), chips),
      );
    }

    this.el = el("div", { class: compact ? "bg-picker compact" : "bg-picker" }, this.strip, this.notice);

    // Media is the authority on what is actually in force — a build failure or a
    // watchdog bail changes it without anyone clicking a chip. It dispatches this
    // event SYNCHRONOUSLY, as the last thing it does before setBackground's
    // promise resolves (see _choose for why that ordering matters here).
    this._onChanged = (e) => {
      const detail = e.detail || {};
      const effectId = detail.effectId || "none";
      // reason drives the notice text: "user" (an explicit choice — no notice),
      // "failed" (the pipeline could not start), or "slow" (the watchdog gave
      // up). Fall back from `reverted` for a detail that somehow lacks reason,
      // so an older/other event shape degrades to a notice rather than silence.
      const reason = detail.reason || (detail.reverted ? "failed" : "user");
      this._settle(effectId, reason);
    };
    if (this.media) this.media.addEventListener("background-changed", this._onChanged);

    this._reflect(this.media ? this.media.backgroundEffect : "none");
  }

  // Set the selection without going through Media — moves the highlight only, no
  // pending state, no notice, no onChange. Safe when nothing needs to actually
  // start (e.g. reflecting Media's current state on construction), but NOT for
  // restoring a saved preference that still needs to be built: this leaves the
  // chip claiming an effect that Media hasn't been asked to run, and if that build
  // is later abandoned mid-flight with no generation bump (a device switch racing
  // it), nothing ever corrects the chip. Use restore() for that case instead.
  select(effectId) {
    this._reflect(effectById(effectId).id);
  }

  // Apply a saved preference through exactly the same path as a click, so the
  // pending/disabled state and the settle contract are identical. Prefer this over
  // select() for a restore: select() only moves the highlight, which leaves the chip
  // claiming an effect that may never actually start.
  restore(effectId) {
    return this._choose(effectId);
  }

  destroy() {
    if (this.media) this.media.removeEventListener("background-changed", this._onChanged);
    this.chips.clear();
  }

  async _choose(effectId) {
    if (!this.media || this.busy) return;
    if (this.media.backgroundEffect === effectId) return;
    this.busy = true;
    this._setPending(effectId, true);
    this.notice.hidden = true;
    try {
      await this.media.setBackground(effectId);
      // Deliberately not touching chips/notice/onChange here on success: Media
      // dispatches "background-changed" synchronously as the last step of
      // setBackground, before its promise settles, so _onChanged/_settle has
      // ALREADY run with the real (effectId, reason) by the time this await
      // returns. Reacting again here — as an earlier draft of this component
      // did — raced that event and produced two notices (one keyed off `reason`,
      // one off a hardcoded string) and two onChange calls, sometimes with
      // conflicting `reverted` values for the same settle. The event is the
      // single source of truth; _choose only owns the pending/disabled state.
    } catch {
      // Media has never been observed to reject setBackground — its own build
      // failures are caught internally and reported via the event above — but
      // if it ever did, no event would have fired for this attempt. Settle by
      // hand so a notice still appears and onChange still fires, exactly once.
      this._settle(this.media.backgroundEffect, "failed");
    } finally {
      this.busy = false;
      this._setPending(effectId, false);
    }
  }

  // The one place that reacts to a settled background state: highlights the
  // right chip, shows (or clears) the notice for `reason`, and tells the caller
  // whether to persist it. Reached from the "background-changed" listener for
  // every real change, and from _choose's catch as a fallback for the
  // (currently unreachable) case where Media rejects before it can emit.
  _settle(effectId, reason) {
    this._reflect(effectId);
    const reverted = reason !== "user";
    if (reason === "slow") {
      this.notice.hidden = false;
      this.notice.textContent = "Background turned off — this device couldn't keep up.";
    } else if (reason === "unsupported") {
      // Permanent, and actionable — so say what is wrong and what to do, rather
      // than a generic failure the user would retry forever.
      this.notice.hidden = false;
      this.notice.textContent = "Backgrounds need WebGL, which this browser has turned off. Enable hardware acceleration in your browser settings, then reload.";
      this._disableEffects();
    } else if (reason === "failed") {
      this.notice.hidden = false;
      this.notice.textContent = "That background could not be started.";
    } else {
      this.notice.hidden = true;
    }
    this.onChange(effectId, reverted);
  }

  // Permanently disable every chip but "None". Called when Media reports that
  // this browser cannot run effects at all — leaving them clickable would invite
  // the user to keep picking things that can only fail, once per attempt.
  _disableEffects() {
    for (const [id, chip] of this.chips) {
      if (id === "none") continue;
      chip.disabled = true;
      chip.title = `${chip.title} — unavailable without WebGL`;
    }
    this._effectsDisabled = true;
  }

  // Pure chip highlighting — no notice, no onChange. Used for the settled path
  // (via _settle), the constructor's initial sync, and select()'s "restore a
  // saved preference" path, which must move the highlight without claiming a
  // change happened.
  _reflect(effectId) {
    for (const [id, chip] of this.chips) {
      const on = id === effectId;
      chip.classList.toggle("on", on);
      chip.setAttribute("aria-checked", on ? "true" : "false");
    }
  }

  _setPending(effectId, pending) {
    const chip = this.chips.get(effectId);
    if (chip) chip.classList.toggle("pending", pending);
    for (const [id, c] of this.chips) {
      // Clearing a pending state must not resurrect chips that _disableEffects
      // switched off for good — this browser still cannot run them.
      c.disabled = pending || (this._effectsDisabled && id !== "none");
    }
  }
}
