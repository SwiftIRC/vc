# Gravatar Avatars Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a participant enter an email on the lobby join screen; show their Gravatar in the camera-off placeholder (self and remote), falling back to the initial-in-a-circle. Only the email's SHA-256 hash leaves the browser.

**Architecture:** A new `gravatar` field is threaded through the signaling protocol (`Join` → server `Participant` → `joined` roster + `peer-joined` broadcast). The client hashes the email locally (`crypto.subtle`, SHA-256), sends the hash, and `applyAvatar` gains an optional third arg that swaps a Gravatar image over the existing letter/color fallback.

**Tech Stack:** Go stdlib (signaling server + tests via `go test`); vanilla ES modules (browser client, `node --test`); no new dependencies, no build step.

## Global Constraints

- Client is dependency-free vanilla ES modules; no build step; no new npm packages. Go uses only existing deps; `go vet ./...` and `go test ./internal/...` must pass.
- Only the SHA-256 hash is transmitted or stored server-side. The raw email lives ONLY in this browser's localStorage — never sent.
- Hash format: lowercase SHA-256 hex, matching `^[a-f0-9]{64}$`. Email normalization before hashing: `trim().toLowerCase()`.
- Pinned test vector: `gravatarHash("MyEmailAddress@example.com")` === `"84059b07d4be67b806386c0aad8070a23f18836bbaae342275dc0a83414c32ee"` (also for the trimmed/upper/lower variants of that email).
- Gravatar URL: `https://www.gravatar.com/avatar/<hash>?d=404&s=<size>` — `d=404` so an unknown email 404s and we fall back to letter/color.
- Applies to the camera-off placeholder ONLY. The screen-share "Sharing audio" placeholder (`.cam-off-icon`/`.cam-off-text`) is untouched.
- JS tests: `node --test internal/web/test/*.test.js` (a BARE directory arg fails in this sandbox's Node 22 — use the `*.test.js` glob; `nvm use 22`). Go tests: `go test ./internal/signal/ ./internal/room/ ./internal/server/`.
- Commits carry: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

### Task 1: Wire protocol field (`internal/signal/messages.go`)

**Files:**
- Modify: `internal/signal/messages.go` (`Join` ~13, `PeerInfo` ~150, `PeerJoined` ~178)
- Test: `internal/signal/messages_test.go`

**Interfaces:**
- Produces: `Join.Gravatar`, `PeerInfo.Gravatar`, `PeerJoined.Gravatar` — all `string \`json:"gravatar,omitempty"\``.

- [ ] **Step 1: Write the failing tests**

In `internal/signal/messages_test.go`, add to the `cases` slice inside `TestDecodeClientMessages` (after the existing `join` case):

```go
		{`{"type":"join","name":"alice","gravatar":"84059b07d4be67b806386c0aad8070a23f18836bbaae342275dc0a83414c32ee"}`, &Join{Name: "alice", Gravatar: "84059b07d4be67b806386c0aad8070a23f18836bbaae342275dc0a83414c32ee"}},
```

In `TestEncodeServerMessages`, add to its `cases` slice:

```go
		{PeerJoined{ID: "p2", Name: "bob", Role: "user", Gravatar: "84059b07d4be67b806386c0aad8070a23f18836bbaae342275dc0a83414c32ee"}, "peer-joined", []string{`"gravatar":"84059b07`}},
```

And add a new test that `omitempty` actually omits it:

```go
func TestGravatarOmittedWhenEmpty(t *testing.T) {
	for _, v := range []any{PeerJoined{ID: "p2", Name: "bob", Role: "user"}, Joined{SelfID: "p1", Role: "op", Peers: []PeerInfo{{ID: "p2", Name: "bob", Role: "user"}}}} {
		raw, err := Encode(v)
		if err != nil {
			t.Fatalf("Encode(%T): %v", v, err)
		}
		if strings.Contains(string(raw), "gravatar") {
			t.Errorf("Encode(%T) = %s, should omit empty gravatar", v, raw)
		}
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/signal/`
Expected: FAIL — `Join`/`PeerJoined`/`PeerInfo` have no `Gravatar` field (compile error).

- [ ] **Step 3: Add the fields**

In `Join` (add after the `Camera *bool` field, before the closing brace):

```go
	// Gravatar is the SHA-256 hex hash of the joiner's normalized email, computed
	// client-side. Only the hash is ever sent — never the raw email. Cosmetic and
	// unverified (like Name for a guest); the server hex-validates it.
	Gravatar string `json:"gravatar,omitempty"`
```

In `PeerInfo` (add after `Ref`):

```go
	Gravatar string `json:"gravatar,omitempty"` // SHA-256 email hash for the peer's Gravatar; "" if none
```

In `PeerJoined` (add after `Ref`):

```go
	Gravatar string `json:"gravatar,omitempty"` // see PeerInfo.Gravatar
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/signal/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/signal/messages.go internal/signal/messages_test.go
git commit -m "feat(signal): carry a gravatar email-hash on join/roster/peer-joined

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Server stores, validates, and relays the hash (`internal/room/room.go`, `internal/server/server.go`)

**Files:**
- Modify: `internal/room/room.go` (`Participant` struct ~33; roster build ~206; `PeerJoined` broadcast ~218)
- Modify: `internal/server/server.go` (assignment after ~233; new `sanitizeGravatar` near `sanitizeName` ~417)
- Test: `internal/room/room_test.go`, `internal/server/server_test.go`

**Interfaces:**
- Consumes: `signal.Join.Gravatar`, `signal.PeerInfo.Gravatar`, `signal.PeerJoined.Gravatar` (Task 1).
- Produces: `room.Participant.Gravatar string`; `sanitizeGravatar(string) string` (server pkg).

- [ ] **Step 1: Write the failing tests**

In `internal/room/room_test.go`, add (mirrors the existing `TestJoinSendsRosterAndBroadcasts` harness — `member(...)` + `fakeConn.msgs`):

```go
func TestJoinCarriesGravatar(t *testing.T) {
	const aliceHash = "84059b07d4be67b806386c0aad8070a23f18836bbaae342275dc0a83414c32ee"
	const bobHash = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"
	r := New(Config{Slug: "swift", Adhoc: true})
	alice, ac := member("p1", "alice", RoleUser)
	alice.Gravatar = aliceHash
	if err := r.Join(alice, ""); err != nil {
		t.Fatal(err)
	}
	bob, bc := member("p2", "bob", RoleUser)
	bob.Gravatar = bobHash
	if err := r.Join(bob, ""); err != nil {
		t.Fatal(err)
	}
	// bob's Joined roster carries alice's gravatar
	joined, ok := bc.msgs[0].(signal.Joined)
	if !ok {
		t.Fatalf("bob msg[0] = %T, want signal.Joined", bc.msgs[0])
	}
	if len(joined.Peers) != 1 || joined.Peers[0].Gravatar != aliceHash {
		t.Errorf("roster gravatar = %+v, want alice %q", joined.Peers, aliceHash)
	}
	// alice was told bob arrived, with bob's gravatar
	last := ac.msgs[len(ac.msgs)-1]
	pj, ok := last.(signal.PeerJoined)
	if !ok || pj.Gravatar != bobHash {
		t.Errorf("alice last msg = %#v, want PeerJoined with gravatar %q", last, bobHash)
	}
}
```

In `internal/server/server_test.go`, add:

```go
func TestSanitizeGravatar(t *testing.T) {
	const good = "84059b07d4be67b806386c0aad8070a23f18836bbaae342275dc0a83414c32ee"
	if got := sanitizeGravatar(good); got != good {
		t.Errorf("sanitizeGravatar(valid) = %q, want unchanged", got)
	}
	for _, bad := range []string{
		"",
		"tooshort",
		good + "ff",                        // too long
		good[:63] + "G",                    // non-hex char
		"84059B07D4BE67B806386C0AAD8070A23F18836BBAAE342275DC0A83414C32EE", // uppercase
	} {
		if got := sanitizeGravatar(bad); got != "" {
			t.Errorf("sanitizeGravatar(%q) = %q, want \"\"", bad, got)
		}
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/room/ ./internal/server/`
Expected: FAIL — `Participant` has no `Gravatar` field; `sanitizeGravatar` undefined.

- [ ] **Step 3: Add the `Participant.Gravatar` field**

In `internal/room/room.go`, in the `Participant` struct (near `Name string`), add:

```go
	Gravatar string // SHA-256 email hash for the participant's Gravatar; "" if none. Guarded by Room.mu.
```

- [ ] **Step 4: Include it in the roster and the join broadcast**

`internal/room/room.go`, roster build (~line 206) — add `Gravatar: q.Gravatar`:

```go
		roster = append(roster, signal.PeerInfo{ID: q.ID, Name: q.Name, Role: string(q.Role), Mic: q.Mic, Camera: q.Camera, Ref: q.Ref, Gravatar: q.Gravatar})
```

`internal/room/room.go`, `PeerJoined` broadcast (~line 218) — add `Gravatar: p.Gravatar`:

```go
	r.Broadcast(signal.PeerJoined{ID: p.ID, Name: p.Name, Role: string(p.Role), Mic: p.Mic, Camera: p.Camera, Ref: p.Ref, Gravatar: p.Gravatar}, p.ID)
```

- [ ] **Step 5: Add `sanitizeGravatar` and assign it on join**

`internal/server/server.go` — add the helper near `sanitizeName` (~line 417):

```go
// sanitizeGravatar returns s only if it is a well-formed lowercase SHA-256 hex
// digest (64 hex chars); anything else becomes "". The value is echoed to every
// other client and used to build a URL, so a crafted client must not be able to
// inject arbitrary text through it.
func sanitizeGravatar(s string) string {
	if len(s) != 64 {
		return ""
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return ""
		}
	}
	return s
}
```

Then assign it right AFTER the `if claims != nil { … } else { … }` name/role block (~line 233, before the `p.SetInitialMedia(...)` line) so it applies to both tokened and guest joiners:

```go
	p.Gravatar = sanitizeGravatar(join.Gravatar)
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `go test ./internal/room/ ./internal/server/ && go vet ./internal/...`
Expected: PASS, vet clean.

- [ ] **Step 7: Commit**

```bash
git add internal/room/room.go internal/server/server.go internal/room/room_test.go internal/server/server_test.go
git commit -m "feat(server): store, hex-validate, and relay the gravatar hash

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Client gravatar helpers + `applyAvatar` image swap (`internal/web/assets/lib/avatar.js`)

**Files:**
- Modify: `internal/web/assets/lib/avatar.js` (add helpers; extend `applyAvatar`)
- Test: `internal/web/test/avatar.test.js`

**Interfaces:**
- Consumes: existing `avatarFor` (unchanged).
- Produces: `async gravatarHash(email) -> string`; `gravatarUrl(hash, size) -> string`; `applyAvatar(node, name, gravatar?)` (third arg optional; 2-arg callers unaffected).

- [ ] **Step 1: Write the failing tests**

In `internal/web/test/avatar.test.js`, update the import line to include the new exports, then add tests:

```js
import { IRC_COLORS, IRC_AVATAR_COLORS, avatarFor, gravatarHash, gravatarUrl } from "../assets/lib/avatar.js";
```

```js
test("gravatarHash matches the known SHA-256 vector and normalizes case/space", async () => {
  const want = "84059b07d4be67b806386c0aad8070a23f18836bbaae342275dc0a83414c32ee";
  assert.equal(await gravatarHash("MyEmailAddress@example.com"), want);
  assert.equal(await gravatarHash("  MYEMAILADDRESS@EXAMPLE.COM  "), want);
});

test("gravatarHash returns empty for blank input", async () => {
  assert.equal(await gravatarHash(""), "");
  assert.equal(await gravatarHash("   "), "");
});

test("gravatarUrl builds a d=404 URL for a valid hash and rejects malformed hashes", () => {
  const h = "84059b07d4be67b806386c0aad8070a23f18836bbaae342275dc0a83414c32ee";
  assert.equal(gravatarUrl(h, 160), `https://www.gravatar.com/avatar/${h}?d=404&s=160`);
  assert.equal(gravatarUrl("nope", 160), "");
  assert.equal(gravatarUrl(h.toUpperCase(), 160), "");
  assert.equal(gravatarUrl("", 160), "");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test internal/web/test/avatar.test.js`
Expected: FAIL — `gravatarHash`/`gravatarUrl` are not exported.

- [ ] **Step 3: Implement the helpers and extend `applyAvatar`**

In `internal/web/assets/lib/avatar.js`, add these exports (place `gravatarHash`/`gravatarUrl` above `applyAvatar`):

```js
// SHA-256 hex of the normalized email, computed in-browser (no MD5 dependency).
// Only this hash is ever sent or stored; the raw email never leaves the client.
// Returns "" for blank input or when SubtleCrypto is unavailable (insecure context).
export async function gravatarHash(email) {
  const e = (email || "").trim().toLowerCase();
  if (!e) return "";
  try {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(e));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return "";
  }
}

// Gravatar image URL for a validated hash. d=404 makes Gravatar 404 for an unknown
// email, which triggers our letter/color fallback rather than Gravatar's own default.
// Returns "" for a malformed hash so a bad value can never build a URL.
export function gravatarUrl(hash, size) {
  if (!/^[a-f0-9]{64}$/.test(hash || "")) return "";
  const s = Number.isFinite(size) && size > 0 ? Math.round(size) : 80;
  return `https://www.gravatar.com/avatar/${hash}?d=404&s=${s}`;
}

// Pixel size to request, scaled for retina and capped.
function gravatarSize() {
  const dpr = typeof devicePixelRatio === "number" && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.min(320, Math.round(160 * dpr));
}
```

Replace the existing `applyAvatar` with the gravatar-aware version:

```js
// DOM helper: paint a <span> with the avatar for `name`, then — if `gravatar` is a
// valid hash — swap in the Gravatar image once it loads. The letter/color is painted
// synchronously first, so it is the instant, correct fallback for no-email, no-
// Gravatar (404), offline, or blocked cases. Used by grid.js/prejoin.js.
export function applyAvatar(node, name, gravatar) {
  const { initial, bg, fg } = avatarFor(name);
  node.textContent = initial;
  node.style.background = bg;
  node.style.color = fg;
  node.style.backgroundImage = ""; // drop any prior image (rename / cleared email)
  const token = gravatar || "";
  node.dataset.avatarToken = token; // identity guard for the async load below
  const url = gravatarUrl(token, gravatarSize());
  if (!url) return; // no/invalid hash — letter/color stays
  const img = new Image();
  img.onload = () => {
    if (node.dataset.avatarToken !== token) return; // superseded by a later applyAvatar
    node.style.backgroundImage = `url("${url}")`;
    node.style.backgroundSize = "cover";
    node.style.backgroundPosition = "center";
    node.textContent = ""; // opaque image covers the letter
  };
  img.src = url; // on error (404/offline/blocked) do nothing — fallback already shows
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test internal/web/test/avatar.test.js` then `node --test internal/web/test/*.test.js`
Expected: PASS (existing avatar tests still green; new gravatar tests pass).

- [ ] **Step 5: Commit**

```bash
git add internal/web/assets/lib/avatar.js internal/web/test/avatar.test.js
git commit -m "feat(web): add gravatarHash/gravatarUrl and image-swap in applyAvatar

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Lobby email field + send the hash (`internal/web/assets/ui/prejoin.js`, `internal/web/assets/app.js`)

**Files:**
- Modify: `internal/web/assets/ui/prejoin.js` (import; `EMAIL_KEY`/`saveEmail`/`loadSavedEmail` near `NAME_KEY` ~64; `this.gravatar` init; email input build; form insert; `_avatarName`/toggle repaints pass `this.gravatar`; `_onEmailInput`; `_submit`)
- Modify: `internal/web/assets/app.js` (`selfGravatar` module var; `onJoin` destructure + `pendingJoin`)

**Interfaces:**
- Consumes: `gravatarHash`, `applyAvatar` from `../lib/avatar.js` (Task 3).
- Produces: `onJoin({ name, password, gravatar })`; module-level `selfGravatar` in app.js; `pendingJoin.gravatar`.

- [ ] **Step 1: Import `gravatarHash` in prejoin.js**

Change the existing import:

```js
import { applyAvatar, gravatarHash } from "../lib/avatar.js";
```

- [ ] **Step 2: Add email persistence next to the name helpers**

After the `saveName` function (~line 80), add:

```js
const EMAIL_KEY = "swiftirc-vc-email";

// loadSavedEmail / saveEmail persist the Gravatar email across visits. Only ever
// read locally to compute the hash; the raw email is never sent to the server.
function loadSavedEmail() {
  try {
    return localStorage.getItem(EMAIL_KEY) || "";
  } catch {
    return "";
  }
}
function saveEmail(email) {
  try {
    if (email) localStorage.setItem(EMAIL_KEY, email);
    else localStorage.removeItem(EMAIL_KEY);
  } catch {
    /* storage unavailable — ignore */
  }
}
```

- [ ] **Step 3: Build the email input and track the live hash**

In the constructor, initialize the current hash (near where other instance fields are set, before the input build): add `this.gravatar = "";`

Where `this.nameInput` is built (~line 179), add an email input right after it:

```js
    this.emailInput = el("input", {
      class: "email",
      type: "email",
      placeholder: "Email for Gravatar (optional)",
      autocomplete: "email",
      maxlength: "254",
      onInput: () => this._onEmailInput(),
    });
    this.emailInput.value = loadSavedEmail();
```

- [ ] **Step 4: Insert the email field into the form**

In the `form` construction, add an email field label right after the Display-name field:

```js
      el("label", { class: "field" }, el("span", { text: "Display name" }), this.nameInput),
      el("label", { class: "field" }, el("span", { text: "Gravatar email" }), this.emailInput),
```

- [ ] **Step 5: Pass `this.gravatar` into both self-preview repaints**

Update the `nameInput` `onInput` handler to include the hash:

```js
      onInput: () => applyAvatar(this.cameraOffAvatar, this._avatarName(), this.gravatar),
```

In `_setCameraToggle`, update the repaint added by the prior feature:

```js
    if (off) applyAvatar(this.cameraOffAvatar, this._avatarName(), this.gravatar);
```

- [ ] **Step 6: Add `_onEmailInput` and prime it once**

Add the method (near `_avatarName`):

```js
  // Recompute the Gravatar hash as the email changes and repaint the self-preview.
  // Guarded against out-of-order async results: only the latest keystroke wins.
  async _onEmailInput() {
    const email = this.emailInput.value;
    const hash = await gravatarHash(email);
    if (this.emailInput.value !== email) return; // superseded by a newer keystroke
    this.gravatar = hash;
    applyAvatar(this.cameraOffAvatar, this._avatarName(), this.gravatar);
  }
```

Prime the hash from the prefilled email once, right after the form/overlay are built (e.g. at the end of the constructor or wherever `_syncMediaState()` is first called — after `this.cameraOffAvatar` and `this.emailInput` exist):

```js
    this._onEmailInput(); // compute the hash for any prefilled email (fire-and-forget)
```

- [ ] **Step 7: Hash on submit and send it**

Make `_submit` async and include the hash. Final form:

```js
  async _submit() {
    const name = this._avatarName();
    if (!this.nick) saveName(name); // remember the typed name for next visit
    const email = this.emailInput.value;
    saveEmail(email);
    const password = this.passwordInput.value; // sent always; unlocked rooms ignore it server-side
    this.errorLabel.textContent = "";
    this.joinButton.disabled = true;
    this.joinButton.textContent = "Joining…";
    const gravatar = await gravatarHash(email);
    this.onJoin({ name, password, gravatar });
  }
```

- [ ] **Step 8: app.js — store `selfGravatar` and put the hash on every join frame**

Add a module-level declaration next to the existing `let selfName` declaration:

```js
let selfGravatar = "";
```

Update `onJoin` (~line 148):

```js
function onJoin({ name, password, gravatar }) {
  selfName = name || "";
  selfGravatar = gravatar || "";
  pendingJoin = { name, password, gravatar, token, invite, session: sessionNonce() };
```

(leave the rest of `onJoin` unchanged).

- [ ] **Step 9: Verify (syntax + suite) and manually**

Run: `node --check internal/web/assets/ui/prejoin.js && node --check internal/web/assets/app.js && node --test internal/web/test/*.test.js`
Expected: `--check` silent; suite green (still 41/41 — no new unit tests here).

Manual (note as pending for the controller; do not run a browser): entering an email in the lobby shows your Gravatar in the self-preview (falls back to `?`/initial for an unknown email); the value persists across a reload; a `join` frame carries the `gravatar` hash.

- [ ] **Step 10: Commit**

```bash
git add internal/web/assets/ui/prejoin.js internal/web/assets/app.js
git commit -m "feat(web): lobby Gravatar email field, persisted, hashed and sent on join

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Render Gravatars on tiles (`internal/web/assets/ui/grid.js`, `internal/web/assets/app.js`)

**Files:**
- Modify: `internal/web/assets/ui/grid.js` (constructor ~71; `_addSelfTile` ~461; `_ensureTile` ~474; `addPeer` ~265; `_buildTile` ~489/546; `_setName` ~558)
- Modify: `internal/web/assets/app.js` (`new Grid({...})` call in `renderInCall` — add `selfGravatar`)

**Interfaces:**
- Consumes: `applyAvatar` (already imported in grid.js); `selfGravatar` (Task 4); each roster/peer-joined message's `gravatar` (Tasks 1–2).
- Produces: `tile.gravatar` on every tile record.

- [ ] **Step 1: Accept `selfGravatar` in the Grid constructor**

`internal/web/assets/ui/grid.js` constructor (~line 71):

```js
  constructor({ selfId, selfName, selfRole, selfGravatar, media, opActionsFor, screenOpActionsFor } = {}) {
    this.selfId = selfId;
    this.selfName = selfName || "You";
    this.selfGravatar = selfGravatar || "";
```

- [ ] **Step 2: Thread `gravatar` through the tile builders**

`_buildTile` signature and the avatar paint (~line 489 and ~496). Change the signature to accept `gravatar` and pass it to `applyAvatar`:

```js
  _buildTile(id, name, role, { self, gravatar } = {}) {
```

and the paint line (from the prior feature):

```js
    const camOffAvatar = el("span", { class: "cam-off-avatar", "aria-hidden": "true" });
    const camOff = el("div", { class: "cam-off", hidden: true }, camOffAvatar);
    applyAvatar(camOffAvatar, name, gravatar);
```

Add `gravatar` to the tile record literal (~line 546), so `_setName`/repaints can reuse it:

```js
    const tile = { el: tileEl, cameraVideo, camOff, camOffAvatar, gravatar: gravatar || "", nameEl, badgeEl, micPill, avPill, volumeEl, volLabel, volume: 1, name, hasCamera: false, self };
```

- [ ] **Step 3: Repaint with the stored gravatar on rename**

`_setName` (~line 558):

```js
  _setName(tile, name) {
    tile.name = name;
    applyAvatar(tile.camOffAvatar, name, tile.gravatar);
    tile.nameEl.textContent = tile.self ? `${name} (you)` : name;
    const screen = this.screens.get(tile.el.getAttribute("data-id"));
    if (screen) screen.nameEl.textContent = `${name} (screen)`;
  }
```

- [ ] **Step 4: Pass self + remote gravatars into the tiles**

`_addSelfTile` (~line 461):

```js
  _addSelfTile(role) {
    const tile = this._buildTile(this.selfId, this.selfName, role, { self: true, gravatar: this.selfGravatar });
```

`_ensureTile` (~line 474) — accept and forward `gravatar`:

```js
  _ensureTile(id, name, role, gravatar) {
    let tile = this.tiles.get(id);
    if (tile) return tile;
    tile = this._buildTile(id, name || "guest", role, { self: false, gravatar });
```

`addPeer` (~line 265) — forward the peer's gravatar, and update it on an existing tile before the name repaint:

```js
  addPeer(peer) {
    if (!peer || !peer.id || peer.id === this.selfId) return;
    const tile = this._ensureTile(peer.id, peer.name, peer.role, peer.gravatar);
    if (peer.gravatar != null) tile.gravatar = peer.gravatar;
    if (peer.name != null && peer.name !== "") this._setName(tile, peer.name);
    if (peer.role != null) this._setRole(tile, peer.role);
  }
```

(For a brand-new tile, `_buildTile` already painted it with the gravatar; the following `_setName` repaint is harmless. For an already-existing tile — e.g. a reconnect — this updates and repaints it.)

- [ ] **Step 5: app.js — hand `selfGravatar` to the Grid**

In `renderInCall`, the `new Grid({ ... })` call — add `selfGravatar` next to `selfName`:

```js
  grid = new Grid({
    selfId: msg.selfId,
    selfName,
    selfGravatar,
    selfRole: msg.role,
```

(The remote path needs no change: `addRosterPeer(p)` already forwards the whole roster/peer-joined object, which now includes `gravatar`, into `grid.addPeer`.)

- [ ] **Step 6: Verify (syntax + suite) and manually**

Run: `node --check internal/web/assets/ui/grid.js && node --check internal/web/assets/app.js && node --test internal/web/test/*.test.js`
Expected: `--check` silent; suite green.

Manual (note as pending for the controller): with two participants who each set an email, each sees the other's Gravatar on their camera-off tile; a participant with no email (or an email without a Gravatar) shows the letter/color; your own camera-off tile shows your Gravatar.

- [ ] **Step 7: Commit**

```bash
git add internal/web/assets/ui/grid.js internal/web/assets/app.js
git commit -m "feat(web): render participant Gravatars on camera-off tiles

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Wire fields `gravatar` on Join/PeerInfo/PeerJoined → Task 1.
- Server stores + hex-validates + relays (roster + peer-joined); reconnect via re-sent join → Task 2.
- Client `gravatarHash` (SHA-256, normalize, empty-safe), `gravatarUrl` (d=404, hash-validated), `applyAvatar` image swap with race guard + fallback → Task 3.
- Lobby email field, `swiftirc-vc-email` persistence, live self-preview, hash-on-submit, `selfGravatar` + `pendingJoin` → Task 4.
- Self + remote tile rendering via `tile.gravatar` and the roster path → Task 5.
- Privacy (only hash sent; raw email local-only), security (`sanitizeGravatar` + client `gravatarUrl` validation), no CSP change, graceful offline (d=404/onerror) → Tasks 2, 3.
- Tests: Go (messages decode/encode/omitempty, room roster/peer-joined carry it, sanitizeGravatar) → Tasks 1–2; JS (hash vector + normalization, url shape/validation) → Task 3; DOM image-swap is node --check + manual → Tasks 3–5.

**Placeholder scan:** No TBD/TODO; every code step has complete code, exact paths, and line anchors.

**Type consistency:** `gravatar`/`Gravatar` field name consistent across Go structs, `Participant`, and JSON tag; `applyAvatar(node, name, gravatar)` and `tile.gravatar` consistent across grid.js; `gravatarHash`/`gravatarUrl` signatures match between avatar.js, tests, and callers; `selfGravatar` consistent across app.js and the Grid constructor.
