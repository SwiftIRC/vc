# In-call ☰ Settings Menu + On-the-fly Rename — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate settings-type controls into a ☰ menu and let anyone change their display name mid-call.

**Architecture:** A `rename {name}` → `peer-renamed {id,name}` pair mirrors the `media-state → peer-media-state` flow (server sanitizes + stores + broadcasts). The client applies renames to tiles and, for self, keeps `selfName`/`pendingJoin.name`/`localStorage` in sync so a rename survives reconnect. A new ☰ button opens a settings popover that houses the moved controls (reusing their handlers) plus a Rename row. Rename is display-only — account/role stay from the verified token.

**Tech Stack:** Go (signal/room/server, `go test`); vanilla ES-module client (`node --check`, `node --test`); existing `.share-menu` popover + `.ctl` CSS.

## Global Constraints

- **Rename is display-only.** `p.Account` and `p.Role` are never changed by a rename; only `p.Name`. Everyone (guest or identified) may rename.
- **Reconnect-safe.** The server resolves a participant's display name via `displayName(join.Name, claims)`: a non-empty client-sent name wins (sanitized); it falls back to `claims.Nick` only when the client sent none. Account/role always come from the verified token.
- **Sanitization is server-authoritative** via the existing `sanitizeName` (strips control chars, collapses whitespace, caps 24 runes). Empty/whitespace/unchanged renames are no-ops (never "guest").
- **Broadcast to ALL** (`excludeID=""`) so the sender renders the sanitized result.
- Moved controls **reuse their existing handlers/state-setters**; only their DOM presentation moves into the menu. Op rows (Lock, Quality) are role-gated. The "Room locked" *indicator* stays on the bar.
- Commits carry NO `Co-Authored-By` trailer. `go build ./... && go vet ./... && go test ./...` and `node --check` + `node --test internal/web/test/*.test.js` (glob, from repo root) stay green.

---

## File Structure

- `internal/signal/messages.go` — `Rename`, `PeerRenamed`, decode `"rename"`, encode `"peer-renamed"`. *(T1)*
- `internal/signal/messages_test.go` — round-trip cases. *(T1)*
- `internal/room/room.go` — `Rename` method. *(T1)*
- `internal/room/rename_test.go` (new) — `Rename` broadcast + no-op tests. *(T1)*
- `internal/server/server.go` — `displayName` helper; `serve()` name resolution + Rename routing; `dispatch` Rename case. *(T1)*
- `internal/server/server_test.go` — `displayName` table test. *(T1)*
- `internal/web/assets/lib/prefs.js` — export `loadName`/`saveName`. *(T2)*
- `internal/web/assets/ui/prejoin.js` — import name helpers from prefs. *(T2)*
- `internal/web/assets/ui/grid.js` — `setPeerName`. *(T2)*
- `internal/web/assets/app.js` — `peer-renamed` handler; import `saveName`. *(T2)*
- `internal/web/assets/ui/controls.js` — the ☰ menu restructure *(T3)* + rename row *(T4)*.
- `internal/web/assets/style.css` — settings-menu row styles. *(T3)*

Order: T1 (backend) → T2 (client plumbing) → T3 (☰ menu) → T4 (rename row, consumes all).

---

### Task 1: Rename protocol + server

**Files:**
- Modify: `internal/signal/messages.go`, `internal/signal/messages_test.go`
- Modify: `internal/room/room.go`; Create: `internal/room/rename_test.go`
- Modify: `internal/server/server.go`, `internal/server/server_test.go`

**Interfaces:**
- Produces: `signal.Rename{Name}` (`"rename"`), `signal.PeerRenamed{ID,Name}` (`"peer-renamed"`); `room.Rename(id, name string)`; `server.displayName(joinName string, claims *token.Claims) string`.

- [ ] **Step 1: Add signal round-trip test cases (RED)**

In `internal/signal/messages_test.go`, add to the `TestDecodeClientMessages` table (after the `media-state` cases):

```go
		{`{"type":"rename","name":"bob"}`, &Rename{Name: "bob"}},
```

and to the `TestEncodeServerMessages` table (after the `PeerMediaState` case):

```go
		{PeerRenamed{ID: "p2", Name: "bob"}, "peer-renamed", []string{`"id":"p2"`, `"name":"bob"`}},
```

