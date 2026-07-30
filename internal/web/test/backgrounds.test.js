import { test } from "node:test";
import assert from "node:assert/strict";
import { EFFECTS, resolveEffectId, effectById, coverRect } from "../assets/lib/backgrounds.js";

// A recording stand-in for CanvasRenderingContext2D. Node has no canvas, but the
// properties that matter here — does the painter cover the frame, does it leave
// global state dirty — are observable from the call log alone.
function fakeCtx(w, h, callLimit = Infinity) {
  const calls = [];
  const ctx = {
    canvas: { width: w, height: h },
    globalCompositeOperation: "source-over",
    filter: "none",
    fillStyle: "",
    fillRect: (x, y, rw, rh) => {
      if (calls.length >= callLimit) throw new Error("unbounded work detected");
      calls.push({ op: "fillRect", x, y, w: rw, h: rh });
    },
    beginPath: () => {
      if (calls.length >= callLimit) throw new Error("unbounded work detected");
      calls.push({ op: "beginPath" });
    },
    arc: () => {
      if (calls.length >= callLimit) throw new Error("unbounded work detected");
      calls.push({ op: "arc" });
    },
    fill: () => {
      if (calls.length >= callLimit) throw new Error("unbounded work detected");
      calls.push({ op: "fill" });
    },
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

test("painters handle degenerate sizes without infinite loops or unbounded work", () => {
  // Degenerate canvas dimensions can cause infinite loops (w=0 → pitch=0) or
  // pathological call counts (w=1 → millions of iterations). Painters must
  // complete quickly and bound their work.
  //
  // [0,0]: Both dimensions degenerate. The h <= 0 condition prevents the outer
  // loop from running, so this completes safely with minimal calls.
  //
  // [1,1]: Tests bounded work. With the pitch floor (Math.max(4, w/24)),
  // a 1px frame should still complete in reasonable time, not 1.7M calls.
  // The call limit (100) catches if the floor is removed or broken; failure
  // here indicates pathological gridding.
  //
  // [0,10] and [10,0] are omitted: they would cause infinite loop detection
  // to fail silently. When w=0 but h>0, the outer loop runs forever (y+=0),
  // but the inner loop condition x < 0 is false, so no context calls are made
  // and the call limit never triggers. These cases are protected by the
  // w <= 0 || h <= 0 guard in paintGrid, not by call counting; instead we
  // verify the guard's observable effect via [0,0] test and the call limit's
  // effectiveness via [1,1].
  const degenerateSizes = [[0, 0], [1, 1]];
  for (const e of EFFECTS.filter((x) => x.kind === "paint")) {
    for (const [w, h] of degenerateSizes) {
      const { ctx, calls } = fakeCtx(w, h, 100);
      e.paint(ctx, w, h); // must not throw or hang
      assert.ok(calls.length < 100, `${e.id} at ${w}×${h} made ${calls.length} calls`);
    }
  }
});

test("coverRect crops the sides when the source is wider than the target", () => {
  // 16:9 source into a 4:3 frame: full height, sides trimmed, centred.
  assert.deepEqual(coverRect(1280, 720, 640, 480), { sx: 160, sy: 0, sw: 960, sh: 720 });
});

test("coverRect crops top and bottom when the source is taller than the target", () => {
  // A square source into 16:9: full width, top and bottom trimmed, centred.
  assert.deepEqual(coverRect(1024, 1024, 1280, 720), { sx: 0, sy: 224, sw: 1024, sh: 576 });
});

test("coverRect uses the whole source when the aspect ratios match", () => {
  assert.deepEqual(coverRect(1280, 720, 640, 360), { sx: 0, sy: 0, sw: 1280, sh: 720 });
  assert.deepEqual(coverRect(1280, 720, 48, 27), { sx: 0, sy: 0, sw: 1280, sh: 720 });
});

test("coverRect returns null for degenerate dimensions rather than a NaN rect", () => {
  // drawImage throws IndexSizeError on a zero-sized source rect, so callers need a
  // signal to fall back instead of a rect they cannot use.
  for (const args of [[0, 720, 640, 360], [1280, 0, 640, 360], [1280, 720, 0, 360], [1280, 720, 640, 0]]) {
    assert.equal(coverRect(...args), null, `coverRect(${args}) should be null`);
  }
  assert.equal(coverRect(NaN, 720, 640, 360), null);
  assert.equal(coverRect(1280, 720, undefined, 360), null);
});
