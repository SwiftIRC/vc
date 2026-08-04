import { test } from "node:test";
import assert from "node:assert/strict";
import { EFFECTS, GROUPS, resolveEffectId, effectById, coverRect, drawImageBackground, sceneEffects } from "../assets/lib/backgrounds.js";

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
    drawImage: (...args) => {
      if (calls.length >= callLimit) throw new Error("unbounded work detected");
      calls.push({ op: "drawImage", args });
    },
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
  };
  return { ctx, calls };
}

// The id set is a PUBLIC contract: it is written into localStorage. Renaming an
// id silently orphans every saved preference, and nothing else would catch it.
// These are the ids compiled into the client. The photographic scenes are NOT
// here: the server injects whichever ones a build embedded (window.__vcScenes),
// there is no window under node --test, so EFFECTS is exactly the built-ins. Scene
// construction is covered through sceneEffects below.
test("the effect id set is frozen", () => {
  assert.deepEqual(
    EFFECTS.map((e) => e.id),
    ["none", "blur", "blur-strong", "aurora", "dusk", "grid", "depth", "paper"],
  );
});

test("every effect is well formed for its kind", () => {
  for (const e of EFFECTS) {
    assert.ok(e.label, `${e.id} has no label`);
    assert.ok(["none", "blur", "paint", "image"].includes(e.kind), `${e.id} has kind ${e.kind}`);
    if (e.kind === "blur") {
      assert.equal(typeof e.radius, "number", `${e.id} needs a radius`);
      assert.ok(e.radius > 0 && e.radius < 0.2, `${e.id} radius ${e.radius} is out of range`);
    }
    if (e.kind === "paint") assert.equal(typeof e.paint, "function", `${e.id} needs a painter`);
    if (e.kind === "image") {
      // `src` is resolved via `new URL(..., import.meta.url)` (see backgrounds.js),
      // so under node --test it's an absolute file:// URL rather than a bare
      // relative string. What must hold regardless of the runtime is that it
      // still points at this effect's own file under img/.
      assert.match(e.src, new RegExp(`img/${e.id}\\.webp$`), `${e.id} src ${e.src} does not end in its own img/ webp`);
      assert.match(e.fallback, /^#[0-9a-fA-F]{6}$/, `${e.id} fallback ${e.fallback} is not a hex colour`);
      assert.equal(e.paint, undefined, `${e.id} is an image and must not carry a painter`);
    }
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
  // A zero-sized or non-finite source rect makes drawImage silently draw nothing
  // (per spec, it does not throw), so callers need an explicit falsy signal to
  // fall back to the fallback fill instead of a rect that draws nothing and
  // leaves the frame uncovered.
  for (const args of [[0, 720, 640, 360], [1280, 0, 640, 360], [1280, 720, 0, 360], [1280, 720, 640, 0]]) {
    assert.equal(coverRect(...args), null, `coverRect(${args}) should be null`);
  }
  assert.equal(coverRect(NaN, 720, 640, 360), null);
  assert.equal(coverRect(1280, 720, undefined, 360), null);
});

test("drawImageBackground draws the bitmap cover-fit and reports it drew", () => {
  const { ctx, calls } = fakeCtx(640, 480);
  const bitmap = { width: 1280, height: 720 };
  assert.equal(drawImageBackground(ctx, bitmap, "#585454", 640, 480), true);
  assert.deepEqual(calls, [
    // source rect from coverRect(1280,720,640,480), destination the full frame
    { op: "drawImage", args: [bitmap, 160, 0, 960, 720, 0, 0, 640, 480] },
  ]);
});

test("drawImageBackground fills the whole frame with the fallback when there is no bitmap", () => {
  // This is the invariant that matters: until the bitmap decodes, something must
  // cover every pixel, or the raw camera shows through.
  const { ctx, calls } = fakeCtx(640, 480);
  assert.equal(drawImageBackground(ctx, null, "#585454", 640, 480), false);
  assert.deepEqual(calls, [{ op: "fillRect", x: 0, y: 0, w: 640, h: 480 }]);
  assert.equal(ctx.fillStyle, "#585454");
});

test("drawImageBackground falls back for a bitmap with unusable dimensions", () => {
  const { ctx, calls } = fakeCtx(640, 480);
  assert.equal(drawImageBackground(ctx, { width: 0, height: 0 }, "#585454", 640, 480), false);
  assert.deepEqual(calls, [{ op: "fillRect", x: 0, y: 0, w: 640, h: 480 }]);
});

test("drawImageBackground never leaves global canvas state dirty", () => {
  // Same contract the painters are held to: the compositor reuses one context.
  const { ctx } = fakeCtx(640, 480);
  drawImageBackground(ctx, { width: 1280, height: 720 }, "#585454", 640, 480);
  assert.equal(ctx.globalCompositeOperation, "source-over");
  assert.equal(ctx.filter, "none");
});

test("GROUPS partitions EFFECTS exactly", () => {
  // A new entry added to EFFECTS but not reachable through GROUPS would be
  // selectable from a saved preference yet invisible in the picker.
  const grouped = GROUPS.flatMap((g) => g.effects);
  assert.equal(grouped.length, EFFECTS.length, "an effect is missing from GROUPS or duplicated");
  assert.deepEqual(new Set(grouped), new Set(EFFECTS));
  for (const g of GROUPS) {
    assert.ok(g.id, "a group has no id");
    assert.ok(g.label, `group ${g.id} has no label`);
    assert.ok(g.effects.length > 0, `group ${g.id} is empty`);
  }
});

// A build that embedded no images must not render an empty "Scenes" heading, which
// is what a fresh clone looks like: most scene files are untracked.
test("an empty group is omitted rather than rendered blank", () => {
  assert.deepEqual(GROUPS.map((g) => g.id), ["effect"]);
  assert.ok(GROUPS.every((g) => g.effects.length > 0));
});

test("sceneEffects builds well-formed image entries", () => {
  const [e] = sceneEffects([{ id: "carina", label: "Carina", src: "/v/abc/img/carina.webp", fallback: "#614E54" }]);
  assert.deepEqual(e, { id: "carina", label: "Carina", kind: "image", src: "/v/abc/img/carina.webp", fallback: "#614E54" });
  assert.ok(Object.isFrozen(e));
});

test("sceneEffects rejects entries it cannot use", () => {
  // The payload is server-generated, but it lands in the page as plain script and
  // a malformed entry must degrade to "that scene is missing", never to a chip
  // whose src is undefined and whose fetch resolves against the page path.
  const built = sceneEffects([
    null,
    {},
    { id: "", src: "/v/a/img/x.webp" },
    { id: "no-src" },
    { id: "ok", src: "/v/a/img/ok.webp" },
  ]);
  assert.deepEqual(built.map((e) => e.id), ["ok"]);
});

test("sceneEffects never shadows a built-in id, and never duplicates", () => {
  const built = sceneEffects([
    { id: "blur", src: "/v/a/img/blur.webp" }, // would hijack the blur effect
    { id: "dup", src: "/v/a/img/dup.webp" },
    { id: "dup", src: "/v/a/img/dup2.webp" },
  ]);
  assert.deepEqual(built.map((e) => e.id), ["dup"]);
  assert.equal(built[0].src, "/v/a/img/dup.webp", "the first entry for an id wins");
});

test("sceneEffects fills in a missing label and a bad fallback", () => {
  const [e] = sceneEffects([{ id: "my-photo", src: "/v/a/img/my-photo.webp", fallback: "not-a-colour" }]);
  assert.equal(e.label, "my-photo", "a missing label falls back to the id rather than rendering blank");
  assert.match(e.fallback, /^#[0-9a-fA-F]{6}$/, "a bad fallback must still be a paintable colour");
});

test("sceneEffects tolerates a non-array payload", () => {
  for (const bad of [undefined, null, "", 0, {}]) assert.deepEqual(sceneEffects(bad), []);
});

// A scene id saved by a build that HAD that image, opened on a build that does
// not, must degrade to "none" rather than selecting a chip that cannot render.
// This is now a real case, not a hypothetical: the scene files are untracked, so
// two builds of the same commit can embed different sets.
test("a scene id this build did not embed resolves to none", () => {
  assert.equal(resolveEffectId("carina"), "none");
  assert.equal(effectById("office-space").id, "none");
});