- [ ] **Step 2: Run signal tests — expect FAIL (undefined: Rename / PeerRenamed)**

Run: `go test ./internal/signal/`
Expected: compile error / FAIL — `Rename` and `PeerRenamed` are undefined.

- [ ] **Step 3: Add the types + decode + encode**

In `internal/signal/messages.go`, add the client type near `MediaState`:

```go
// Rename is a participant changing its OWN display name mid-call (display-only —
// the server keeps the account/role from the join token untouched).
type Rename struct {
	Name string `json:"name"`
}
```

add the server type near `PeerMediaState`:

```go
// PeerRenamed tells every client (the sender included) a peer's display name changed.
type PeerRenamed struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}
```

add to the decode switch (after `case "media-state":`):

```go
	case "rename":
		v = &Rename{}
```

and to `serverTypeName` (after the `PeerMediaState` case):

```go
	case PeerRenamed, *PeerRenamed:
		return "peer-renamed", nil
```

- [ ] **Step 4: Run signal tests — expect PASS**

Run: `go test ./internal/signal/`
Expected: PASS.

- [ ] **Step 5: Add room.Rename tests (RED)**

Create `internal/room/rename_test.go`:

```go
package room

import (
	"testing"

	"github.com/ryanwohara/webrtc-chat/internal/signal"
)

func lastRenamed(c *fakeConn) (signal.PeerRenamed, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for i := len(c.msgs) - 1; i >= 0; i-- {
		if m, ok := c.msgs[i].(signal.PeerRenamed); ok {
			return m, true
		}
	}
	return signal.PeerRenamed{}, false
}

func countRenamed(c *fakeConn) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := 0
	for _, m := range c.msgs {
		if _, ok := m.(signal.PeerRenamed); ok {
			n++
		}
	}
	return n
}

func TestRenameBroadcastsToAll(t *testing.T) {
	r := New(Config{Slug: "s", Adhoc: true})
	alice, ac := member("p1", "alice", RoleUser)
	bob, bc := member("p2", "bob", RoleUser)
	if err := r.Join(alice, ""); err != nil {
		t.Fatal(err)
	}
	if err := r.Join(bob, ""); err != nil {
		t.Fatal(err)
	}
	r.Rename("p1", "alice2")
	for who, c := range map[string]*fakeConn{"alice": ac, "bob": bc} {
		m, ok := lastRenamed(c)
		if !ok || m.ID != "p1" || m.Name != "alice2" {
			t.Errorf("%s: got %+v ok=%v, want {p1 alice2}", who, m, ok)
		}
	}
	if alice.Name != "alice2" {
		t.Errorf("participant name = %q, want alice2", alice.Name)
	}
}

func TestRenameNoOpOnUnchangedEmptyMissing(t *testing.T) {
	r := New(Config{Slug: "s", Adhoc: true})
	alice, ac := member("p1", "alice", RoleUser)
	if err := r.Join(alice, ""); err != nil {
		t.Fatal(err)
	}
	before := countRenamed(ac)
	r.Rename("p1", "alice") // unchanged
	r.Rename("p1", "")      // empty
	r.Rename("nope", "x")   // missing participant
	if got := countRenamed(ac); got != before {
		t.Errorf("no-op renames broadcast %d PeerRenamed, want 0", got-before)
	}
}
```

- [ ] **Step 6: Run — expect FAIL (undefined: r.Rename)**

Run: `go test ./internal/room/ -run TestRename`
Expected: compile error / FAIL — `r.Rename` undefined.

- [ ] **Step 7: Add room.Rename**

In `internal/room/room.go`, add near `SetMediaState` (mirrors it exactly):

```go
// Rename changes a participant's display name and tells everyone (the sender
// included, so it renders the sanitized result). No-op if the participant is gone
// or the name is empty/unchanged. Display-only: Account and Role are untouched.
func (r *Room) Rename(id, name string) {
	r.mu.Lock()
	p, ok := r.parts[id]
	if !ok || name == "" || name == p.Name {
		r.mu.Unlock()
		return
	}
	p.Name = name
	r.mu.Unlock()
	r.Broadcast(signal.PeerRenamed{ID: id, Name: name}, "")
}
```

