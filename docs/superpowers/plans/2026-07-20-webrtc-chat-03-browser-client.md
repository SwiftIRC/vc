# webrtc-chat Plan 3: Browser Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A vanilla-JS browser client — no build step, native ES modules — that joins a room over the existing WebSocket + SFU, publishes mic/camera/screen, renders a tile grid of other participants, and supports chat and op moderation. Served by the Go binary via `embed`. Pure logic is unit-tested with `node --test`; the browser-only surface is verified by a documented manual checklist.

**Architecture:** Client code splits into PURE modules (no browser APIs → `node --test`) and BROWSER modules (DOM / getUserMedia / RTCPeerConnection → manual checklist). `lib/protocol.js` (wire encode/decode + token-from-fragment), `lib/negotiation.js` (polite perfect-negotiation decisions incl. rollback — the logic the server's impolite side depends on), and `lib/backoff.js` (reconnect schedule) are pure. `net/signaling.js` wraps the WebSocket (auto-reconnect via backoff, suppressed after kick/ban); `net/peer.js` drives one `RTCPeerConnection` applying `negotiation.js`'s decisions; `net/media.js` handles devices + screenshare. `ui/*` renders pre-join, tile grid + active-speaker, chat + moderation feed, and controls. `app.js` routes pre-join ↔ in-call and owns top-level state. The Go server gains a static handler (`internal/web` embed) that serves the assets and maps `GET /` and `GET /{room}` to the app shell.

**Tech Stack:** Vanilla JS (native ES modules, no bundler/transpiler), the browser WebRTC + WebSocket + WebAudio APIs, `node --test` (Node 22 LTS via `.nvmrc`, run through nvm) for pure-logic unit tests, Go `embed` for serving. Builds on Plans 1–2 (server core + SFU, on `master`).

**Spec:** `docs/superpowers/specs/2026-07-20-webrtc-chat-design.md` (Client + Signaling Protocol + Moderation + Reliability sections). Playwright E2E, Prometheus, and pprof were descoped on 2026-07-20.

## Global Constraints

- **No build step.** The files in `internal/web/assets/` are exactly what the browser runs — native ES modules (`import`/`export`), no bundler, transpiler, or npm dependency for the shipped client. Evergreen-browser baseline.
- **Pure vs browser split is load-bearing:** `lib/*.js` must not reference `window`, `document`, `navigator`, `RTCPeerConnection`, `WebSocket`, or any browser global — so `node --test` can import them directly. Browser modules (`net/*`, `ui/*`, `app.js`) may.
- **Wire contract with the server (Plans 1–2), do not drift:**
  - Signaling messages match `internal/signal` exactly (types + field names: `join{name?,password?,token?}`, `offer/answer{sdp}`, `candidate{candidate}`, `chat{text}`, `set-lock{password?}`, `kick{id}`, `mute-peer{id,kind}`, `ban{id}`, `leave`; inbound `joined{selfId,role,peers}`, `peer-joined/left`, `offer/answer/candidate`, `tracks{tracks:[{mid,participantId,kind}]}`, `chat{from,text,ts}`, `moderation{actor,action,target,kind?}`, `kicked{by}`, `banned{by}`, `muted{kind}`, `room-locked/unlocked`, `server-restarting`, `error{code,message}`).
  - **Track kind is conveyed via the MSID stream id, NOT `track.id`.** Browsers make
    `MediaStreamTrack.id` read-only (a UUID), so the client publishes each track with
    `addTransceiver(track, {direction:"sendonly", streamIds:[kind]})` where `kind` ∈
    `"mic"`/`"camera"`/`"screen"`. This requires a small Plan-2 server change (Task 6):
    the SFU derives kind from `remote.StreamID()` (settable by the browser) instead of
    `remote.ID()` (not settable). Without this, a browser's camera and screen (both
    video, both UUID ids) are indistinguishable to the server.
  - Token is read from the URL **fragment** (`#t=…`), never sent in the query/path; delivered to the server inside the `join` message's `token` field.
  - The client is the **POLITE** peer (perfect negotiation): it rolls back its own offer on collision. The server is impolite.
  - **On `kicked`/`banned`: stop, show the reason, and DO NOT reconnect** (the auto-reconnect self-heal must be suppressed). On `server-restarting` or any other drop: reconnect with backoff.
