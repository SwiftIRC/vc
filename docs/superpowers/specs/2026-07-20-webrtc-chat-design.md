# webrtc-chat — Design

**Date:** 2026-07-20 (revised same day: SwiftIRC integration + moderation)
**Status:** Approved (brainstorming complete)

A self-hosted group video conferencing app to replace Jitsi Meet, tied to the
SwiftIRC network: a single Go binary (Pion-based SFU) serving a vanilla JS
browser client, plus an Anope 2.1 services module that binds IRC channels to
video rooms. Built for a community/org deployment — multiple rooms, dozens of
concurrent users, rooms of 6–15+ participants — with an emphasis on
operational simplicity, low resource footprint, and reliability.

## Motivation

Jitsi's stack (Prosody, Jicofo, JVB, nginx) is heavy to operate, resource
hungry, hard to customize, and has been shipping conference-stopping bugs.
This project replaces it with a codebase we own end-to-end, small enough to
understand fully — and integrates it natively with SwiftIRC: every channel can
have a video room, run by the channel's own operators.

## Goals

- Multi-party video/audio rooms (6–15+ participants per room, multiple rooms,
  dozens of concurrent users total) on a single node.
- Single static Go binary; no database, no external services. Deploy = copy
  binary + run behind a reverse proxy.
- SwiftIRC integration via an Anope 2.1 module: `!vc` / `!chat` in a channel
  hands out that channel's room link; channel ops hold op powers in the room.
- In-room moderation: kick, mute/cut-video nudges, instance bans, room lock —
  op-only.
- Screen sharing.
- In-room text chat.
- Optional per-room access control: password lock (op-set) and an
  identified-users-only mode.
- Pre-join screen showing current participant count before joining.
- Self-healing clients and fault-isolated server — reliability designed in.

## Non-Goals (v1)

- Simulcast / adaptive quality layer switching (v2).
- Recording.
- Live IRC↔room role sync — roles are snapshots taken when `!vc` is run
  (live mode-change push is a v2 candidate; the token design doesn't preclude
  it).
- Extra powers for voiced users (they get a `+` badge, nothing more).
- Native mobile apps (mobile browsers are supported).
- Horizontal scale-out across multiple SFU nodes.
- Persistence in webrtc-chat — live rooms, chat history, and bans die with the
  instance or the process. (Channel→room bindings and settings persist in
  Anope, which is authoritative.)

## Architecture

Two deliverables:

### 1. webrtc-chat — one Go binary

1. **Static file server** — the vanilla JS client, embedded via `embed.FS`.
   `go build` produces the entire deployable.
2. **HTTP API** —
   - `GET /api/rooms/{name}` → `{ "count": N, "locked": bool }`, polled by
     the pre-join screen.
   - `POST /api/provision` (authenticated with the shared secret) — the Anope
     module pushes `{channel, room, settings}` snapshots here on every `!vc`.
3. **Signaling** — one WebSocket per participant at `/ws/{room}`, carrying
   JSON messages (join/leave, SDP, ICE, chat, moderation, room events).
4. **SFU media plane (Pion)** — one `PeerConnection` per participant. Each
   participant publishes mic + camera (+ screen share); the server forwards
   every published RTP track to all other participants in the room. Pion
   interceptors provide NACK, PLI, and receiver reports. v1 forwards a single
   encoding per track with a capped publish bitrate.

### 2. m_webrtc_chat — Anope 2.1 services module

C++ module for SwiftIRC's services:

- **`!vc` / `!chat` fantasy commands** (and `/msg ChanServ VC #channel` for
  botless channels). Anyone in the channel may run them. The bot replies
  in-channel with the room's public URL and NOTICEs the invoker a personal
  tokenized link if they are identified with NickServ.