- [ ] **Step 8: Run — expect PASS**

Run: `go test ./internal/room/ -run TestRename`
Expected: PASS.

- [ ] **Step 9: Add displayName test (RED)**

In `internal/server/server_test.go`, add (imports `token` — the package already lives at `github.com/ryanwohara/webrtc-chat/internal/token`; add the import if the test file lacks it):

```go
func TestDisplayName(t *testing.T) {
	cl := &token.Claims{Nick: "alice"}
	cases := []struct {
		desc, join string
		claims     *token.Claims
		want       string
	}{
		{"guest empty -> guest", "", nil, "guest"},
		{"guest name -> sanitized", "  Bob ", nil, "Bob"},
		{"token empty -> nick", "", cl, "alice"},
		{"token whitespace -> nick", "   ", cl, "alice"},
		{"token name wins (rename survives reconnect)", "Bobby", cl, "Bobby"},
	}
	for _, c := range cases {
		if got := displayName(c.join, c.claims); got != c.want {
			t.Errorf("%s: displayName(%q, claims) = %q, want %q", c.desc, c.join, got, c.want)
		}
	}
}
```

- [ ] **Step 10: Run — expect FAIL (undefined: displayName)**

Run: `go test ./internal/server/ -run TestDisplayName`
Expected: compile error / FAIL.

- [ ] **Step 11: Add displayName + wire serve() + dispatch**

In `internal/server/server.go`, add the helper near `sanitizeName`:

```go
// displayName resolves a joiner's display name. A non-empty client-sent name wins
// (sanitized) so a rename survives a reconnect; it falls back to the token's verified
// nick only when the client sent none. Guests (claims == nil) always use their sent
// name (sanitizeName maps empty -> "guest").
func displayName(joinName string, claims *token.Claims) string {
	if strings.TrimSpace(joinName) != "" {
		return sanitizeName(joinName)
	}
	if claims != nil {
		return claims.Nick
	}
	return sanitizeName(joinName)
}
```

In `serve()`, replace the name/role assignment block:

```go
	if claims != nil {
		p.Name, p.Account, p.Role = claims.Nick, claims.Account, roleFromClaim(claims.Role)
	} else {
		p.Name, p.Role = sanitizeName(join.Name), room.RoleGuest
	}
```

with:

```go
	if claims != nil {
		p.Account, p.Role = claims.Account, roleFromClaim(claims.Role)
	} else {
		p.Role = room.RoleGuest
	}
	p.Name = displayName(join.Name, claims) // client-sent name wins (rename-safe); falls back to token nick
```

Add `*signal.Rename` to the `serve()` type-switch that routes to `dispatch` (the `case *signal.Chat, *signal.SetLock, … , *signal.MediaState:` line):

```go
		case *signal.Chat, *signal.SetLock, *signal.Kick, *signal.MutePeer, *signal.Ban, *signal.GrantOp, *signal.SetQuality, *signal.Countdown, *signal.MediaState, *signal.Rename:
```

And in `dispatch`, add a case next to `MediaState` (self-action, no error reply):

```go
	case *signal.Rename:
		name := strings.TrimSpace(m.Name)
		if name == "" { // empty submit = cancel
			return
		}
		rm.Rename(p.ID, sanitizeName(name))
		return
```

- [ ] **Step 12: Run server tests + full build/vet/test — expect PASS**

Run:
```
go test ./internal/server/ -run TestDisplayName
go build ./... && go vet ./... && go test ./...
```
Expected: `TestDisplayName` PASS; build/vet clean; all packages green.

- [ ] **Step 13: Commit**

```bash
git add internal/signal/messages.go internal/signal/messages_test.go internal/room/room.go internal/room/rename_test.go internal/server/server.go internal/server/server_test.go
git commit -m "feat(rename): rename/peer-renamed protocol, room.Rename, reconnect-safe display name"
```

---

### Task 2: Client name plumbing

Makes renames from others land on tiles, and keeps the self name coherent (tile, reconnect frame, storage). No trigger UI yet (Task 4).

**Files:**
- Modify: `internal/web/assets/lib/prefs.js`, `internal/web/assets/ui/prejoin.js`, `internal/web/assets/ui/grid.js`, `internal/web/assets/app.js`

