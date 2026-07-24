# Confirm Dialog for Kick/Ban Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require a confirmation dialog before the destructive kick and ban moderation actions; leave the reversible actions one-click.

**Architecture:** A reusable promise-based `confirmDialog()` in `lib/confirm.js` built on the native `<dialog>` element (free backdrop/focus-trap/Escape). `controls.js` awaits it before sending `kick`/`ban`. Styling matches the app's dark UI.

**Tech Stack:** Vanilla ES modules (browser client), plain CSS, native `<dialog>`. No new dependencies, no build step.

## Global Constraints

- Dependency-free vanilla ES modules; no build step; no new npm packages.
- Developer-authored text only — dialog text is set via `textContent`, never `innerHTML`.
- Scope: kick + ban only. Mute, make-op (`grant-op`), and stop-screenshare stay one-click.
- Client-side pre-send guard only — no protocol/server/media change; the wire messages are identical once confirmed.
- Dialog DOM has no unit test (needs a real browser for `<dialog>.showModal()`); verification is `node --check` + a module-load smoke test + the `node --test internal/web/test/*.test.js` suite staying green (use the `*.test.js` glob; bare-dir arg fails in this sandbox's Node 22) + manual.
- Commit messages must NOT include any `Co-Authored-By` trailer.
- Color vars available: `--bg #14161a`, `--panel #1d2026`, `--fg #e6e8ec`, `--muted #9aa1ac`, `--error #ff6b6b`, `--border #2b2f37`. `<button>` has a generic base style already (style.css ~107).

---

### Task 1: Reusable `confirmDialog()` + styling

**Files:**
- Create: `internal/web/assets/lib/confirm.js`
- Modify: `internal/web/assets/style.css` (append the dialog rules)

**Interfaces:**
- Produces: `confirmDialog({ title, message?, confirmLabel?, tone? }) -> Promise<boolean>`.

- [ ] **Step 1: Create `internal/web/assets/lib/confirm.js`**

```js
// A reusable modal confirmation built on the native <dialog> element, which provides the
// backdrop, focus trapping, and Escape-to-cancel for free. Promise-based: resolves true
// if the user confirms, false on cancel / Escape / backdrop click. Developer-authored
// text only (set via textContent, never innerHTML).
//
//   if (await confirmDialog({ title: "Ban alice?", message: "…", confirmLabel: "Ban", tone: "danger" })) { … }
export function confirmDialog({ title, message = "", confirmLabel = "Confirm", tone } = {}) {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "confirm-dialog";

    const h = document.createElement("h2");
    h.className = "confirm-title";
    h.textContent = title || "";
    dialog.appendChild(h);

    if (message) {
      const p = document.createElement("p");
      p.className = "confirm-message";
      p.textContent = message;
      dialog.appendChild(p);
    }

    const row = document.createElement("div");
    row.className = "confirm-actions";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "confirm-cancel";
    cancel.textContent = "Cancel";
    cancel.autofocus = true; // safe default: Enter/Escape cancel a destructive prompt

    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "confirm-ok" + (tone === "danger" ? " danger" : "");
    ok.textContent = confirmLabel;

    row.append(cancel, ok);
    dialog.appendChild(row);
    document.body.appendChild(dialog);

    let done = false;
    const settle = (result) => {
      if (done) return;
      done = true;
      resolve(result);
      dialog.close(); // fires "close"; DOM cleanup happens there
    };

    cancel.addEventListener("click", () => settle(false));
    ok.addEventListener("click", () => settle(true));
    // Escape: <dialog> fires "cancel" (then "close"). Treat as a negative answer.
    dialog.addEventListener("cancel", (e) => { e.preventDefault(); settle(false); });
    // Backdrop click: the click's target is the <dialog> element itself, not a child.
    dialog.addEventListener("click", (e) => { if (e.target === dialog) settle(false); });
    // However it closed, resolve (no-op if already settled) and remove it.
    dialog.addEventListener("close", () => { settle(false); dialog.remove(); });

    dialog.showModal();
  });
}
```

- [ ] **Step 2: Add the dialog styling**

In `internal/web/assets/style.css`, append (e.g. after the `.op-actions .op.makeop` rule, ~line 600):

```css
/* Reusable confirmation modal (native <dialog>): a dark card over a dim backdrop.
   Buttons inherit the generic <button> style; .danger paints the confirm action red. */
.confirm-dialog {
  margin: auto; /* center in the top layer */
  max-width: 22rem;
  width: calc(100% - 2rem);
  padding: 1.1rem 1.2rem 1rem;
  background: var(--panel);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 12px;
}
.confirm-dialog::backdrop {
  background: rgba(0, 0, 0, 0.55);
}
.confirm-title {
  margin: 0 0 0.4rem;
  font-size: 1rem;
}
.confirm-message {
  margin: 0 0 1rem;
  color: var(--muted);
  font-size: 0.9rem;
}
.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}
.confirm-ok.danger {
  background: var(--error);
  border-color: var(--error);
  color: var(--bg);
  font-weight: 600;
}
```

- [ ] **Step 3: Syntax-check and smoke-test the module**

Run:
```
node --check internal/web/assets/lib/confirm.js
node --input-type=module -e 'import("./internal/web/assets/lib/confirm.js").then(m=>{const ok=typeof m.confirmDialog==="function";console.log(ok?"confirm.js OK":"MISSING EXPORT");process.exit(ok?0:1)})'
```
Expected: `--check` silent; prints `confirm.js OK`. (confirm.js only touches `document` inside the function body, not at load, so it imports cleanly under Node.)

- [ ] **Step 4: Run the suite (unaffected)**

Run: `node --test internal/web/test/*.test.js`
Expected: green (nothing tested changed).

- [ ] **Step 5: Commit**

```bash
git add internal/web/assets/lib/confirm.js internal/web/assets/style.css
git commit -m "feat(web): add reusable confirmDialog() modal (native <dialog>)"
```

---

### Task 2: Gate kick + ban behind the confirmation

**Files:**
- Modify: `internal/web/assets/ui/controls.js` (import ~28; `opActionsFor` ~773–792)

**Interfaces:**
- Consumes: `confirmDialog` from `../lib/confirm.js` (Task 1).

- [ ] **Step 1: Import `confirmDialog`**

After the existing imports (line 28), add:

```js
import { confirmDialog } from "../lib/confirm.js";
```

- [ ] **Step 2: Extract the target name in `opActionsFor`**

Just after `const id = participant.id;` (~line 775), add:

```js
    const name = participant.name || "this participant";
```

- [ ] **Step 3: Confirm-gate the kick and ban buttons**

Replace the kick button line (~787):

```js
      el("button", { type: "button", class: "op kick", title: "Kick", onClick: () => this._send("kick", { id }) }, "kick"),
```

with:

```js
      el("button", {
        type: "button", class: "op kick", title: "Kick",
        onClick: async () => {
          if (await confirmDialog({ title: `Kick ${name}?`, message: "They'll be removed from the call.", confirmLabel: "Kick", tone: "danger" })) {
            this._send("kick", { id });
          }
        },
      }, "kick"),
```

Replace the ban button line (~789):

```js
      el("button", { type: "button", class: "op ban", title: "Ban", onClick: () => this._send("ban", { id }) }, "ban"),
```

with:

```js
      el("button", {
        type: "button", class: "op ban", title: "Ban",
        onClick: async () => {
          if (await confirmDialog({ title: `Ban ${name}?`, message: "They'll be removed and blocked from rejoining.", confirmLabel: "Ban", tone: "danger" })) {
            this._send("ban", { id });
          }
        },
      }, "ban"),
```

Leave the `makeop` (`grant-op`) and `mute` (`mute-peer`) buttons exactly as they are.

- [ ] **Step 4: Syntax-check and run the suite**

Run: `node --check internal/web/assets/ui/controls.js && node --test internal/web/test/*.test.js`
Expected: `--check` silent; suite green.

- [ ] **Step 5: Manual browser check (note as pending for the controller)**

As an op, click Kick and Ban on a remote tile: the dark confirm dialog appears naming the participant; Confirm removes them (action sent); Cancel, Escape, and clicking the dim backdrop all close it with NO action sent. The mute / +op / stop-screenshare buttons still act immediately. (No browser needed from the implementer — note pending.)

- [ ] **Step 6: Commit**

```bash
git add internal/web/assets/ui/controls.js
git commit -m "feat(web): confirm before kick/ban"
```

---

## Self-Review

**Spec coverage:**
- Reusable `<dialog>`-based `confirmDialog()` (promise, cancel-default-focus, Escape/backdrop → false, self-removing) → Task 1 Step 1.
- Dark-card styling + dim backdrop + danger confirm button → Task 1 Step 2.
- kick + ban gated; mute/+op/stop-share unchanged → Task 2 Step 3.
- textContent-only (no innerHTML) → Task 1 Step 1 (uses `textContent`).
- Testing = node --check + smoke + suite + manual → each task's verify steps.

**Placeholder scan:** No TBD/TODO; every step has complete code + exact paths/anchors.

**Type consistency:** `confirmDialog` signature (`{title, message?, confirmLabel?, tone?}` → `Promise<boolean>`) identical between `confirm.js`, its import, and both call sites; `.confirm-dialog`/`.confirm-ok.danger`/`.confirm-actions` class names consistent between confirm.js and the CSS.