- WebSocket path `/ws/{room}`; pre-join participant count from `GET /api/rooms/{room}` → `{count,locked}`.
- Node pinned via `.nvmrc` (Node 22 LTS). Client tests run `nvm use && node --test internal/web/test/`.
- Commit messages carry **NO `Co-Authored-By` trailer**.
- `go test ./...` (Go side) and `node --test internal/web/test/` (JS side) must pass at every commit that touches their code. `go vet ./...` clean. `internal/room` stays Pion-free (untouched here).

## File Structure

```
.nvmrc                              — "22" (client test toolchain)
internal/web/
  web.go                            — //go:embed all:assets ; exported fs.FS (assets subtree)
  web_test.go                       — asserts index.html + key modules are embedded
  assets/
    index.html                      — app shell (imports app.js as a module)
    style.css                       — functional styling (light/dark ok)
    app.js                          — entry: route pre-join<->in-call, own top-level state
    lib/
      protocol.js                   — PURE: encode/decode wire messages; parseToken(fragment)
      negotiation.js                — PURE: politePerfectNegotiation decisions (incl. rollback)
      backoff.js                    — PURE: reconnect backoff schedule
    net/
      signaling.js                  — WS wrapper: connect, reconnect(backoff), send(msg), on(type,fn)
      media.js                      — getUserMedia, enumerateDevices, mute/camera/screenshare
      peer.js                       — RTCPeerConnection: applies negotiation decisions; tracks
    ui/
      prejoin.js                    — pre-join screen (preview, pickers, count, name/password, join)
      grid.js                       — tile grid + active-speaker highlight
      chat.js                       — chat panel + moderation feed
      controls.js                   — local controls + per-tile op controls + lock toggle
  test/                             — node --test (NOT embedded/served)
    protocol.test.js
    negotiation.test.js
    backoff.test.js
  MANUAL-TEST.md                    — manual browser verification checklist
internal/server/
  static.go                         — static handler (web.FS); GET / and GET /{room} -> index.html
  static_test.go
docs/
  DEPLOY.md                         — reverse proxy, TLS, media port range, config, !vc flow
```

### Task overview
1. Static serving (Go embed + routes) with a minimal shell — servable app skeleton.
2. `lib/protocol.js` (pure) + `node --test`.
3. `lib/negotiation.js` (pure, polite perfect negotiation incl. rollback) + `node --test`.
4. `lib/backoff.js` (pure) + `net/signaling.js` (WS wrapper, reconnect, kick/ban suppression).
5. `net/media.js` (devices, getUserMedia, mute/camera/screenshare). *(manual)*
6. `net/peer.js` (RTCPeerConnection applying negotiation + tracks). *(manual)*
7. `ui/prejoin.js` + `app.js` routing (pre-join → in-call). *(manual)*
8. `ui/grid.js` + `ui/controls.js` (tile grid, active-speaker, local + op controls). *(manual)*
9. `ui/chat.js` + final wiring (kicked/banned/restarting handling) + `MANUAL-TEST.md` + `docs/DEPLOY.md`. *(manual + docs)*

### Execution note (read before starting)
Tasks 1–4 are TDD with real automated tests (Go tests / `node --test`). Tasks 5–9 are
browser-dependent: they cannot be automatically tested in CI, so each ends with (a) the
implementer confirming the JS parses (`node --check <file>`) and the Go server still serves,
and (b) adding/ticking the relevant **MANUAL-TEST.md** items. Functional verification of
5–9 is a manual browser session (owner-run, e.g. via the claude-in-chrome skill or by hand)
after the plan completes — NOT a per-task automated gate. Per-task review still checks code
quality. Keep browser modules thin and push logic into the pure `lib/*` modules so it stays
under automated test.

---

### Task 1: Static serving — embed the client, route the app shell