**Interfaces:**
- Produces: `loadName()`, `saveName(name)` (from `lib/prefs.js`); `grid.setPeerName(id, name)`.
- Consumes: `signal` `peer-renamed` (Task 1).

- [ ] **Step 1: Add name helpers to `lib/prefs.js`**

Append to `internal/web/assets/lib/prefs.js`:

```js
// The typed display name, persisted across visits (shared by the lobby and the in-call
// rename). localStorage can throw (private mode / storage off), so guard it.
const NAME_KEY = "swiftirc-vc-name";
export function loadName() {
  try {
    return localStorage.getItem(NAME_KEY) || "";
  } catch {
    return "";
  }
}
export function saveName(name) {
  try {
    if (name) localStorage.setItem(NAME_KEY, name);
  } catch {
    /* storage unavailable — ignore */
  }
}
```

- [ ] **Step 2: Point prejoin at the shared helpers**

In `internal/web/assets/ui/prejoin.js`: extend the prefs import to include the name helpers, delete the local `NAME_KEY`/`loadSavedName`/`saveName` definitions, and rename the one `loadSavedName()` call site to `loadName()`.

Import line becomes:

```js
import { loadMediaPrefs, saveMediaPrefs, loadName, saveName } from "../lib/prefs.js";
```

Delete these local definitions (the `NAME_KEY` const and both functions):

```js
const NAME_KEY = "swiftirc-vc-name";
// loadSavedName / saveName persist the typed display name across visits.
// localStorage can throw (private mode, disabled storage), so guard it.
function loadSavedName() {
  try {
    return localStorage.getItem(NAME_KEY) || "";
  } catch {
    return "";
  }
}
function saveName(name) {
  try {
    if (name) localStorage.setItem(NAME_KEY, name);
  } catch {
    /* ignore */
  }
}
```

Then change the single `loadSavedName()` call to `loadName()`. (The `saveName(...)` call sites keep the same name — now the imported one.)

- [ ] **Step 3: Add `grid.setPeerName`**

In `internal/web/assets/ui/grid.js`, add near `setPeerRole` (grid.js:480):

```js
  // Update a participant's display name from a peer-renamed broadcast. Works for self
  // too — keeps this.selfName in sync so the self label, the "(name) (screen)" tile,
  // and the reconnect join frame all reflect the new name. _setName handles the "(you)"
  // suffix and the screen tile via the tile's data-id.
  setPeerName(id, name) {
    if (id === this.selfId) this.selfName = name;
    const tile = this.tiles.get(id);
    if (tile) this._setName(tile, name);
  }
```

- [ ] **Step 4: Handle `peer-renamed` in `app.js`**

Extend the prefs import in `internal/web/assets/app.js` (the `import { loadLayoutPrefs, saveLayoutPrefs } from "./lib/prefs.js";` line) to also import `saveName`:

```js
import { loadLayoutPrefs, saveLayoutPrefs, saveName } from "./lib/prefs.js";
```

Register the handler alongside the other `signaling.on(...)` calls in `renderInCall` (near the `peer-media-state` handler):

```js
  signaling.on("peer-renamed", (m) => {
    if (!grid || !m) return;
    grid.setPeerName(m.id, m.name);
    if (m.id === grid.selfId) {
      selfName = m.name;
      if (pendingJoin) pendingJoin.name = m.name; // so a reconnect re-sends the new name
      saveName(m.name);                            // persist for the next visit
    }
  });
```

- [ ] **Step 5: Verify — syntax, prefs exports, suite**

Run:
```
node --check internal/web/assets/lib/prefs.js
node --check internal/web/assets/ui/prejoin.js
node --check internal/web/assets/ui/grid.js
node --check internal/web/assets/app.js
node --input-type=module -e 'import("./internal/web/assets/lib/prefs.js").then(m=>{const ok=typeof m.loadName==="function"&&typeof m.saveName==="function";console.log(ok?"name helpers OK":"MISSING");process.exit(ok?0:1)})'
node --test internal/web/test/*.test.js
```
Expected: `--check` silent; prints `name helpers OK`; suite green.

- [ ] **Step 6: Commit**

