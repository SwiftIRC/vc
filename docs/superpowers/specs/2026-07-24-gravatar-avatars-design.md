# Gravatar avatars for camera-off tiles

## Problem

The camera-off placeholder shows the participant's initial in an IRC-palette
circle (see `2026-07-23-camera-off-avatar-placeholder-design.md`). We want an
optional upgrade: if a participant supplies an email, show their Gravatar image
in that same spot instead, for every participant — self and remote. The initial-
in-a-circle remains the fallback when there is no email, no Gravatar for it, or
the fetch fails.

## Decisions

- **Gravatar, keyed by email.** An optional email entered on the lobby join
  screen, saved locally. The image comes from gravatar.com.
- **All participants, not just self.** Remote peers' Gravatars show too, which
  means the email's hash must travel through the signaling protocol.
- **Only the hash leaves the browser.** The client computes a SHA-256 hex hash of
  the normalized email and sends that; the raw email is never transmitted and only
  ever lives in this browser's localStorage.
- **Camera-off spot only.** The Gravatar replaces the letter/color circle in the
  same place, and only there. No browser-tab favicon, no always-on avatar.
- **SHA-256, not MD5.** `crypto.subtle` provides SHA-256 in-browser with no
  dependency; Gravatar supports SHA-256 hashes. MD5 (Gravatar's legacy scheme)
  would need a bundled implementation and is out of scope.
- **Cosmetic, unverified.** The hash is user-supplied and unverified, exactly like
  a guest display name. Identity remains the token nick. A peer could present
  someone else's email hash; that is acceptable for a cosmetic avatar.

## Wire protocol — `internal/signal/messages.go`

Three new optional fields (`omitempty`), carrying the SHA-256 hex hash:

- `Join.Gravatar string \`json:"gravatar,omitempty"\`` — client → server on join.
- `PeerInfo.Gravatar string \`json:"gravatar,omitempty"\`` — in the `joined` roster,
  so late joiners get existing peers' Gravatars.
- `PeerJoined.Gravatar string \`json:"gravatar,omitempty"\`` — in the `peer-joined`
  broadcast, so present peers get a new joiner's Gravatar.

`PeerMediaState` (the mic/camera toggle broadcast) does NOT carry it — a Gravatar
never changes mid-session, so join-time roster + `peer-joined` are the only carriers.

## Server

### `internal/room/room.go`
- `Participant` gains `Gravatar string` (guarded by `Room.mu` like the other
  per-participant fields).
- Roster build (~line 206): add `Gravatar: q.Gravatar` to the `signal.PeerInfo`.
- Join broadcast (~line 218): add `Gravatar: p.Gravatar` to the `signal.PeerJoined`.

### `internal/server/server.go`
- After the name/role assignment (~line 232, in BOTH the tokened and guest
  branches — put it after the `if claims != nil { … } else { … }` block so it
  applies unconditionally): `p.Gravatar = sanitizeGravatar(join.Gravatar)`.
- `sanitizeGravatar(s string) string`: returns `s` if it matches
  `^[a-f0-9]{64}$` (a well-formed lowercase SHA-256 hex digest), else `""`.
  This blocks a malicious client from stuffing arbitrary text (URL/markup
  injection risk, since the value is echoed to every other client and used to
  build a URL) into the roster. Place it near the other `sanitize*`/helper funcs.
- No reconnect handling needed: the client re-sends `gravatar` in its join frame
  on every socket (re)open (`pendingJoin`), so a reconnecting Participant is
  reconstructed with its Gravatar intact.

## Client

### `internal/web/assets/lib/avatar.js`
- `async gravatarHash(email)`: `const e = (email || "").trim().toLowerCase(); if
  (!e) return "";` then SHA-256 via `crypto.subtle.digest("SHA-256", new
  TextEncoder().encode(e))`, hex-encode the bytes, return lowercase hex. Returns
  `""` if `crypto.subtle` is unavailable (non-secure context) — caught, not thrown.
- `gravatarUrl(hash, size)`: returns `""` if `hash` is not `^[a-f0-9]{64}$`;
  otherwise `https://www.gravatar.com/avatar/${hash}?d=404&s=${size}`. `d=404`
  makes Gravatar return HTTP 404 for an unknown email, which triggers our
  letter/color fallback (rather than Gravatar's own default image).
- Extend `applyAvatar(node, name, gravatar)` (third arg optional):
  1. Always paint the letter + bg + fg first (instant, correct fallback), and
     clear any prior `background-image` so a stale image can't linger.
  2. Stamp the node with the intended identity (e.g. a
     `node.dataset.avatarToken = gravatar || ""`) so a later `applyAvatar` call
     (rename / different peer / cleared email) supersedes an in-flight image load.
  3. If `gravatarUrl(gravatar, size)` is non-empty, load it via `new Image()`;
     on `load`, and only if `node.dataset.avatarToken` still equals this hash,
     set `node.style.backgroundImage = url(...)`, `backgroundSize:"cover"`,
     `backgroundPosition:"center"`, and clear `node.textContent` (Gravatars are
     opaque). On `error` (404 / offline / blocked), do nothing — the letter/color
     already shows. Pick `size` from the device: e.g. `Math.round(160 *
     (devicePixelRatio || 1))`, capped (e.g. 320), so retina tiles stay crisp.

### `internal/web/assets/ui/prejoin.js`
- Add an optional email `<input>` to the lobby form, near the display-name field:
  `type="email"`, `placeholder="Email for Gravatar (optional)"`, `autocomplete=
  "email"`, `maxlength` reasonable (e.g. 254). A one-line helptext is optional.
- Persist it under a new localStorage key `swiftirc-vc-email`, mirroring the
  existing `NAME_KEY`/`saveName`/`loadSavedName` (add `saveEmail`/`loadSavedEmail`
  next to them). Prefill from the saved value on mount.
- Keep a live hash: on email `input`, recompute `gravatarHash` (debounced or
  just awaited) and repaint the lobby self-preview
  (`applyAvatar(this.cameraOffAvatar, this._avatarName(), hash)`), so you see your
  own Gravatar before joining, `?`/initial until then.
- On `_submit`: `saveEmail(email)`, compute the hash, and pass it:
  `this.onJoin({ name, password, gravatar })`. Because `gravatarHash` is async,
  `_submit` (or the hash step) awaits it before calling `onJoin`.

### `internal/web/assets/app.js`
- `onJoin({ name, password, gravatar })`: store `selfGravatar = gravatar || ""`
  (alongside `selfName`) and include `gravatar` in `pendingJoin`, so every join /
  rejoin frame carries it.
- The self tile is painted with `selfGravatar`; the roster→tile path forwards each
  peer's `gravatar` (from `joined.peers[]` / `peer-joined`) into the grid.

### `internal/web/assets/ui/grid.js`
- The peer-add/roster path (self `_buildTile` and the remote add/refresh) accepts
  a `gravatar` and stores `tile.gravatar`, calling
  `applyAvatar(tile.camOffAvatar, name, tile.gravatar)`.
- `_setName` (and any repaint) passes `tile.gravatar` so the image survives a
  rename. Screen-share tiles are unaffected (still `.cam-off-icon`/`.cam-off-text`).

## Privacy & security

- Only the SHA-256 hash is transmitted or stored server-side; the raw email stays
  in this browser's localStorage. gravatar.com receives the hash (as every
  Gravatar consumer does).
- Server-side `sanitizeGravatar` validates the hash is a 64-char lowercase hex
  string before storing/relaying, so a crafted client cannot inject arbitrary
  content into the roster or the URL other clients build.
- The value is cosmetic and unverified. Identity/authorization is unchanged (token
  nick). This is the same trust level as the guest-supplied display name.
- No CSP is set by the server, so the external image is not blocked. `d=404` +
  `Image` `onerror` make the feature degrade to letter/color when offline or when
  gravatar.com is unreachable/blocked.

## Testing

### Go
- `internal/signal/messages_test.go`: a `join` frame with `gravatar` decodes into
  `Join.Gravatar`; `PeerInfo`/`PeerJoined` encode `gravatar` when set and omit it
  when empty (`omitempty`).
- `internal/room/room_test.go`: a participant that joined with a gravatar has it
  reflected in the roster (`joined` `PeerInfo`) sent to a later joiner and in the
  `peer-joined` broadcast to existing peers.
- `internal/server` (e.g. `dispatch_test.go`/`server_test.go` or a focused unit
  test): `sanitizeGravatar` accepts a valid 64-hex string, rejects wrong length,
  uppercase, non-hex, and empty (→ `""`); and a `Join` carrying a valid gravatar
  lands on the `Participant`.

### JS (`internal/web/test/avatar.test.js`)
- `gravatarHash` returns the known SHA-256 hex for a fixed email
  (pin a vector, e.g. the canonical Gravatar example
  `gravatarHash("MyEmailAddress@example.com ")` → the documented digest), lower-
  cases + trims (same input with different case/whitespace → same hash), and
  returns `""` for empty/whitespace input.
- `gravatarUrl` builds `.../avatar/<hash>?d=404&s=<n>` for a valid hash and returns
  `""` for a malformed hash (guards the injection surface on the client too).
- The async image swap inside `applyAvatar` is DOM + network and is NOT unit-
  tested; it is covered by `node --check` on the UI files plus manual browser
  verification. The synchronous letter/color fallback within `applyAvatar`
  remains covered by the existing `avatarFor` tests.

## Out of scope

- Browser-tab favicon.
- MD5 Gravatar hashes.
- Avatars anywhere but the camera-off placeholder.
- Verifying that a participant owns the email they hash.