**Files:**
- Create: `.nvmrc`
- Create: `internal/web/web.go`
- Create: `internal/web/web_test.go`
- Create: `internal/web/assets/index.html` (minimal shell for now)
- Create: `internal/web/assets/app.js` (minimal: logs "loaded")
- Create: `internal/server/static.go`
- Create: `internal/server/static_test.go`
- Modify: `internal/server/server.go` (register static routes in `Routes()`)

**Interfaces:**
- Consumes: nothing new.
- Produces:
```go
// internal/web
var Assets fs.FS // the assets/ subtree, ready for http.FileServerFS

// internal/server/static.go
func (h *Hub) handleStatic(w http.ResponseWriter, r *http.Request) // serves an asset or the app shell
```

**Routing rules:** `GET /` and `GET /{room}` (slug shape) serve `index.html` (the SPA shell — the client reads the room from `location.pathname`). Real asset paths (`/app.js`, `/lib/...`, `/style.css`, etc.) serve the embedded file with correct Content-Type. Keep the existing `/healthz`, `/ws/{room}`, `/api/...` routes — they must win over the catch-all (register specific routes; the Go 1.22 mux precedence handles this, but verify `/ws/{room}` still routes to the WS handler, not the shell).

- [ ] **Step 1: `.nvmrc`** → file contents: `22`

- [ ] **Step 2: Write the failing Go test** `internal/web/web_test.go`:
```go
package web

import (
	"io/fs"
	"testing"
)

func TestAssetsEmbedded(t *testing.T) {
	for _, name := range []string{"index.html", "app.js"} {
		if _, err := fs.Stat(Assets, name); err != nil {
			t.Errorf("asset %q not embedded: %v", name, err)
		}
	}
}
```

- [ ] **Step 3:** Run `go test ./internal/web/` → FAIL (`undefined: Assets`).

- [ ] **Step 4: Implement.** `internal/web/assets/index.html`:
```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>webrtc-chat</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/app.js"></script>
</body>
</html>
```
`internal/web/assets/app.js`: `console.log("webrtc-chat loaded");`
Create an empty `internal/web/assets/style.css`.
`internal/web/web.go`:
```go
// Package web embeds the browser client assets.
package web

import (
	"embed"
	"io/fs"
)

//go:embed all:assets
var embedded embed.FS

// Assets is the assets/ subtree (so paths are relative to the web root).
var Assets fs.FS = mustSub()

func mustSub() fs.FS {
	sub, err := fs.Sub(embedded, "assets")
	if err != nil {
		panic(err)
	}
	return sub
}
```
`internal/server/static.go`:
```go
package server

import (
	"io/fs"
	"net/http"
	"strings"

	"github.com/ryanwohara/webrtc-chat/internal/web"
)

// handleStatic serves an embedded asset, or the SPA shell (index.html) for the
// app root and room paths. Real asset requests (with an extension or a known
// prefix) are served from the embedded FS; everything else returns the shell.
func (h *Hub) handleStatic(w http.ResponseWriter, r *http.Request) {
	p := strings.TrimPrefix(r.URL.Path, "/")
	if p == "" {
		serveShell(w, r)
		return
	}
	if f, err := fs.Stat(web.Assets, p); err == nil && !f.IsDir() {
		http.FileServerFS(web.Assets).ServeHTTP(w, r)
		return
	}
	// Not a real asset → treat as a room path; the client reads the slug from the URL.
	serveShell(w, r)
}

func serveShell(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	f, err := web.Assets.Open("index.html")
	if err != nil {
		http.Error(w, "not found", http.StatusInternalServerError)
		return
	}
	defer f.Close()
	http.ServeContent(w, r, "index.html", zeroTime, f.(interface{ Seek(int64, int) (int64, error) }).(readSeeker))
}
```
NOTE to implementer: the `ServeContent` seek dance above is finicky — prefer the simpler, robust form: read the shell bytes once at startup into a `[]byte` and `w.Write` them, or use `http.ServeFileFS(w, r, web.Assets, "index.html")`. Use whichever compiles cleanly against the installed Go; the REQUIREMENT is "GET / and unknown paths return index.html with `text/html`". Keep it simple.
In `Routes()`, add a catch-all AFTER the existing routes:
```go
	mux.HandleFunc("GET /", h.handleStatic)
```
(Go 1.22 mux: `/healthz`, `/ws/{room}`, `/api/rooms/{room}`, `/api/provision` are more specific and still win; `GET /` catches the root, `/app.js`, `/lib/...`, and room slugs.)

