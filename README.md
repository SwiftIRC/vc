# SwiftIRC VC (webrtc-chat)

A self-hosted group video-conferencing app — a lightweight Jitsi replacement,
tied to the SwiftIRC network. One Go binary runs the whole thing: a Pion-based
**SFU** (selective forwarding unit), the **WebSocket signaling**, an **HTTP
API**, and the embedded **vanilla-JS browser client**. No database, no TURN, no
build step for the client.

## Why

Jitsi's stack (Prosody, Jicofo, JVB, nginx) is heavy to operate, resource
hungry, and hard to customize. This is a codebase small enough to understand
end-to-end (~3.7k lines of non-test Go plus a no-build-step JS client), that we
own and can wire natively into SwiftIRC.

## What it does

- Multi-party video/audio rooms (rooms of 6–15+, dozens of concurrent users on
  a single node).
- Screen sharing (its own tile, separate from your camera).
- In-room text chat with 200-message replay for late joiners.
- Op moderation: kick, ban, force-mute (a re-enableable nudge), stop a
  screenshare, and per-room password lock — driven by the participant's IRC op
  status, via signed tokens minted by the Anope module.
- Optional per-room password and identified-users-only mode.
- In-room polls: an op posts a question, everyone votes, tallies update live.
- Mic noise suppression (an AudioWorklet, on by default, opt-out).
- Background blur and virtual backgrounds (MediaPipe selfie segmentation, run
  entirely in the browser), with an automatic fall back to no effect on a device
  that cannot sustain a usable frame rate. The picker offers two rows: **Effects**
  (blur and procedurally-painted washes, drawn in code) and **Scenes** (photographic
  WebP backgrounds, discovered at build time from `internal/web/assets/img/` — drop
  one in and rebuild to add it; the Scenes row is omitted entirely if there are none).
  **Requires WebGL** — MediaPipe's vision graph is GL-based regardless of whether
  inference runs on the GPU or the CPU, so with hardware acceleration disabled the
  picker says so and offers only "None".
- Low-bandwidth mode: stop downloading *all* inbound video while keeping audio.
  Per-user and purely local — it changes only what you receive.
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
- **`internal/token`** — HMAC identity tokens (minted by the Anope module, verified here). Cross-implementation test vectors in `internal/token/testdata/vectors.json` are what keep the two implementations byte-identical.
- **`internal/signal`** — the JSON WebSocket wire protocol.
- **`internal/room`** — pure room state: join rules, roster, chat ring, moderation, countdown. No I/O, no Pion.
- **`internal/sfu`** — the media plane (Pion `webrtc/v4`): one PeerConnection per participant, forwarding each published track (VP8/Opus) to every other participant; perfect-negotiation with the server as the impolite peer.
- **`internal/server`** — the `Hub`: WebSocket join flow, signaling dispatch, HTTP API, static serving.
- **`internal/web`** — the embedded browser client (`assets/`), with `node --test`
  unit tests for its pure logic (`test/`). Two vendored payloads live here and
  account for most of the binary: the MediaPipe segmentation runtime
  (`assets/vendor/mediapipe/`, stored gzipped) and whichever background scenes are
  in `assets/img/` (~127 KB for the one in the repository, ~339 KB with all five of
  the author's local set). Both carry a README recording source, licence and
  checksums; read `assets/img/README.md` before redistributing a build. A binary
  from a clean clone is ~23.0 MiB, against 18,756,525 bytes before MediaPipe was
  vendored.
- **`cmd/webrtc-chat`** — the entrypoint.
- **`anope/m_webrtc_chat`** — the Anope 2.1 services module (C++): `!vc`/`!chat`
  fantasy commands, `VC SET`, HMAC token minting, and the `/api/provision` and
  `/api/invite` calls. Its `core/` is header-only and host-testable with no Anope
  SDK — `make -C anope/m_webrtc_chat/tests test`.

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
go test -race ./...                         # Go: unit + Pion synthetic-client media integration
go vet ./...
nvm use && node --test internal/web/test/   # client pure-logic unit tests (Node 22; .nvmrc)
make -C anope/m_webrtc_chat/tests test      # Anope module core (C++; no Anope SDK needed)
```

`internal/sfu`'s `TestThreeClientsFullMesh` is a known flake under CPU load
(roughly 8 failures in 20 runs on a loaded machine, none when idle). It is a
harness-timing problem, not a product one; re-run the package before investigating.

The browser client's DOM/media/WebRTC surface has no automated coverage — there is
no DOM harness, and adding one (jsdom) would mean the project's first npm
dependency and a `node_modules`, which the no-build-step client deliberately avoids.
It is verified by hand against **[MANUAL-TEST.md](MANUAL-TEST.md)** in ≥2 real
browsers, including glare convergence, which the in-process Pion tests cannot
exercise (Pion has no SDP rollback). Treat that checklist as load-bearing: the bugs
that have reached production in this codebase have overwhelmingly lived in exactly
that untested layer.

## Status

- **Server core** — config, tokens, protocol, room state + moderation, registry/GC, WebSocket hub, HTTP API, lifecycle. **Done.**
- **SFU media plane** — VP8/Opus forwarding, fan-out, PLI, tracks metadata, perfect-negotiation glare handling. **Done.**
- **Browser client** — pre-join, tile grid, chat, polls, moderation controls, screenshare, noise suppression, background effects, reliability wiring. **Done.**
- **Anope 2.1 module** — `!vc`/`!chat` fantasy commands, `VC SET`, HMAC token minting (against the shared test vectors), `/api/provision` and short `#i=` invite links via `/api/invite`. **Done** and deployed.

Design and implementation plans live in `docs/superpowers/`.

## License

[MIT](LICENSE) — for this project's own source.

The repository also carries third-party content that MIT does not cover, and
`//go:embed all:assets` puts all of it inside every binary — see
**[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)**. In short: the vendored
MediaPipe runtime is Apache-2.0, and the noise-suppression worklet bundles RNNoise
and core-js.

Background scenes are **discovered from what a build embedded**, not hard-coded, so
what ships is whatever is in `internal/web/assets/img/` at build time. Only
`carina.webp` (NASA/ESA/CSA/STScI) is in the repository; anything else is
git-ignored. Drop your own `.webp` in there and rebuild to add one.