```bash
git add internal/web/assets/lib/prefs.js internal/web/assets/ui/prejoin.js internal/web/assets/ui/grid.js internal/web/assets/app.js
git commit -m "feat(web): apply peer-renamed to tiles; share name persistence; keep self name in sync"
```

---

### Task 3: The ☰ settings menu restructure

Move Noise-suppression, Data-saver, Hide-self, Camera-columns, and (op) Lock + Quality off the bar into a single ☰ popover, reusing their handlers. Pure client refactor; no protocol/rename yet.

**Files:**
- Modify: `internal/web/assets/ui/controls.js`, `internal/web/assets/style.css`

**Interfaces:**
- Produces: `this.settingsBtn`, `this.settingsMenu`, `this.settingsWrap`, `_settingsRow`, `_toggleSettingsMenu`, `_ensureOpSettingsRows`; keeps `grid.addOpControls()` call in `becomeOp`.

- [ ] **Step 1: Add the row helper + settings toggler**

In `internal/web/assets/ui/controls.js`, add two methods (near `_toggleColsMenu`):

```js
  // A labelled settings-menu row: a text label plus its control (a toggle button, a
  // segmented group, or the quality selects).
  _settingsRow(label, control) {
    return el("div", { class: "settings-item" }, el("span", { class: "si-label", text: label }), control);
  }

  _toggleSettingsMenu() {
    const open = this.settingsMenu.hidden;
    this._closeMenus();
    if (open) {
      this.settingsMenu.hidden = false;
      this.settingsBtn.setAttribute("aria-expanded", "true");
    }
  }
```

- [ ] **Step 2: Replace the columns popover with an inline segmented group + build the ☰ menu**

In `_build`, DELETE the columns popover block (the `this.colsBtn` / `this.colsMenu` / `this.colsWrap` / `this._markColsActive()` group):

```js
    // Camera-grid columns: Auto or a fixed 2/3/4, chosen from a small menu.
    this.colsBtn = el(
      "button",
      { type: "button", class: "ctl cols icon", title: "Camera columns", "aria-label": "Camera columns", "aria-haspopup": "menu", "aria-expanded": "false", onClick: () => this._toggleColsMenu() },
      el("span", { class: "glyph", text: "▦" }), // ▦
    );
    this.colsMenu = el(
      "div",
      { class: "share-menu cols-menu", hidden: true },
      ...COLS_OPTIONS.map((opt) =>
        el("button", { type: "button", class: "share-item cols-item", "data-cols": String(opt.value ?? "auto"), onClick: () => this._pickCols(opt.value) }, opt.label),
      ),
    );
    this.colsWrap = el("div", { class: "share-wrap" }, this.colsBtn, this.colsMenu);
    this._markColsActive();
```

and REPLACE it with ONLY the inline segmented columns group (`this.colsSeg`). The `nsBtn`, `hideSelfBtn`, `lowBwBtn` builds elsewhere in `_build` stay unchanged — they become the menu rows' controls; the ☰ menu itself is assembled in the next step, *after* those buttons exist. Do NOT call `_markColsActive()` here (it moves to the menu build):

```js
    // Camera columns as an inline segmented group (reuses _pickCols/_markColsActive),
    // placed into the ☰ menu below.
    this.colsSeg = el(
      "div",
      { class: "seg cols-seg" },
      ...COLS_OPTIONS.map((opt) =>
        el("button", { type: "button", class: "share-item cols-item", "data-cols": String(opt.value ?? "auto"), onClick: () => this._pickCols(opt.value) }, opt.label),
      ),
    );
```