- [ ] **Step 5:** `internal/server/static_test.go` — start a test Hub, `GET /` → 200 + `text/html` + body contains `id="app"`; `GET /app.js` → 200 + JS content; `GET /someroom` → 200 + the shell (not 404); `GET /healthz` → still `ok` (routes not shadowed). Run → PASS. Run `go test ./...`.

- [ ] **Step 6: Commit** `feat(webrtc-chat): embed and serve the browser client shell`.

---

### Task 2: lib/protocol.js — wire encode/decode + token parse (pure)

**Files:**
- Create: `internal/web/assets/lib/protocol.js`
- Create: `internal/web/test/protocol.test.js`

**Interfaces produced (used by signaling/peer/app):**
```js
export function encode(type, fields = {})   // -> JSON string {type, ...fields}
export function decode(text)                // -> {type, ...} object (throws on bad JSON / missing type)
export function parseToken(fragment)        // parseToken("#t=abc.def") -> "abc.def"; "" if absent
```

- [ ] **Step 1: Failing test** `internal/web/test/protocol.test.js`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { encode, decode, parseToken } from "../assets/lib/protocol.js";

test("encode injects type", () => {
  assert.equal(encode("join", { name: "alice" }), JSON.stringify({ type: "join", name: "alice" }));
  assert.equal(encode("leave"), JSON.stringify({ type: "leave" }));
});

test("decode round-trips and requires a type", () => {
  assert.deepEqual(decode('{"type":"chat","from":"a","text":"hi","ts":1}'), { type: "chat", from: "a", text: "hi", ts: 1 });
  assert.throws(() => decode("not json"));
  assert.throws(() => decode('{"no":"type"}'));
});

test("parseToken reads the URL fragment", () => {
  assert.equal(parseToken("#t=abc.def"), "abc.def");
  assert.equal(parseToken("#foo=1&t=xy.z"), "xy.z");
  assert.equal(parseToken(""), "");
  assert.equal(parseToken("#nothing"), "");
});
```

- [ ] **Step 2:** `nvm use && node --test internal/web/test/protocol.test.js` → FAIL (module missing).

- [ ] **Step 3: Implement** `internal/web/assets/lib/protocol.js`:
```js
// Pure wire protocol: JSON frames of {type, ...fields}. No browser globals.
export function encode(type, fields = {}) {
  return JSON.stringify({ type, ...fields });
}

export function decode(text) {
  const msg = JSON.parse(text);
  if (!msg || typeof msg.type !== "string") throw new Error("frame missing type");
  return msg;
}

// parseToken extracts the "t" value from a URL fragment like "#t=abc.def".
export function parseToken(fragment) {
  const hash = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  for (const pair of hash.split("&")) {
    const [k, v] = pair.split("=");
    if (k === "t" && v) return v;
  }
  return "";
}
```

- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(webrtc-chat): client wire protocol module with node tests`.

---

### Task 3: lib/negotiation.js — polite perfect negotiation (pure)

**Files:**
- Create: `internal/web/assets/lib/negotiation.js`
- Create: `internal/web/test/negotiation.test.js`

This is the load-bearing module the server's impolite side depends on (the client MUST roll
back on collision — Pion has no rollback, so the client owns it). Keep it PURE: it decides
WHAT to do given signaling state; `net/peer.js` performs the actual SDP calls. Model it as a
small decision function returning an action, so it's fully unit-testable.

**Interfaces produced (used by net/peer.js):**
```js
// Decide how to handle an inbound offer as the POLITE peer.
// state: { makingOffer: bool, signalingState: "stable"|"have-local-offer"|... }
// returns: { action: "ignore" }        // impolite would ignore; polite never ignores
//        | { action: "rollback-then-answer" }  // collision → roll back local offer, then answer
//        | { action: "answer" }         // no collision → just answer
export function handleRemoteOffer(state) { ... }
export const POLITE = true; // this client is always the polite peer
```

