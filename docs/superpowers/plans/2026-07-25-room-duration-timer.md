# Room-Duration Timer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A top-center call-duration timer that counts from when the room started (same for everyone, survives refresh) and reveals/fades with the control bar.

**Architecture:** The server stamps each room with a `startedAt` and sends its current age (seconds) in `joined`; the client counts up from that in a `.call-timer` element. The control-bar autohide is refactored to toggle a shared `body.ui-idle` class so the timer and controls fade together.

**Tech Stack:** Go stdlib (server + `go test`); vanilla ES modules (client, `node --test` for the pure formatter); plain CSS. No new deps.

## Global Constraints

- Server sends the room's **age in seconds** (skew-free), not an absolute timestamp — the client counts up locally so everyone sees the same value.
- Hover-reveal is a **shared `body.ui-idle` class**: the control bar's autohide toggles it; both `.controls` and `.call-timer` fade via CSS from that one class. Preserve the existing "don't hide while a control has focus" guard.
- `go test ./internal/...`, `go vet ./internal/...`, `gofmt -l` clean; JS: `node --check` + `node --test internal/web/test/*.test.js` (use the glob; bare-dir arg fails in this sandbox's Node 22) green.
- Commit messages must NOT include any `Co-Authored-By` trailer.

---

### Task 1: Server — stamp room start, send age in `joined`

**Files:**
- Modify: `internal/signal/messages.go` (`Joined` struct)
- Modify: `internal/room/room.go` (`Room` struct; `New()`; the `Joined` build in `Join`)
- Test: `internal/signal/messages_test.go`, `internal/room/room_test.go`

**Interfaces:**
- Produces: `signal.Joined.RoomAgeSec int64` (`json:"roomAge,omitempty"`); `room.Room.startedAt` (unexported).

- [ ] **Step 1: Write failing tests**

In `internal/room/room_test.go`, add:

```go
func TestJoinedCarriesRoomAge(t *testing.T) {
	now := time.Unix(1000, 0)
	r := New(Config{Slug: "swift", Adhoc: true, Now: func() time.Time { return now }})
	now = time.Unix(1090, 0) // 90s after the room was created
	alice, ac := member("p1", "alice", RoleUser)
	if err := r.Join(alice, ""); err != nil {
		t.Fatal(err)
	}
	joined, ok := ac.msgs[0].(signal.Joined)
	if !ok {
		t.Fatalf("msg[0] = %T, want signal.Joined", ac.msgs[0])
	}
	if joined.RoomAgeSec != 90 {
		t.Errorf("RoomAgeSec = %d, want 90", joined.RoomAgeSec)
	}
}
```

In `internal/signal/messages_test.go`, add a case to `TestEncodeServerMessages`'s `cases` slice:

```go
		{Joined{SelfID: "p1", Role: "op", RoomAgeSec: 90}, "joined", []string{`"roomAge":90`}},
```

and add an omitempty check (extend the existing `TestGravatarOmittedWhenEmpty` style — a new test):

```go
func TestRoomAgeOmittedWhenZero(t *testing.T) {
	raw, err := Encode(Joined{SelfID: "p1", Role: "op"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "roomAge") {
		t.Errorf("Encode(Joined{age:0}) = %s, should omit roomAge", raw)
	}
}
```

- [ ] **Step 2: Run tests — confirm they FAIL**

Run: `go test ./internal/room/ ./internal/signal/`
Expected: FAIL — `Joined` has no `RoomAgeSec` field (compile error).

- [ ] **Step 3: Add the `Joined.RoomAgeSec` field**

In `internal/signal/messages.go`, in the `Joined` struct, add after `Quality`:

```go
	RoomAgeSec int64 `json:"roomAge,omitempty"` // seconds the room has existed, as of this join
```

- [ ] **Step 4: Stamp `startedAt` and send the age**

In `internal/room/room.go`, add a field to `Room` (next to `emptySince`):

```go
	startedAt time.Time // when the room/call began (New); sent as roomAge in Joined
```

In `New()`, add it to the returned struct literal (alongside `cfg: cfg,` etc.):

```go
		startedAt:      cfg.Now(),
```

In `Join`, the `Joined` send (~line 214) becomes:

```go
	p.Conn.Send(signal.Joined{SelfID: p.ID, Role: string(p.Role), Peers: roster, Quality: quality, RoomAgeSec: int64(r.cfg.Now().Sub(r.startedAt).Seconds())})
```

- [ ] **Step 5: Run tests + vet + gofmt**

Run: `go test ./internal/room/ ./internal/signal/ && go vet ./internal/... && gofmt -l internal/room/ internal/signal/`
Expected: PASS, vet clean, `gofmt -l` prints nothing. (If gofmt flags a file, `gofmt -w` it — a struct-field addition can misalign tags; do not hand-align.)

- [ ] **Step 6: Commit**

```bash
git add internal/signal/messages.go internal/room/room.go internal/room/room_test.go internal/signal/messages_test.go
git commit -m "feat(server): stamp room start and send its age in joined"
```

---

### Task 2: Client — `formatDuration` helper + test

**Files:**
- Create: `internal/web/assets/lib/duration.js`
- Test: `internal/web/test/duration.test.js`

**Interfaces:**
- Produces: `formatDuration(sec: number) -> string`.

- [ ] **Step 1: Write the failing test**

Create `internal/web/test/duration.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDuration } from "../assets/lib/duration.js";

test("formatDuration under an hour is M:SS with padded seconds", () => {
  assert.equal(formatDuration(0), "0:00");
  assert.equal(formatDuration(5), "0:05");
  assert.equal(formatDuration(65), "1:05");
  assert.equal(formatDuration(600), "10:00");
  assert.equal(formatDuration(3599), "59:59");
});

test("formatDuration at/after an hour rolls over to H:MM:SS", () => {
  assert.equal(formatDuration(3600), "1:00:00");
  assert.equal(formatDuration(3661), "1:01:01");
  assert.equal(formatDuration(36000), "10:00:00");
});

test("formatDuration clamps negatives and floors fractions", () => {
  assert.equal(formatDuration(-5), "0:00");
  assert.equal(formatDuration(65.9), "1:05");
});
```

- [ ] **Step 2: Run — confirm it FAILS**

Run: `node --test internal/web/test/duration.test.js`
Expected: FAIL — module/`formatDuration` not found.

- [ ] **Step 3: Implement**

Create `internal/web/assets/lib/duration.js`:

```js
// Format an elapsed-seconds count as a clock: "M:SS" normally, "H:MM:SS" once it
// reaches an hour. Negatives clamp to 0 and fractions floor, so it's safe to pass a
// raw (age + elapsed) value straight in.
export function formatDuration(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
```

- [ ] **Step 4: Run — confirm PASS**

Run: `node --test internal/web/test/duration.test.js` then `node --test internal/web/test/*.test.js`
Expected: PASS (new test + the whole suite stays green).

- [ ] **Step 5: Commit**

```bash
git add internal/web/assets/lib/duration.js internal/web/test/duration.test.js
git commit -m "feat(web): add formatDuration helper for the call timer"
```

---

### Task 3: Client — timer element + shared-idle-class autohide

**Files:**
- Modify: `internal/web/assets/app.js` (import; module state; `renderInCall`; `teardownInCall`)
- Modify: `internal/web/assets/ui/controls.js` (`_revealControls`, `_maybeHide`, `destroy`)
- Modify: `internal/web/assets/style.css` (`.controls.is-hidden` → `body.ui-idle .controls`; add `.call-timer` + `body.ui-idle .call-timer`)

**Interfaces:**
- Consumes: `formatDuration` (Task 2); `msg.roomAge` (Task 1).

- [ ] **Step 1: Import `formatDuration` and add timer state in `app.js`**

Add the import alongside app.js's other `./ui`/`./lib` imports (near the top, e.g. after the `Grid` import ~line 29):

```js
import { formatDuration } from "./lib/duration.js";
```

Add a module-level state var next to the other in-call `let`s (e.g. near `let grid = null;`):

```js
let durationTimer = null; // setInterval handle for the call-duration readout
```

- [ ] **Step 2: Create + tick the timer in `renderInCall`**

In `renderInCall(msg)`, the `root.replaceChildren(...)` builds the `.incall` subtree. Add a `.call-timer` child to it (it's absolutely positioned, so order is cosmetic — put it right after the `.call-head` header). Change the `.incall` element's children from:

```js
      el("header", { class: "call-head" }, el("h1", { text: `#${slug}` }), statusEl, mediaAlertEl),
      el("div", { class: "stage" }, grid.el, chat.el),
      controls.el,
```

to add a timer span and capture it:

```js
      el("header", { class: "call-head" }, el("h1", { text: `#${slug}` }), statusEl, mediaAlertEl),
      timerEl,
      el("div", { class: "stage" }, grid.el, chat.el),
      controls.el,
```

Just before the `root.replaceChildren(...)` call, create the element and start the interval:

```js
  // Call-duration readout (top-center, autohides with the control bar via body.ui-idle).
  // The server sends the room's age at join; count up from it with the local clock so
  // everyone converges on the same value and a refresh resumes correctly.
  const timerEl = el("span", { class: "call-timer" });
  const baseAgeSec = Number(msg.roomAge) || 0;
  const startedTick = Date.now();
  const tickTimer = () => {
    timerEl.textContent = formatDuration(baseAgeSec + Math.floor((Date.now() - startedTick) / 1000));
  };
  tickTimer(); // paint immediately so it isn't blank for the first second
  durationTimer = setInterval(tickTimer, 1000);
```

(Place this block above `root.replaceChildren(` so `timerEl` exists when the subtree is built.)

- [ ] **Step 3: Clear the interval in `teardownInCall`**

In `teardownInCall()`, add (e.g. right after `screenWakeLock.disable();`):

```js
  if (durationTimer) {
    clearInterval(durationTimer);
    durationTimer = null;
  }
```

- [ ] **Step 4: Refactor the control-bar autohide to a shared class (`controls.js`)**

`_revealControls` (~226) — reveal by clearing the shared idle class:

```js
  _revealControls() {
    document.body.classList.remove("ui-idle");
    if (this._hideTimer) clearTimeout(this._hideTimer);
    this._hideTimer = setTimeout(() => this._maybeHide(), this._hideDelayMs);
  }
```

`_maybeHide` (~231) — keep the focus guard; hide via the shared class:

```js
  _maybeHide() {
    this._hideTimer = null;
    // Never hide while a control has focus (keyboard users) — reschedule instead.
    if (this.el.contains(document.activeElement)) {
      this._hideTimer = setTimeout(() => this._maybeHide(), this._hideDelayMs);
      return;
    }
    document.body.classList.add("ui-idle");
  }
```

In `destroy()` (~960), so the class never lingers after leaving the call, add (e.g. right after the `_activityEvents` removal loop):

```js
    document.body.classList.remove("ui-idle");
```

- [ ] **Step 5: CSS — shared idle class + `.call-timer` (`style.css`)**

Replace the `.controls.is-hidden` rule (~673):

```css
.controls.is-hidden {
  opacity: 0;
  transform: translateY(100%);
  pointer-events: none;
}
```

with the shared-class form (same declarations):

```css
/* Autohidden state: controls.js toggles body.ui-idle after ~3s of pointer inactivity;
   the control bar and the call timer both fade from this one class. */
body.ui-idle .controls {
  opacity: 0;
  transform: translateY(100%);
  pointer-events: none;
}
```

Add, near the `.call-head` rules (~293), the timer styling:

```css
/* Call-duration readout: floats top-center over the video, autohides with the
   control bar (body.ui-idle). Purely visual — clicks fall through to the tiles. */
.call-timer {
  position: absolute;
  top: 0.5rem;
  left: 50%;
  transform: translateX(-50%);
  z-index: 15;
  padding: 0.15rem 0.6rem;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.55);
  color: var(--fg);
  font-size: 0.85rem;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
  transition: opacity 0.2s ease;
}
body.ui-idle .call-timer {
  opacity: 0;
}
```

- [ ] **Step 6: Verify (syntax + suite)**

Run: `node --check internal/web/assets/app.js && node --check internal/web/assets/ui/controls.js && node --test internal/web/test/*.test.js`
Expected: `--check` silent on both; suite green.

- [ ] **Step 7: Manual browser check (note as pending for the controller)**

In a call: a timer sits top-center counting up (`0:03`, `1:05`, …); moving the pointer reveals both the timer and the control bar, and after ~3s idle they fade together; a refresh resumes the timer near where it was (not back to 0); leaving the call stops it. (No browser needed from the implementer — note pending.)

- [ ] **Step 8: Commit** (NO `Co-Authored-By` trailer)

```bash
git add internal/web/assets/app.js internal/web/assets/ui/controls.js internal/web/assets/style.css
git commit -m "feat(web): top-center call-duration timer that autohides with the controls"
```

---

## Self-Review

**Spec coverage:**
- `Room.startedAt` + `Joined.RoomAgeSec` (age, skew-free) + build site → Task 1.
- `formatDuration` (M:SS / H:MM:SS / clamp) → Task 2.
- Timer element, read `roomAge`, 1s tick, teardown → Task 3 Steps 1–3.
- Shared `body.ui-idle` autohide (reveal/hide/destroy) preserving the focus guard → Task 3 Step 4.
- CSS: `.controls.is-hidden` → `body.ui-idle .controls`, `.call-timer` + faded state → Task 3 Step 5.
- Tests: Go roomAge + omitempty; JS formatDuration → Tasks 1, 2.

**Placeholder scan:** No TBD/TODO; every step has complete code, exact commands, and expected results.

**Type consistency:** `RoomAgeSec int64` / `json:"roomAge"` consistent across `messages.go`, the room build, and the client's `msg.roomAge`; `formatDuration(sec)` signature matches its import and call site; `body.ui-idle` class name identical across controls.js and the CSS; `durationTimer` used consistently in `renderInCall`/`teardownInCall`.