**Then build the ☰ button + menu AFTER the low-bandwidth button exists** — insert this immediately after the `this.lowBwBtn = …` / `this._setLowBwButton();` pair in `_build` (so every row's control — `hideSelfBtn`, `nsBtn`, `lowBwBtn`, `colsSeg` — is already built):

```js
    // ☰ settings menu: houses the low-frequency controls so the bar stays lean. Built
    // here, after nsBtn/hideSelfBtn/lowBwBtn/colsSeg all exist.
    this.settingsBtn = el(
      "button",
      { type: "button", class: "ctl settings icon", title: "Settings", "aria-label": "Settings", "aria-haspopup": "menu", "aria-expanded": "false", onClick: () => this._toggleSettingsMenu() },
      el("span", { class: "glyph", text: "☰" }),
    );
    this.settingsMenu = el(
      "div",
      { class: "share-menu settings-menu", hidden: true },
      this._settingsRow("Hide self", this.hideSelfBtn),
      this._settingsRow("Noise suppression", this.nsBtn),
      this._settingsRow("Data saver", this.lowBwBtn),
      this._settingsRow("Columns", this.colsSeg),
    );
    this.settingsWrap = el("div", { class: "share-wrap" }, this.settingsBtn, this.settingsMenu);
    this._markColsActive();
```

- [ ] **Step 3: Update the `children` array and gate op rows into the menu**

Replace the `children` assembly + op block at the end of `_build`:

```js
    const children = [this.micWrap, this.cameraWrap, this.deafenBtn, this.shareWrap, this.nsBtn, this.colsWrap, this.hideSelfBtn, this.lowBwBtn, this.countdownBtn, this.chatBtn];
    if (this.isOp) {
      this.lockBtn = el("button", { type: "button", class: "ctl lock", onClick: () => this._toggleLock() });
      this._setLockButton(false);
      children.push(this.lockBtn, this._buildQualityControl());
    }
    children.push(this.lockStatus, leaveBtn);

    this.el = el("div", { class: "controls" }, ...children);
  }
```

with:

```js
    const children = [this.micWrap, this.cameraWrap, this.deafenBtn, this.shareWrap, this.countdownBtn, this.chatBtn, this.settingsWrap, this.lockStatus, leaveBtn];
    this.el = el("div", { class: "controls" }, ...children);
    if (this.isOp) this._ensureOpSettingsRows(); // append Lock + Quality rows to the ☰ menu
  }
```

- [ ] **Step 4: Add `_ensureOpSettingsRows` and make `becomeOp` use it; inline the quality control**

Replace `becomeOp` with:

```js
  becomeOp() {
    if (this.isOp) return;
    this.isOp = true;
    this._ensureOpSettingsRows();
    if (this.grid) this.grid.addOpControls();
  }

  // Add the op-only Lock + Quality rows to the ☰ menu, once. Called from _build (if the
  // join role is op) and from becomeOp (mid-call promotion).
  _ensureOpSettingsRows() {
    if (!this.lockBtn) {
      this.lockBtn = el("button", { type: "button", class: "ctl lock", onClick: () => this._toggleLock() });
      this._setLockButton(!!this.locked);
      this.settingsMenu.append(this._settingsRow("Lock room", this.lockBtn));
    }
    if (!this.qualityRow) {
      this.qualityRow = this._settingsRow("Quality", this._buildQualityControl());
      this.settingsMenu.append(this.qualityRow);
    }
  }
```

Replace `_buildQualityControl` (drop the popover button/menu; return the inline selects) — and delete `_toggleQualityMenu`:

```js
  _buildQualityControl() {
    this.qCameraSelect = el("select", { class: "device", "aria-label": "Camera quality", onChange: () => this._send("set-quality", { target: "camera", tier: this.qCameraSelect.value }) });
    this.qScreenSelect = el("select", { class: "device", "aria-label": "Screenshare quality", onChange: () => this._send("set-quality", { target: "screen", tier: this.qScreenSelect.value }) });
    for (const sel of [this.qCameraSelect, this.qScreenSelect]) {
      for (const t of QUALITY_TIERS) sel.append(el("option", { value: t.id, text: t.label }));
    }
    this.setQualityState(this._qCam, this._qScr); // reflect whatever we already know
    return el(
      "div",
      { class: "quality-inline" },
      el("label", { class: "field" }, el("span", { text: "Cam" }), this.qCameraSelect),
      el("label", { class: "field" }, el("span", { text: "Screen" }), this.qScreenSelect),
    );
  }
```

- [ ] **Step 5: Update `_closeMenus`, the outside-pointer handler, and remove `_toggleColsMenu`**

Replace `_closeMenus` (drop the now-gone cols/quality popovers; add the settings menu):

```js
  _closeMenus() {
    if (this.shareMenu) this.shareMenu.hidden = true;
    if (this.micMenu) this.micMenu.hidden = true;
    if (this.cameraMenu) this.cameraMenu.hidden = true;
    if (this.settingsMenu) this.settingsMenu.hidden = true;
    if (this.micArrow) this.micArrow.setAttribute("aria-expanded", "false");
    if (this.cameraArrow) this.cameraArrow.setAttribute("aria-expanded", "false");
    if (this.settingsBtn) this.settingsBtn.setAttribute("aria-expanded", "false");
  }
```

In the outside-`pointerdown` handler, DELETE the `colsMenu` and `qualityMenu` blocks and add a settings block:

```js
      if (this.settingsMenu && !this.settingsMenu.hidden && this.settingsWrap && !this.settingsWrap.contains(e.target)) {
        this.settingsMenu.hidden = true;
        this.settingsBtn.setAttribute("aria-expanded", "false");
      }
```

DELETE the now-unused `_toggleColsMenu` method.

Finally, repoint `_markColsActive` at the inline segmented group (it currently queries the removed `this.colsMenu`) — replace:

```js
  _markColsActive() {
    if (!this.colsMenu) return;
    const key = this._cols == null ? "auto" : String(this._cols);
    for (const item of this.colsMenu.querySelectorAll(".cols-item")) {
      item.classList.toggle("active", item.getAttribute("data-cols") === key);
    }
  }
```

with:

```js
  _markColsActive() {
    if (!this.colsSeg) return;
    const key = this._cols == null ? "auto" : String(this._cols);
    for (const item of this.colsSeg.querySelectorAll(".cols-item")) {
      item.classList.toggle("active", item.getAttribute("data-cols") === key);
    }
  }
```

(`_pickCols` is unchanged: its `_closeMenus()` now closes the ☰ menu after a column pick, which is fine — the highlight is reapplied on the still-built buttons and shows correctly on reopen.)

- [ ] **Step 6: Add the settings-menu CSS**

Append to `internal/web/assets/style.css` (rows inside the reused `.share-menu` popover):

```css
/* In-call ☰ settings menu: a vertical list of labelled rows inside the shared
   .share-menu popover. Each row is "label … control" (a toggle button, a segmented
   group, or the quality selects). */
.settings-menu { min-width: 240px; }
.settings-menu .settings-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 12px;
}
.settings-menu .si-label { font-size: 13px; white-space: nowrap; }
.settings-menu .seg { display: flex; gap: 4px; }
.settings-menu .quality-inline { display: flex; gap: 8px; align-items: center; }
.settings-menu .quality-inline .field { margin: 0; }
```

- [ ] **Step 7: Verify — syntax + suite (menu is DOM)**

Run: `node --check internal/web/assets/ui/controls.js && node --test internal/web/test/*.test.js`
Expected: `--check` silent; suite green.

- [ ] **Step 8: Manual check (note pending)**

The ☰ button opens/closes the menu (outside-click and re-click both close it); Hide-self, Noise-suppression, Data-saver toggles still work from the menu; Columns segmented still relayouts; as an op (including a mid-call promotion) the Lock and Quality rows appear and work; the "Room locked" indicator still shows on the bar. (No browser needed from the implementer — note pending.)

- [ ] **Step 9: Commit**

```bash
git add internal/web/assets/ui/controls.js internal/web/assets/style.css
git commit -m "feat(web): consolidate low-frequency controls into a ☰ settings menu"
```

---

### Task 4: Rename row in the ☰ menu

**Files:**
- Modify: `internal/web/assets/ui/controls.js`

**Interfaces:**
- Consumes: `this.grid.selfName` (grid, Task 2); `this._send`/`this.signaling` → `"rename"` (Task 1); the ☰ menu (Task 3).

- [ ] **Step 1: Build the rename row at the top of the settings menu**

In `_build`, build the input just before assembling `this.settingsMenu`, and add its row as the FIRST child of the menu:

```js
    // Rename: change your own display name. Enter submits; Esc reverts + closes.
    this.renameInput = el("input", {
      class: "rename-input device", type: "text", maxlength: "24",
      "aria-label": "Your display name",
      onKeydown: (e) => {
        if (e.key === "Enter") { e.preventDefault(); this._submitRename(); }
        else if (e.key === "Escape") { e.preventDefault(); this._closeMenus(); }
      },
    });
```

and put its row at the top of the `settingsMenu` children list (before the "Hide self" row):

```js
    this.settingsMenu = el(
      "div",
      { class: "share-menu settings-menu", hidden: true },
      this._settingsRow("Name", this.renameInput),
      this._settingsRow("Hide self", this.hideSelfBtn),
      this._settingsRow("Noise suppression", this.nsBtn),
      this._settingsRow("Data saver", this.lowBwBtn),
      this._settingsRow("Columns", this.colsSeg),
    );
```

- [ ] **Step 2: Prefill the input when the menu opens**

In `_toggleSettingsMenu`, prefill from the live self name when opening:

```js
  _toggleSettingsMenu() {
    const open = this.settingsMenu.hidden;
    this._closeMenus();
    if (open) {
      this.settingsMenu.hidden = false;
      this.settingsBtn.setAttribute("aria-expanded", "true");
      if (this.renameInput) this.renameInput.value = (this.grid && this.grid.selfName) || "";
    }
  }
```

- [ ] **Step 3: Add `_submitRename`**

Add near `_toggleSettingsMenu`:

```js
  // Send a rename if the trimmed input is non-empty and actually different from the
  // current self name; the server sanitizes authoritatively and the resulting
  // peer-renamed updates the tile, so no optimistic local edit is needed.
  _submitRename() {
    const name = this.renameInput.value.trim();
    const current = (this.grid && this.grid.selfName) || "";
    if (name && name !== current) this._send("rename", { name });
    this._closeMenus();
  }
```

- [ ] **Step 4: Verify — syntax + suite**

Run: `node --check internal/web/assets/ui/controls.js && node --test internal/web/test/*.test.js`
Expected: `--check` silent; suite green.

- [ ] **Step 5: Manual check (note pending)**

In a call with ≥1 other person: the ☰ menu's Name field is prefilled with your name; typing a new name + Enter updates your tile, the roster, and everyone else's view of you; Esc cancels; the new name survives a reconnect and a page refresh; an identified user keeps their op/+ badge and role after renaming.

- [ ] **Step 6: Commit**

```bash
git add internal/web/assets/ui/controls.js
git commit -m "feat(web): rename row in the ☰ menu — change your display name mid-call"
```

---

## Self-Review

**Spec coverage:**
- `rename`/`peer-renamed` protocol + round-trip tests → T1 Steps 1-4.
- `room.Rename` (broadcast all, no-op unchanged/empty/missing) → T1 Steps 5-8.
- Reconnect-safe `displayName` (client name wins, token-nick fallback) + serve/dispatch wiring → T1 Steps 9-12.
- Shared `loadName`/`saveName`; prejoin uses them → T2 Steps 1-2.
- `grid.setPeerName` (self keeps `selfName`; `_setName` covers "(you)"/screen) → T2 Step 3.
- `peer-renamed` handler: tile + `selfName` + `pendingJoin.name` + persist → T2 Step 4.
- ☰ menu holds Hide-self/NS/Data-saver/Columns + op Lock/Quality; op-gated via `_ensureOpSettingsRows`/`becomeOp`; lock indicator stays on bar; columns inline; quality inline → T3.
- Rename row (prefill, Enter submit, Esc cancel, empty/unchanged guard) → T4.
- Out of scope (op-renames-others, unique nicks, rate-limit, feed) — nothing implements them.

**Placeholder scan:** No TBD/TODO; every code step carries complete code and exact expected output.

**Type consistency:** `signal.Rename{Name}` / `signal.PeerRenamed{ID,Name}` match across messages.go, the tests, room.go, and the client `{id,name}` shape. `room.Rename(id, name)` signature matches the dispatch call. `displayName(joinName, claims)` matches its test and the `serve()` call. `setPeerName(id, name)` matches the app.js call. `loadName`/`saveName` names match across prefs.js, prejoin.js, app.js. `settingsMenu`/`settingsBtn`/`settingsWrap`/`_settingsRow`/`_ensureOpSettingsRows`/`qualityRow`/`renameInput`/`colsSeg` used consistently within controls.js; `_toggleColsMenu`/`_toggleQualityMenu`/`colsWrap`/`qualityWrap`/`colsMenu`/`qualityMenu` are fully removed (no dangling references in `_closeMenus`, the pointer handler, or `becomeOp`).