- [ ] **Step 1: Failing test** `internal/web/test/negotiation.test.js`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRemoteOffer } from "../assets/lib/negotiation.js";

test("no collision → answer", () => {
  assert.deepEqual(handleRemoteOffer({ makingOffer: false, signalingState: "stable" }), { action: "answer" });
});

test("collision while making an offer → polite rolls back then answers", () => {
  assert.deepEqual(handleRemoteOffer({ makingOffer: true, signalingState: "stable" }), { action: "rollback-then-answer" });
});

test("collision because not stable → rollback then answer", () => {
  assert.deepEqual(handleRemoteOffer({ makingOffer: false, signalingState: "have-local-offer" }), { action: "rollback-then-answer" });
});
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement** `internal/web/assets/lib/negotiation.js`:
```js
// Polite perfect-negotiation decisions (pure). The client is always polite:
// on an offer collision it rolls back its own offer, then answers the peer's.
// The server is impolite and keeps its offer, so this convergence is required.
export const POLITE = true;

export function handleRemoteOffer(state) {
  const collision = state.makingOffer || state.signalingState !== "stable";
  if (collision) return { action: "rollback-then-answer" };
  return { action: "answer" };
}
```

- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(webrtc-chat): polite perfect-negotiation decision module`.

---

### Task 4: lib/backoff.js (pure) + net/signaling.js (WS wrapper)

**Files:**
- Create: `internal/web/assets/lib/backoff.js`
- Create: `internal/web/test/backoff.test.js`
- Create: `internal/web/assets/net/signaling.js`

**Interfaces produced:**
```js
// backoff.js (pure)
export function backoffDelay(attempt, { base = 500, max = 10000, factor = 2 } = {})
// attempt 0 -> base, grows by factor, capped at max. Deterministic (no jitter in the pure fn;
// signaling adds a small random jitter on top).

// net/signaling.js  (browser: uses WebSocket)
export class Signaling {
  constructor(url)                 // url like `/ws/${room}` resolved to ws(s)://
  connect()                        // opens; auto-reconnects with backoff on unexpected close
  send(type, fields)               // encode + send (queued until open)
  on(type, handler)                // register inbound handler by message type
  stop()                           // permanent close, NO reconnect (used after kicked/banned/leave)
}
```
Signaling reconnect rule: reconnect on any close EXCEPT after `stop()`. The app calls `stop()`
when it receives `kicked`/`banned` or the user leaves. On `server-restarting`, the app does NOT
stop — it lets the socket drop and reconnect. `on("*", fn)` optional catch-all.

- [ ] **Step 1: Failing test** `internal/web/test/backoff.test.js`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { backoffDelay } from "../assets/lib/backoff.js";

test("backoff grows geometrically and caps", () => {
  assert.equal(backoffDelay(0), 500);
  assert.equal(backoffDelay(1), 1000);
  assert.equal(backoffDelay(2), 2000);
  assert.equal(backoffDelay(10), 10000); // capped at max
});
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement** `lib/backoff.js`:
```js
// Pure reconnect backoff: geometric growth capped at max. No jitter here (the
// caller adds jitter) so this is deterministic and testable.
export function backoffDelay(attempt, { base = 500, max = 10000, factor = 2 } = {}) {
  const d = base * Math.pow(factor, attempt);
  return Math.min(d, max);
}
```
Then implement `net/signaling.js` (browser). It: resolves `ws(s)://<host>/ws/<room>` from
`location`; on open, flushes a queued-send buffer and resets the attempt counter; on message,
`decode`s and dispatches to handlers registered by `type`; on unexpected close (not `stop()`),
schedules a reconnect after `backoffDelay(attempt++) + small jitter`. `stop()` sets a
`stopped` flag and closes with no reconnect. `node --test` does NOT cover `signaling.js`
(needs a real WebSocket) — verify by `node --check internal/web/assets/net/signaling.js` and
manually. The pure `backoff.js` carries the tested logic.

