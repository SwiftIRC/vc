# webrtc-chat — Design

**Date:** 2026-07-20
**Status:** Approved (brainstorming complete)

A self-hosted group video conferencing app to replace Jitsi Meet: a single Go
binary (Pion-based SFU) serving a vanilla JS browser client. Built for a
community/org deployment — multiple rooms, dozens of concurrent users, rooms of
6–15+ participants — with an emphasis on operational simplicity, low resource
footprint, and reliability.

## Motivation

Jitsi's stack (Prosody, Jicofo, JVB, nginx) is heavy to operate, resource
hungry, hard to customize, and has been shipping conference-stopping bugs.
This project replaces it with a codebase we own end-to-end, small enough to
understand fully.

## Goals

- Multi-party video/audio rooms (6–15+ participants per room, multiple rooms,
  dozens of concurrent users total) on a single node.
- Single static Go binary; no database, no external services. Deploy = copy
  binary + run behind a reverse proxy.
- Screen sharing.
- In-room text chat.
- Optional per-room access control (password lock), settable at creation or
  mid-call.
- Pre-join screen showing current participant count before joining.
- Self-healing clients and fault-isolated server — reliability designed in.

## Non-Goals (v1)

- Simulcast / adaptive quality layer switching (v2).
- Recording.
- Moderator roles / permissions (anyone in a room can lock/unlock it).
- Native mobile apps (mobile browsers are supported).
- Horizontal scale-out across multiple SFU nodes.
- Persistence of any kind — rooms, chat history, and passwords die with the
  room or the process.

## Architecture

One Go binary with four responsibilities:

1. **Static file server** — the vanilla JS client, embedded via `embed.FS`.
   `go build` produces the entire deployable.
2. **HTTP API** — `GET /api/rooms/{name}` → `{ "count": N, "locked": bool }`,
   polled by the pre-join screen.
3. **Signaling** — one WebSocket per participant at `/ws/{room}`, carrying
   JSON messages (join/leave, SDP, ICE, chat, room events).
4. **SFU media plane (Pion)** — one `PeerConnection` per participant. Each
   participant publishes mic + camera (+ screen share); the server forwards
   every published RTP track to all other participants in the room. Pion
   interceptors provide NACK, PLI, and receiver reports. v1 forwards a single
   encoding per track with a capped publish bitrate.

### Room model

- Rooms live in memory, created on demand: visiting `/{roomname}` and joining
  creates the room (meet.jit.si model).
- The first joiner may optionally set a password; anyone in the room may lock
  (set password) or unlock mid-call.
- Empty rooms are garbage-collected after a 60-second grace period (default).
- Server restart drops all calls; clients auto-rejoin (see Reliability).

### Network / deployment

- Media over UDP on a configurable port range; ICE-TCP fallback for
  UDP-hostile networks. Because the SFU has a public address, no TURN server
  is needed.
- HTTPS is required for `getUserMedia`: run behind a reverse proxy
  (Caddy/nginx) by default; optional built-in TLS via cert files.
- Config via flags/env: listen address, public IP, media port range, TLS cert
  paths. Nothing else.

## Signaling Protocol

JSON messages over the WebSocket.

Client → server:

| Message | Payload | Purpose |
|---|---|---|
| `join` | `name`, `password?`, `setPassword?` | Enter room. `password` authenticates into a locked room; `setPassword` locks the room at creation (first joiner only) |
| `offer` / `answer` | `sdp` | Negotiation |
| `candidate` | ICE candidate | Trickle ICE |
| `chat` | `text` | Send chat message |
| `set-lock` | `password?` (absent = unlock) | Lock/unlock room |
| `leave` | — | Clean exit |

Server → client:

| Message | Payload | Purpose |
|---|---|---|
| `joined` | `selfId`, `peers[]` | Join confirmed, current roster |
| `peer-joined` / `peer-left` | `id`, `name` | Roster changes |
| `offer` / `answer` | `sdp` | Negotiation |
| `candidate` | ICE candidate | Trickle ICE |
| `tracks` | `[{mid, participantId, kind}]` | Map transceiver mids to participants; `kind` ∈ `mic\|camera\|screen` |
| `chat` | `from`, `text`, `ts` | Chat fan-out (last 200 messages replayed to late joiners) |
| `room-locked` / `room-unlocked` | — | Lock state changes |
| `error` | `code`, `message` | E.g. wrong password |

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
- UI modules — pre-join screen, tile grid, chat panel.

UX: pre-join screen (camera/mic preview, device pickers, display name,
participant count, password field when locked, optional "lock this room" for
the first joiner); in-call tile grid with active-speaker highlighting (receiver
audio levels), mute/camera controls, screen-share tiles, chat panel.

## Reliability & Error Handling

- **Self-healing clients:** on WebSocket loss or ICE `failed`, full automatic
  teardown-and-rejoin with backoff. Chosen over session resumption for v1:
  drastically simpler, and simpler stays reliable.
- **Fault isolation:** per-room state and locking; panics recovered
  per-connection. One participant's bug cannot kill a room; one room's bug
  cannot kill the process.
- **Backpressure:** bounded per-client send queues — overflow disconnects that
  client (it auto-rejoins) rather than stalling the room. All WS writes carry
  deadlines; stalled participants are evicted via ping timeout.
- **Graceful restarts:** SIGTERM notifies clients, which show "reconnecting…"
  and rejoin-loop until the server returns. Upgrades cost seconds, not
  sessions.
- **Observability:** structured logs; Prometheus metrics endpoint (rooms,
  participants, per-track packet loss); pprof.

## Testing

1. **Unit** — room state machine, signaling message handling, lock logic.
2. **Integration (the reliability backbone)** — Pion as a synthetic client:
   start the real server, connect N fake participants publishing test tracks,
   assert RTP actually arrives at subscribers; cover join/leave churn and
   password flows. Full media-path coverage, no browser required.
3. **Browser E2E** — Playwright + Chromium fake media devices: join, video
   renders, chat, screen share.
4. **Load sanity** — script driving ~30 synthetic publishers across rooms to
   validate the target envelope on real hardware.

## Alternatives Considered

- **LiveKit + custom UI** — proven media plane, but we'd operate and debug
  someone else's SFU and depend on their client SDK; re-creates the Jitsi
  situation with better engineering.
- **Fork Galène** — fastest path, study-worthy Go/Pion codebase, but inherited
  architecture and a UI rebuild anyway.

## v2 Candidates

Simulcast with quality switching, recording, moderator roles, session
resumption (ICE restart instead of full rejoin), native clients.
