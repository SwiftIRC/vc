import { test } from "node:test";
import assert from "node:assert/strict";
import { EFFECTS, resolveEffectId, effectById } from "../assets/lib/backgrounds.js";

// A recording stand-in for CanvasRenderingContext2D. Node has no canvas, but the
// properties that matter here — does the painter cover the frame, does it leave
// global state dirty — are observable from the call log alone.
function fakeCtx(w, h) {
  const calls = [];
  const ctx = {
    canvas: { width: w, height: h },
    globalCompositeOperation: "source-over",
    filter: "none",
    fillStyle: "",
    fillRect: (x, y, rw, rh) => calls.push({ op: "fillRect", x, y, w: rw, h: rh }),
    beginPath: () => calls.push({ op: "beginPath" }),
    arc: () => calls.push({ op: "arc" }),
    fill: () => calls.push({ op: "fill" }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
  };
  return { ctx, calls };
}

// The id set is a PUBLIC contract: it is written into localStorage. Renaming an
// id silently orphans every saved preference, and nothing else would catch it.
test("the effect id set is frozen", () => {
  assert.deepEqual(
    EFFECTS.map((e) => e.id),
    ["none", "blur", "blur-strong", "aurora", "dusk", "grid", "depth", "paper"],
  );
});

test("every effect is well formed for its kind", () => {
  for (const e of EFFECTS) {
    assert.ok(e.label, `${e.id} has no label`);
    assert.ok(["none", "blur", "paint"].includes(e.kind), `${e.id} has kind ${e.kind}`);
    if (e.kind === "blur") {
      assert.equal(typeof e.radius, "number", `${e.id} needs a radius`);
      assert.ok(e.radius > 0 && e.radius < 0.2, `${e.id} radius ${e.radius} is out of range`);
    }
    if (e.kind === "paint") assert.equal(typeof e.paint, "function", `${e.id} needs a painter`);
  }
});

test("ids are unique", () => {
  assert.equal(new Set(EFFECTS.map((e) => e.id)).size, EFFECTS.length);
});

test("blur-strong is actually stronger than blur", () => {
  const light = EFFECTS.find((e) => e.id === "blur");
  const strong = EFFECTS.find((e) => e.id === "blur-strong");
  assert.ok(strong.radius > light.radius);
});

test("an unknown stored preference falls back to none rather than throwing", () => {
  assert.equal(resolveEffectId("aurora"), "aurora");
  assert.equal(resolveEffectId("beach-sunset"), "none"); // a since-removed id
  assert.equal(resolveEffectId(undefined), "none");
  assert.equal(resolveEffectId(null), "none");
  assert.equal(resolveEffectId(""), "none");
  assert.equal(resolveEffectId(42), "none");
});

test("effectById always returns an entry", () => {
  assert.equal(effectById("dusk").id, "dusk");
  assert.equal(effectById("nonsense").id, "none");
  assert.equal(effectById(undefined).id, "none");
});

test("every painter covers the whole frame", () => {
  for (const e of EFFECTS.filter((x) => x.kind === "paint")) {
    const { ctx, calls } = fakeCtx(640, 360);
    e.paint(ctx, 640, 360);
    const covers = calls.some((c) => c.op === "fillRect" && c.x === 0 && c.y === 0 && c.w === 640 && c.h === 360);
    assert.ok(covers, `${e.id} never fills the full frame — the camera would show through`);
  }
});

test("no painter leaks global canvas state", () => {
  // Aurora composites its glows with "lighter". Leaving that set would corrupt
  // whatever the compositor draws next, on a shared context.
  for (const e of EFFECTS.filter((x) => x.kind === "paint")) {
    const { ctx } = fakeCtx(640, 360);
    e.paint(ctx, 640, 360);
    assert.equal(ctx.globalCompositeOperation, "source-over", `${e.id} left compositing dirty`);
    assert.equal(ctx.filter, "none", `${e.id} left a filter set`);
  }
});

test("painters are deterministic — no per-frame shimmer", () => {
  for (const e of EFFECTS.filter((x) => x.kind === "paint")) {
    const a = fakeCtx(320, 180);
    const b = fakeCtx(320, 180);
    e.paint(a.ctx, 320, 180);
    e.paint(b.ctx, 320, 180);
    assert.deepEqual(a.calls, b.calls, `${e.id} draws differently on identical input`);
  }
});

test("painters scale to thumbnail size without dividing by zero", () => {
  for (const e of EFFECTS.filter((x) => x.kind === "paint")) {
    const { ctx, calls } = fakeCtx(48, 27);
    e.paint(ctx, 48, 27); // must not throw
    assert.ok(calls.length > 0, `${e.id} drew nothing at thumbnail size`);
  }
});