- [ ] **Step 4:** `node --test internal/web/test/backoff.test.js` → PASS; `node --check internal/web/assets/net/signaling.js` → clean.
- [ ] **Step 5: Commit** `feat(webrtc-chat): reconnect backoff and websocket signaling wrapper`.

---

### Task 5: net/media.js — devices, capture, mute/camera/screenshare *(browser, manual)*

**Files:** Create `internal/web/assets/net/media.js`.

**Interfaces produced (used by peer.js + ui):**
```js
export class Media extends EventTarget {
  async start()                       // getUserMedia({audio,video})
  async enumerate()                   // -> {cameras:[], mics:[]} from enumerateDevices
  async useDevices({cameraId, micId}) // switch devices via getUserMedia + track replace
  toggleMic() / toggleCamera()        // enable/disable the local track (returns new state)
  async startScreen()                 // getDisplayMedia; emits "screen-start" with the track
  stopScreen()                        // stop the screen track; emits "screen-stop"
  get micTrack() / cameraTrack() / screenTrack()
}
```
`media.js` only captures and manages devices/tracks; it does NOT set kind labels. The kind is
conveyed to the server by `peer.js` at publish time via the MSID **stream id** (see the
Global Constraints track-kind bullet): the browser can't set `track.id`, but it CAN set the
msid stream id through `addTransceiver(track, {direction:"sendonly", streamIds:[kind]})`. The
matching server change (SFU reads `remote.StreamID()` for kind) lands in Task 6. So Task 5 is
device/capture plumbing only; the kind mechanism is Task 6.

- [ ] **Step 1:** Implement `media.js` per the interface (start, enumerate, useDevices, toggles, screen). `node --check` it.
- [ ] **Step 2:** Add MANUAL-TEST.md items: "camera+mic preview appears", "device pickers switch source", "mute/camera toggles reflect in the tile", "screenshare starts/stops".
- [ ] **Step 3: Commit** `feat(webrtc-chat): client media capture and device management`.

---

### Task 6: net/peer.js + server kind-from-StreamID — negotiation + tracks *(browser + Go)*

**Files:** Create `internal/web/assets/net/peer.js`; Modify `internal/sfu/peer.go` (kind from `remote.StreamID()`) and `internal/sfu/{testclient_test.go,sfu_test.go}` (harness + assertion).

**Interfaces produced:**
```js
export class Peer extends EventTarget {
  constructor(signaling)              // uses Signaling.send/on for offer/answer/candidate
  async start(localTracks)            // add local tracks, create initial offer, send it
  async publish(track, kind)          // add a track mid-call (screenshare) -> triggers client offer
  unpublish(kind)                     // remove a track -> renegotiate
  // emits "remote-track" {participantId, kind, stream} using the server's `tracks` message
  // to label the mid; emits "peer-gone" when a stream ends
}
```
Behavior:
- One `RTCPeerConnection` (no ICE servers — public-IP SFU). `onicecandidate` → `signaling.send("candidate", {candidate})`.
- `onnegotiationneeded` (client-initiated, e.g. screenshare): guard with a `makingOffer` flag; create offer, setLocal, `send("offer",{sdp})`.
- On inbound `offer` (server renegotiation): consult `negotiation.handleRemoteOffer({makingOffer, signalingState})`. If `rollback-then-answer`, `await pc.setLocalDescription({type:"rollback"})` then setRemote(offer) + answer; if `answer`, setRemote(offer)+answer; send the answer.
- On inbound `answer`: `setRemoteDescription`.
- On inbound `candidate`: `addIceCandidate` (guard "remote description not set" by buffering until remote description exists).
- On inbound `tracks`: store mid→{participantId,kind}. On `ontrack`, look up `event.transceiver.mid` in that map to label the incoming stream, emit `"remote-track"`.
- **Publish each track with its kind as the MSID stream id:** `pc.addTransceiver(track, {direction:"sendonly", streamIds:[kind]})` (kind ∈ mic/camera/screen). This is the ONLY way the client can label a track's kind (track.id is read-only).

