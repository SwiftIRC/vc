# SwiftIRC VC (webrtc-chat)

A self-hosted group video-conferencing app — a lightweight Jitsi replacement,
tied to the SwiftIRC network. One Go binary runs the whole thing: a Pion-based
**SFU** (selective forwarding unit), the **WebSocket signaling**, an **HTTP
API**, and the embedded **vanilla-JS browser client**. No database, no TURN, no
build step for the client.

## Why

Jitsi's stack (Prosody, Jicofo, JVB, nginx) is heavy to operate, resource
hungry, and hard to customize. This is a codebase small enough to understand
end-to-end (~2k lines of non-test Go plus a no-build-step JS client), that we
own and can wire natively into SwiftIRC.

## What it does

- Multi-party video/audio rooms (rooms of 6–15+, dozens of concurrent users on
  a single node).
- Screen sharing (its own tile, separate from your camera).
- In-room text chat with 200-message replay for late joiners.
- Op moderation: kick, ban, force-mute (a re-enableable nudge), stop a
  screenshare, and per-room password lock — driven by the participant's IRC op
  status (via signed tokens, in the planned Anope module).
- Optional per-room password and identified-users-only mode.
- Mic noise suppression (an AudioWorklet, on by default, opt-out).
- Background blur and virtual backgrounds (MediaPipe selfie segmentation, run
  entirely in the browser), with an automatic fall back to no effect on a device
  that cannot sustain a usable frame rate.
- Per-participant local volume, a mirrored self-view, and a shared countdown
  sound.
- Self-healing clients: reconnect on drop, ICE-restart on media failure, and —
  importantly — a kicked/banned client stops and does **not** rejoin.

## Architecture

```
                          ┌──────────────────────────── one Go binary ───────────────────────────┐
   browser  ── wss ───────┤  static files (embed)   HTTP API   WS signaling   Pion SFU (UDP RTP)  │
   (vanilla JS ES modules)│  internal/web           /api/...   /ws/{room}     internal/sfu        │
                          │                         internal/server (Hub)     internal/room       │
                          └───────────────────────────────────────────────────────────────────────┘
   media (RTP/UDP) ─────────────────────────────────────────► directly to the SFU's public IP
                          (NOT proxied by nginx — see docs/DEPLOY.md)
```

- **`internal/config`** — flags/env config.
- **`internal/token`** — HMAC identity tokens (issued by the future Anope module, verified here). Cross-implementation test vectors in `internal/token/testdata/vectors.json`.
- **`internal/signal`** — the JSON WebSocket wire protocol.
- **`internal/room`** — pure room state: join rules, roster, chat ring, moderation, countdown. No I/O, no Pion.
- **`internal/sfu`** — the media plane (Pion `webrtc/v4`): one PeerConnection per participant, forwarding each published track (VP8/Opus) to every other participant; perfect-negotiation with the server as the impolite peer.
- **`internal/server`** — the `Hub`: WebSocket join flow, signaling dispatch, HTTP API, static serving.
- **`internal/web`** — the embedded browser client (`assets/`), with `node --test`
  unit tests for its pure logic (`test/`). Includes the vendored MediaPipe
  segmentation runtime (`assets/vendor/mediapipe/`, stored gzipped — see its
  README), which is why the binary is 22,737,562 bytes (~21.7 MiB), up from
  18,756,525 bytes before it was vendored.
- **`cmd/webrtc-chat`** — the entrypoint.

## Build & run

Requires Go 1.26+.

```bash
go build -o webrtc-chat ./cmd/webrtc-chat
./webrtc-chat -addr :8080            # local dev (http; getUserMedia works on localhost)
```

Open `http://localhost:8080/<room>` in two browser tabs to try a call.

For a real deployment (TLS via a reverse proxy, the media UDP port range, and
`-public-ip`), see **[docs/DEPLOY.md](docs/DEPLOY.md)** — in particular, media
is UDP sent directly to the SFU and does **not** flow through nginx, so
`-public-ip` and an open UDP range are required or remote video will be black.

### Key flags

| Flag | Env | Default | Purpose |
|---|---|---|---|
| `-addr` | `WVC_ADDR` | `:8080` | HTTP listen address |
| `-public-ip` | `WVC_PUBLIC_IP` | _(empty)_ | Public IP advertised in ICE candidates — **required** for remote media |
| `-udp-min` / `-udp-max` | `WVC_UDP_MIN` / `_MAX` | `50000` / `50199` | Media UDP port range (open in the firewall) |
| `-secret` | `WVC_SECRET` | _(empty)_ | Shared HMAC secret for tokens + `/api/provision` (empty = ad-hoc rooms only) |
| `-adhoc` | `WVC_ADHOC` | `true` | Allow non-IRC rooms created on demand |
| `-trust-proxy` | `WVC_TRUST_PROXY` | `false` | Trust `X-Forwarded-For` (enable only behind a trusted proxy) |
| `-tls-cert` / `-tls-key` | `WVC_TLS_CERT` / `_KEY` | _(empty)_ | Optional built-in TLS |

## Testing

```bash
go test -race ./...                    # Go: unit + Pion synthetic-client media integration
go vet ./...
nvm use && node --test internal/web/test/   # client pure-logic unit tests (Node 22; .nvmrc)
```

The browser client's DOM/media/WebRTC surface is verified by hand against
**[internal/web/MANUAL-TEST.md](internal/web/MANUAL-TEST.md)** (and `MANUAL-TEST.md`
at the repo root) in ≥2 real browsers — including glare convergence, which the
in-process Pion tests can't exercise (Pion has no SDP rollback).

## Status

- **Server core** — config, tokens, protocol, room state + moderation, registry/GC, WebSocket hub, HTTP API, lifecycle. **Done.**
- **SFU media plane** — VP8/Opus forwarding, fan-out, PLI, tracks metadata, perfect-negotiation glare handling. **Done.**
- **Browser client** — pre-join, tile grid, chat, moderation controls, screenshare, noise suppression, reliability wiring. **Done.**
- **Anope 2.1 module** — `!vc`/`!chat` fantasy commands, `VC SET`, HMAC token minting (against the shared test vectors) and `/api/provision`. **Planned** (Plan 4).

Design and implementation plans live in `docs/superpowers/`.

## License

Not yet specified.