- **Settings** (`VC SET #chan …`, op/founder-gated, stored on the channel in
  Anope's data store — Anope is authoritative):
  - `ENABLED ON|OFF` — channel has a room at all.
  - `IDENTIFIED ON|OFF` — room requires a token to join (no guests).
  - `ROOM <slug>` — rename the channel's room. Default slug is derived from
    the channel name; the module enforces slug uniqueness across channels so
    no channel can claim another's room.
- **Provisioning** — on every `!vc`, POST the current settings snapshot to
  webrtc-chat's `/api/provision`.

### Room model

Two layers with different lifetimes:

- **Room identity (persistent, lives in Anope):** the binding
  `#channel → room slug + settings`. Never expires; the URL `!vc` posts today
  works next month.
- **Live call instance (ephemeral, in webrtc-chat memory):** participants,
  PeerConnections, chat history, ban list. Created when the first person
  joins; garbage-collected 60 seconds (default) after the last person leaves.
  Clicking the stable URL either joins the ongoing instance or starts a fresh
  one.

Channel rooms are provisioned by the module (or by a token's embedded settings
snapshot — see Tokens); a guest hitting an unprovisioned channel room sees
"this room isn't active yet — run !vc in #channel."

**Ad-hoc rooms** (no IRC channel) remain, behind a server config flag
(default on; the SwiftIRC deployment may run channel-rooms-only). Visiting
`/{roomname}` and joining creates one. Same moderation machinery: the first
joiner becomes op.

### Network / deployment

- Media over UDP on a configurable port range; ICE-TCP fallback for
  UDP-hostile networks. Because the SFU has a public address, no TURN server
  is needed.
- HTTPS is required for `getUserMedia`: run behind a reverse proxy
  (Caddy/nginx) by default; optional built-in TLS via cert files.
- Config via flags/env: listen address, public IP, media port range, TLS cert
  paths, shared secret, ad-hoc-rooms flag.

## Identity & Tokens

- Format: `base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload))`,
  hand-rolled (no JWT library). Shared secret configured in both `anope.conf`
  and webrtc-chat.
- Payload: channel, room slug, NickServ account, display nick, role
  (`op` | `voice` | `user`), settings snapshot, issued-at, expiry
  (~10 minutes to click the link; once joined, the session persists).
- Delivery: in the URL fragment (`https://vc.swiftirc.net/room#t=…`) so it
  never reaches server logs or proxies; client JS reads the fragment and sends
  the token inside the WebSocket `join`.
- Roles are snapshots as of the `!vc` invocation. Deopped mid-call? Room op
  status persists until you leave; re-run `!vc` to refresh.
- The settings snapshot inside the token doubles as a provisioning fallback:
  a tokened join after a webrtc-chat restart re-provisions the room.

**Guest policy:** guests (no token) may join via the public URL with a
self-typed display name, subject to the room password if locked — unless the
channel sets `IDENTIFIED ON`. Tokened users display their IRC nick,
immutable, and voiced users get a `+` badge.

## Moderation

Two effective in-room tiers: **op** and **participant**.

Op powers (op-only signaling messages):

- **Kick** — remove from the live instance; rejoining is allowed unless
  banned.
- **Mute / cut video / stop screenshare** — a *nudge*: the target's track is
  stopped but they may re-enable themselves (IRC-style social enforcement,
  not a gag).
- **Ban from instance** — kick + barred from the current live instance.
  Tokened users are banned by NickServ account (solid); guests by IP
  (best-effort, documented as such). Ban list dies when the room empties.
- **Lock** — set/clear the room password. Op-only.

Every moderation action is announced in the room's chat feed
("alice kicked bob") — moderation is visible, like channel modes.

## Signaling Protocol

JSON messages over the WebSocket.

Client → server:

| Message | Payload | Purpose |
|---|---|---|
| `join` | `name?`, `password?`, `token?` | Enter room. `token` carries identity/role for channel rooms; `name` is the guest display name; `password` for locked rooms |
| `offer` / `answer` | `sdp` | Negotiation |
| `candidate` | ICE candidate | Trickle ICE |
| `chat` | `text` | Send chat message |
| `set-lock` | `password?` (absent = unlock) | Lock/unlock room (op-only) |
| `kick` | `id` | Kick participant (op-only) |
| `mute-peer` | `id`, `kind` (`mic`\|`camera`\|`screen`) | Stop a peer's track, re-enableable (op-only) |
| `ban` | `id` | Ban from instance (op-only) |
| `leave` | — | Clean exit |

Server → client:

| Message | Payload | Purpose |
|---|---|---|
| `joined` | `selfId`, `role`, `peers[]` | Join confirmed, current roster with roles/badges |
| `peer-joined` / `peer-left` | `id`, `name`, `role` | Roster changes |
| `offer` / `answer` | `sdp` | Negotiation |
| `candidate` | ICE candidate | Trickle ICE |
| `tracks` | `[{mid, participantId, kind}]` | Map transceiver mids to participants; `kind` ∈ `mic\|camera\|screen` |
| `chat` | `from`, `text`, `ts` | Chat fan-out (last 200 messages replayed to late joiners) |
| `moderation` | `actor`, `action`, `target`, `kind?` | Moderation event for the chat feed |
| `kicked` / `banned` | `by` | You were removed; client must NOT auto-rejoin |
| `muted` | `kind` | An op stopped one of your tracks; you may re-enable |
| `room-locked` / `room-unlocked` | — | Lock state changes |
| `error` | `code`, `message` | E.g. wrong password, token invalid/expired, identified-only, room not provisioned |

### Negotiation

Perfect-negotiation pattern with fixed roles: the **server is the impolite
peer** and drives renegotiation whenever room tracks change; the client (polite)
initiates renegotiation only for its own track changes (screen share
start/stop). On offer collision the client rolls back and applies the server's
offer. One authority, no glare bugs.

## Media Plane

- Codecs: **VP8 + Opus** everywhere (broadest browser compatibility, Pion's
  most solid path).
- Per participant, up to three published tracks: mic (Opus), camera (VP8,
  capped at ~800 kbps by default), screen (VP8, content-hint `detail`, capped
  at ~1.5 Mbps by default).
- Server `OnTrack` → fan out RTP to each other participant's PeerConnection;
  relay PLI so new subscribers get keyframes promptly.
- The `tracks` metadata message keeps UI tiles correctly labeled as tracks
  come and go.

## Client

Vanilla JS, native ES modules, **no build step** — the files in the repo are
the files the browser runs. Evergreen-browser baseline, no legacy shims.

Modules:

- `signaling.js` — WebSocket wrapper, reconnect with backoff.
- `media.js` — device enumeration, getUserMedia, mute/camera toggles.
- `peer.js` — RTCPeerConnection, polite side of perfect negotiation.
- UI modules — pre-join screen, tile grid, chat panel, moderation controls.

UX: pre-join screen (camera/mic preview, device pickers, participant count,
display-name field for guests / IRC nick shown for tokened users, password
field when locked); in-call tile grid with active-speaker highlighting
(receiver audio levels), mute/camera controls, screen-share tiles, chat panel
with moderation events; ops get per-tile moderation controls (kick, mute,
ban) and the lock toggle.

## Reliability & Error Handling

- **Self-healing clients:** on WebSocket loss or ICE `failed`, full automatic
  teardown-and-rejoin with backoff. Exception: after `kicked` / `banned`, the
  client stops and shows why — no rejoin-looping past moderation.
- **Fault isolation:** per-room state and locking; panics recovered
  per-connection. One participant's bug cannot kill a room; one room's bug
  cannot kill the process.
- **Backpressure:** bounded per-client send queues — overflow disconnects that
  client (it auto-rejoins) rather than stalling the room. All WS writes carry
  deadlines; stalled participants are evicted via ping timeout.
- **Graceful restarts:** SIGTERM notifies clients, which show "reconnecting…"
  and rejoin-loop until the server returns. Upgrades cost seconds, not
  sessions. Channel rooms re-provision via token snapshots or the next `!vc`.
- **Integration degradation:** if webrtc-chat is down, `!vc` still posts the
  URL but the module reports the room unreachable; if Anope is down, existing
  rooms keep running (webrtc-chat never depends on Anope at runtime).
- **Observability:** structured logs; Prometheus metrics endpoint (rooms,
  participants, per-track packet loss); pprof.

## Testing

1. **Unit** — room state machine, signaling message handling, lock logic,
   token validation (Go side), token generation (module side).
2. **Integration (the reliability backbone)** — Pion as a synthetic client:
   start the real server, connect N fake participants publishing test tracks,
   assert RTP actually arrives at subscribers; cover join/leave churn,
   password flows, token/role flows, and moderation actions (kick/ban/mute
   semantics). Full media-path coverage, no browser required.
3. **Module tests** — token generation against Go-side validation (shared
   test vectors so both implementations agree byte-for-byte); settings
   storage/retrieval against a dev Anope 2.1 instance.
4. **Browser E2E** — Playwright + Chromium fake media devices: join, video
   renders, chat, screen share, op controls.
5. **Load sanity** — script driving ~30 synthetic publishers across rooms to
   validate the target envelope on real hardware.

## Alternatives Considered

- **LiveKit + custom UI** — proven media plane, but we'd operate and debug
  someone else's SFU and depend on their client SDK; re-creates the Jitsi
  situation with better engineering.
- **Fork Galène** — fastest path, study-worthy Go/Pion codebase, but inherited
  architecture and a UI rebuild anyway.
- **Live IRC↔room role sync** — truest mirror of the channel, but adds a live
  integration path that can fail/desync; snapshot tokens chosen for v1.
- **webrtc-chat-side settings store** — rejected; two stateful systems to
  sync and back up. Anope already persists channel data and is where ops live.

## v2 Candidates

Simulcast with quality switching, recording, live role sync (mode-change push
from the module), session resumption (ICE restart instead of full rejoin),
sticky moderator mutes, native clients.