**Server-side counterpart (Go, automatically tested — do this in the same task):**
- [ ] **Step A (RED):** In `internal/sfu/testclient_test.go`, change the synthetic `publish` helper so its `NewTrackLocalStaticRTP` carries the **kind as the stream id** (the third arg), mirroring what a browser's `streamIds:[kind]` produces — e.g. `NewTrackLocalStaticRTP(cap, tc.id /*track id*/, kind /*stream id*/)`. Add/adjust a test asserting the server records BOTH a `camera` and a `screen` track from one publisher as distinct kinds (this FAILS today because `wireOnTrack` reads `remote.ID()` → both video tracks collapse to `camera`).
- [ ] **Step B (GREEN):** In `internal/sfu/peer.go` `wireOnTrack`, derive `kind` from `remote.StreamID()` instead of `remote.ID()` (keep the audio→mic / video→camera fallback for an unrecognized stream id). Run `go test -race ./internal/sfu/ ./internal/server/` — the camera-vs-screen test passes and all Plan-2 tests stay green (the local-track key stays `publisherID:kind`; only the source of `kind` changes).

**Client steps:**
- [ ] **Step 1:** Implement `peer.js` (negotiation via `lib/negotiation.js`, tracks via `addTransceiver` streamIds). `node --check` it.
- [ ] **Step 2:** Add MANUAL-TEST.md items: "two browsers see each other's video", "**screenshare shows as a separate tile, not replacing camera**", "third participant sees both others", "leaving removes the tile".
- [ ] **Step 3: Commit** `feat(webrtc-chat): client peer connection + server derives track kind from stream id`.

---

### Task 7: ui/prejoin.js + app.js routing *(browser, manual)*

**Files:** Create `internal/web/assets/ui/prejoin.js`; write `internal/web/assets/app.js` (replace the Task-1 stub).

**Pre-join screen:** camera/mic preview (local `Media.start()`), device pickers, the room's live
participant count (poll `GET /api/rooms/<slug>` every ~3s → `{count,locked}`), a display-name
field (hidden/read-only when a token supplies the nick), a password field shown only when
`locked`, and a **Join** button. Read the room slug from `location.pathname` and the token from
`location.hash` (`protocol.parseToken`).

**app.js** owns top-level state and routing:
```
boot(): parse slug + token; if no slug -> simple "create/enter a room" home; else render pre-join.
onJoin(): open Signaling; send join{name?,password?,token?}; on "joined" -> render in-call (Task 8/9);
          on "error" -> show the code (bad-password, banned, identified-only, not-provisioned, token-*)
          back on the pre-join screen.
```

- [ ] **Step 1:** Implement `prejoin.js` + `app.js` routing (pre-join ↔ in-call placeholder). `node --check` both.
- [ ] **Step 2:** MANUAL-TEST.md: "pre-join shows preview + live count", "locked room shows password field", "wrong password shows error and stays on pre-join", "join transitions to in-call".
- [ ] **Step 3: Commit** `feat(webrtc-chat): pre-join screen and app routing`.

---

### Task 8: ui/grid.js + ui/controls.js — tiles, active-speaker, controls *(browser, manual)*

**Files:** Create `internal/web/assets/ui/grid.js`, `internal/web/assets/ui/controls.js`; wire them from `app.js`.

**grid.js:** a responsive tile grid; one tile per participant (self + remotes from `Peer`'s
`remote-track` events). Each tile shows the participant name/role badge (`op`/`+voice`), the video
(camera or screen), and a muted/av indicator. **Active-speaker highlight:** use WebAudio
(`AudioContext` + `AnalyserNode`) on each audio stream to compute a level, highlight the loudest
tile. Screen-share renders as its own tile.

**controls.js:** local controls (mute, camera, screenshare start/stop, leave) wired to `Media`
and `Peer`; **op controls** — for an op (role from `joined`), each remote tile gets kick / mute /
ban actions (`signaling.send("kick"|"mute-peer"|"ban", {id,...})`) and a room lock toggle
(`set-lock`); non-ops don't see them. Reflect `muted` (server told this client an op muted it →
stop the track, show it) and `moderation` events.

- [ ] **Step 1:** Implement `grid.js` + `controls.js`; wire into `app.js`. `node --check`.
- [ ] **Step 2:** MANUAL-TEST.md: "grid lays out N tiles", "active speaker highlights", "mute/camera/screenshare controls work", "op sees kick/mute/ban + lock; non-op does not", "op kick removes the target for everyone", "op mute nudges the target (re-enableable)".
- [ ] **Step 3: Commit** `feat(webrtc-chat): tile grid, active-speaker, local and op controls`.

---

### Task 9: ui/chat.js + final wiring + manual checklist + deploy docs *(browser, manual + docs)*

**Files:** Create `internal/web/assets/ui/chat.js`; finalize `app.js`; create `internal/web/MANUAL-TEST.md`, `docs/DEPLOY.md`.

**chat.js:** a chat panel — send (`signaling.send("chat",{text})`), render inbound `chat{from,text,ts}`
(with the 200-message replay a late joiner receives), and render `moderation{actor,action,target,kind?}`
as feed lines ("alice kicked bob", "alice locked the room"). `room-locked`/`unlocked` update a lock
indicator.

**Final wiring in app.js — the reliability contract (verify carefully):**
- `kicked{by}` / `banned{by}`: `signaling.stop()` (NO reconnect), tear down the call, show why. This
  is the security-critical behavior Plan 2's Option B depends on — the client MUST close and not rejoin.
- `server-restarting`: show "reconnecting…", let the socket drop and reconnect via backoff (do NOT stop);
  on reconnect, re-send `join`.
- normal socket drop: reconnect with backoff + rejoin.
- `leave`/close tab: `signaling.stop()`.

**MANUAL-TEST.md** — the full checklist (accumulated from Tasks 5–9) an owner runs in ≥2 real
browsers: join/leave, video both ways, screenshare, chat + replay, device switching, active speaker,
op kick/mute/ban/lock, **kicked/banned client does NOT rejoin**, server-restart reconnect, glare
(op renegotiation while a client starts screenshare → both tracks converge — this is the browser-only
verification of the Pion-no-rollback path).

**docs/DEPLOY.md** — run behind Caddy/nginx (TLS termination for `getUserMedia`), the media UDP port
range + `-public-ip`, the `-secret` shared with the Anope module, `-adhoc`/`-trust-proxy` flags, and
the `!vc` → tokened-link → join flow. A minimal Caddyfile + systemd unit example.

- [ ] **Step 1:** Implement `chat.js`; finalize `app.js` wiring. `node --check` all JS.
- [ ] **Step 2:** Write `MANUAL-TEST.md` and `docs/DEPLOY.md`.
- [ ] **Step 3:** Full check: `go test ./... && go vet ./...`; `node --test internal/web/test/`; `node --check` every `assets/**/*.js`. Smoke: `go run ./cmd/webrtc-chat -public-ip 127.0.0.1`, open a browser to `/testroom`, confirm the shell + modules load with no console errors.
- [ ] **Step 4: Commit** `feat(webrtc-chat): chat panel, reliability wiring, manual checklist and deploy docs`.

---

## Plan 3 exit criteria

- `go test ./...` + `go vet ./...` green; `node --test internal/web/test/` green; every shipped
  `assets/**/*.js` passes `node --check`; the binary embeds and serves the client.
- Pure logic (protocol, negotiation incl. rollback, backoff) is unit-tested; browser modules are
  thin and covered by `MANUAL-TEST.md`.
- An owner-run manual session in ≥2 browsers passes the checklist: multi-party video, screenshare,
  chat + replay, op moderation, **kicked/banned does not rejoin**, server-restart reconnect, and
  glare convergence (the real-browser verification the Pion limitation requires).
- `docs/DEPLOY.md` lets an operator stand the service up behind a reverse proxy.
- Not in this plan: Playwright E2E, Prometheus, pprof, simulcast (all descoped/v2), and the Anope
  module (Plan 4). Plan 4 builds against `internal/token/testdata/vectors.json` + `/api/provision`
  and issues the `#t=…` tokened links this client consumes.
