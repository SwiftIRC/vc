# webrtc-chat Plan 2: SFU Media Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working server-side Pion SFU: participants publish mic/camera/screen tracks over their existing WebSocket-signalled PeerConnection, and the server forwards each published track's RTP to every other participant in the room — verified end-to-end with in-process Pion synthetic clients (no browser).

**Architecture:** A new `internal/sfu` package holds one `*webrtc.PeerConnection` per participant (`sfu.Peer`) plus a per-room registry (`sfu.SFU`). One shared `*webrtc.API` (VP8+Opus, NACK/PLI/report interceptors, ephemeral UDP port range + NAT-1:1 public IP) builds every PC. The client offers first (publishing its tracks); the server answers, captures each remote track via `OnTrack` into a publisher-keyed `TrackLocalStaticRTP`, and runs a `signalPeerConnections` pass that adds every published track to every *other* peer and renegotiates them with a server-initiated offer (the server is the impolite peer; client-initiated renegotiation — screenshare — is reconciled with perfect-negotiation glare handling). A periodic PLI dispatch keeps keyframes flowing to late subscribers. The `signal.Tracks` message maps each subscriber's transceiver mid to `{participantId, kind}`. Media state lives entirely in `internal/sfu`; `internal/room` stays pure and Pion-free.

**Tech Stack:** Go 1.26, `github.com/pion/webrtc/v4` (+ its `interceptor`, `media` subpackages), the existing `github.com/coder/websocket` signaling, `internal/{config,signal,server,room}` from Plan 1 (on `master`).

**Spec:** `docs/superpowers/specs/2026-07-20-webrtc-chat-design.md` (Media Plane + Negotiation + Testing sections).

## Global Constraints

- Module `github.com/ryanwohara/webrtc-chat`, `go 1.26`. Add `github.com/pion/webrtc/v4` (latest v4).
- Codecs: **VP8 (video) + Opus (audio) only.** Register exactly these on the media engine.
- **Track-kind contract (wire contract with the Plan 3 client):** the client sets each published track's ID to its kind string — `"mic"`, `"camera"`, or `"screen"`. The server reads `remoteTrack.ID()` to get the kind. Audio ID is `"mic"`; video ID is `"camera"` or `"screen"`.
- The server is the **impolite** peer (wins glare); the client is polite. Client offers initially and for its own track changes (screenshare); the server offers for subscriber-track changes (someone else published/left).
- A peer never receives its **own** published tracks back.
- Media UDP on `cfg.UDPPortMin..UDPPortMax` (default 50000–50199); advertise `cfg.PublicIP` via NAT-1:1 when set. No TURN.
- `internal/room` must not import Pion or `internal/sfu`. The SFU reaches clients only through a `Signaler` (`Send(v any) bool`) — satisfied by the existing `*wsClient`.
- Commit messages carry **NO `Co-Authored-By` trailer** (plain conventional-commit subject + body).
- `go test ./...` and `go test -race ./internal/sfu/ ./internal/server/` must pass at every commit. `go vet ./...` clean.
- Media integration tests use **Pion synthetic clients in-process** — never a browser. Keep them bounded (short timeouts, `t.Cleanup` closes every PC/ws) so the suite stays fast and leak-free.

## File Structure

```
internal/sfu/
  engine.go          — Engine: the shared *webrtc.API (media engine + interceptors + SettingEngine). NewEngine(cfg).
  engine_test.go
  signaler.go        — Signaler interface; trackKey/kind helpers; small pure helpers (no Pion).
  peer.go            — Peer: one *webrtc.PeerConnection; HandleOffer/HandleAnswer/HandleCandidate; perfect-negotiation state; wires OnTrack/OnICECandidate/OnConnectionStateChange to the owning SFU.
  peer_test.go
  sfu.go             — SFU: per-room peer registry; AddPeer/RemovePeer; addLocalTrack/removeLocalTrack; signalPeerConnections; dispatchKeyFrame ticker.
  sfu_test.go
  testclient_test.go — synthetic Pion client harness used by the integration tests (in-package _test file).
  integration_test.go— end-to-end: N synthetic clients, publish, assert RTP fan-out, tracks metadata, leave cleanup.
internal/server/
  server.go          — MODIFY: Hub gets an *sfu.SFU; NewHub builds it; serve wires Join/Leave and the offer/answer/candidate cases.
  media_test.go      — server-level test: a synthetic client joins via the real Hub and completes negotiation.
cmd/webrtc-chat/
  main.go            — MODIFY: build the SFU engine from cfg and pass into NewHub (constructor signature change ripples here).
```

Dependency direction: `server → sfu → signal`, `sfu → config`. `sfu` never imports `room`. `room` unchanged.

### Task overview
1. Media engine (`sfu.Engine`): shared `*webrtc.API` with VP8/Opus + interceptors + port range / public IP.
2. Signaler + SFU/Peer scaffolding: per-room registry, peer PC lifecycle, ICE-candidate signaling, connection-state cleanup. (Integration: synthetic client reaches `connected`.)
3. Publisher capture: `OnTrack` → publisher-keyed `TrackLocalStaticRTP`; RTP read loop.
4. Fan-out + `signalPeerConnections`: add others' tracks, server-initiated renegotiation, exclude own tracks. (Integration: 2 clients, RTP flows.)
5. `tracks` metadata message on (re)negotiation.
6. Keyframe/PLI dispatch (ticker + on new subscriber).
7. Leave cleanup: drop departed peer's tracks, renegotiate subscribers.
8. Perfect-negotiation glare handling for client-initiated (screenshare) renegotiation.
9. Wire into `Hub.serve` + `main.go`; end-to-end integration test (mic+camera+screen across 3 clients).

---

### Task 1: Media engine — shared *webrtc.API

**Files:**
- Create: `internal/sfu/engine.go`
- Create: `internal/sfu/engine_test.go`
- Modify: `go.mod` / `go.sum` (add `github.com/pion/webrtc/v4`)

**Interfaces:**
- Consumes: `config.Config` (`UDPPortMin`, `UDPPortMax`, `PublicIP`).
- Produces:
```go
type Engine struct { api *webrtc.API }
func NewEngine(cfg config.Config) (*Engine, error)
func (e *Engine) NewPeerConnection() (*webrtc.PeerConnection, error) // one PC, no ICE servers (public-IP SFU)
```

**Design notes for the implementer:**
- Build a `*webrtc.MediaEngine`, register exactly VP8 (`webrtc.MimeTypeVP8`, 90000, PT 96) and Opus (`webrtc.MimeTypeOpus`, 48000, 2ch, PT 111) as `RTPCodecTypeVideo`/`RTPCodecTypeAudio`.
- Build an `*interceptor.Registry`; `webrtc.RegisterDefaultInterceptors(m, i)` (gives NACK, RTCP reports, TWCC). Add a PLI-friendly path by also registering the default set — the default interceptors include the necessary NACK generator/responder. (PLI is sent explicitly by the SFU in Task 6 via `pc.WriteRTCP`.)
- `webrtc.SettingEngine{}`: `SetEphemeralUDPPortRange(uint16(cfg.UDPPortMin), uint16(cfg.UDPPortMax))`; if `cfg.PublicIP != ""`, `SetNAT1To1IPs([]string{cfg.PublicIP}, webrtc.ICECandidateTypeHost)`.
- `webrtc.NewAPI(webrtc.WithMediaEngine(m), webrtc.WithInterceptorRegistry(i), webrtc.WithSettingEngine(s))`.
- `NewPeerConnection` uses `webrtc.Configuration{}` (empty ICEServers — the SFU has a public address).

- [ ] **Step 1: Add the dependency**

```bash
cd /home/rohara/Workspace/webrtc-chat && go get github.com/pion/webrtc/v4@latest && go mod tidy
```

- [ ] **Step 2: Write the failing test**

`internal/sfu/engine_test.go`:

```go
package sfu

import (
	"testing"

	"github.com/pion/webrtc/v4"

	"github.com/ryanwohara/webrtc-chat/internal/config"
)

func TestNewEngineBuildsPeerConnections(t *testing.T) {
	e, err := NewEngine(config.Config{UDPPortMin: 50000, UDPPortMax: 50050})
	if err != nil {
		t.Fatal(err)
	}
	pc, err := e.NewPeerConnection()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pc.Close() })
	if pc.ConnectionState() != webrtc.PeerConnectionStateNew {
		t.Errorf("new PC state = %v, want new", pc.ConnectionState())
	}
}

func TestEngineRejectsInvalidPortRange(t *testing.T) {
	// min > max must surface as an error from the setting engine.
	if _, err := NewEngine(config.Config{UDPPortMin: 60000, UDPPortMax: 50000}); err == nil {
		t.Fatal("want error for inverted UDP range")
	}
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `go test ./internal/sfu/`
Expected: FAIL — `undefined: NewEngine`.

- [ ] **Step 4: Implement the engine**

`internal/sfu/engine.go`:

```go
// Package sfu is the selective-forwarding media plane: one PeerConnection per
// participant, forwarding each published RTP track to every other participant
// in the room. It reaches clients only through a Signaler; it never imports
// internal/room.
package sfu

import (
	"fmt"

	"github.com/pion/interceptor"
	"github.com/pion/webrtc/v4"

	"github.com/ryanwohara/webrtc-chat/internal/config"
)

// Engine holds the shared, immutable WebRTC API used to build every peer's
// PeerConnection with the project's codecs, interceptors, and ICE settings.
type Engine struct {
	api *webrtc.API
}

func NewEngine(cfg config.Config) (*Engine, error) {
	m := &webrtc.MediaEngine{}
	if err := m.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000},
		PayloadType:        96,
	}, webrtc.RTPCodecTypeVideo); err != nil {
		return nil, fmt.Errorf("register vp8: %w", err)
	}
	if err := m.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2},
		PayloadType:        111,
	}, webrtc.RTPCodecTypeAudio); err != nil {
		return nil, fmt.Errorf("register opus: %w", err)
	}

	i := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(m, i); err != nil {
		return nil, fmt.Errorf("interceptors: %w", err)
	}

	s := webrtc.SettingEngine{}
	if cfg.UDPPortMin > cfg.UDPPortMax {
		return nil, fmt.Errorf("udp range %d>%d", cfg.UDPPortMin, cfg.UDPPortMax)
	}
	if err := s.SetEphemeralUDPPortRange(uint16(cfg.UDPPortMin), uint16(cfg.UDPPortMax)); err != nil {
		return nil, fmt.Errorf("udp port range: %w", err)
	}
	if cfg.PublicIP != "" {
		s.SetNAT1To1IPs([]string{cfg.PublicIP}, webrtc.ICECandidateTypeHost)
	}

	api := webrtc.NewAPI(
		webrtc.WithMediaEngine(m),
		webrtc.WithInterceptorRegistry(i),
		webrtc.WithSettingEngine(s),
	)
	return &Engine{api: api}, nil
}

// NewPeerConnection builds one PeerConnection. No ICE servers: the SFU is
// reachable at its public address, so host candidates suffice.
func (e *Engine) NewPeerConnection() (*webrtc.PeerConnection, error) {
	return e.api.NewPeerConnection(webrtc.Configuration{})
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `go test ./internal/sfu/ -v`
Expected: both tests PASS. (If `SetEphemeralUDPPortRange` does not itself reject min>max on this Pion version, the explicit `min>max` guard above still makes `TestEngineRejectsInvalidPortRange` pass.)

- [ ] **Step 6: Commit**

```bash
git add go.mod go.sum internal/sfu/
git commit -m "feat(webrtc-chat): sfu media engine with vp8/opus and ephemeral port range"
```

---

### Task 2: SFU/Peer scaffolding — lifecycle, ICE signaling, synthetic-client harness

**Files:**
- Create: `internal/sfu/signaler.go`
- Create: `internal/sfu/sfu.go`
- Create: `internal/sfu/peer.go`
- Create: `internal/sfu/testclient_test.go`
- Create: `internal/sfu/sfu_test.go`

**Interfaces:**
- Consumes: `sfu.Engine` (Task 1), `internal/signal`.
- Produces (used by Tasks 3–9 and the Hub in Task 9):
```go
type Signaler interface{ Send(v any) bool }               // *wsClient satisfies this

type SFU struct{ /* ... */ }
func NewSFU(engine *Engine, log *slog.Logger) *SFU
func (s *SFU) AddPeer(slug, peerID string, sig Signaler) (*Peer, error) // builds the PC, wires handlers
func (s *SFU) RemovePeer(slug, peerID string)                            // close PC, drop tracks, renegotiate others (Task 7)

type Peer struct{ /* ... */ }
func (p *Peer) HandleOffer(sdp string) error       // setRemote(offer) → answer → sig.Send(signal.Answer)
func (p *Peer) HandleAnswer(sdp string) error       // setRemote(answer)
func (p *Peer) HandleCandidate(raw json.RawMessage) error
```

**Design notes:**
- `SFU` holds `rooms map[string]*mroom`; `mroom{ peers map[string]*Peer; tracks map[string]*localTrack }` guarded by `SFU.mu`. `localTrack{ publisherID, kind string; track *webrtc.TrackLocalStaticRTP }`. Task 2 only populates `peers`; `tracks` fan-out is Tasks 3–4.
- `AddPeer`: `pc,_ := engine.NewPeerConnection()`; set `pc.OnICECandidate` → on non-nil candidate, `sig.Send(signal.Candidate{Candidate: json})` (marshal `c.ToJSON()`); set `pc.OnConnectionStateChange` → on `Failed`/`Closed`, `s.RemovePeer(slug, peerID)`. Store the peer. `OnTrack` is added in Task 3.
- `HandleOffer`: `pc.SetRemoteDescription({Offer, sdp})`; `answer,_ := pc.CreateAnswer(nil)`; `pc.SetLocalDescription(answer)`; `sig.Send(signal.Answer{SDP: answer.SDP})`. (Perfect-negotiation glare guard added in Task 8; for now a plain offer/answer.)
- `HandleCandidate`: unmarshal the raw into `webrtc.ICECandidateInit`, `pc.AddICECandidate(init)`.
- The client's ICE candidate JSON is the browser `RTCIceCandidateInit` shape (`{"candidate": "...", "sdpMid": "...", "sdpMLineIndex": N}`); `webrtc.ICECandidateInit` unmarshals from it directly.

- [ ] **Step 1: Write the signaler + a signalerFunc adapter, then the failing connect test**

`internal/sfu/signaler.go`:
```go
package sfu

// Signaler delivers server→client signaling frames (offer/answer/candidate/
// tracks). *server.wsClient satisfies it via Send(v any) bool.
type Signaler interface {
	Send(v any) bool
}

// SignalerFunc adapts a function to Signaler (used by tests and simple wiring).
type SignalerFunc func(v any) bool

func (f SignalerFunc) Send(v any) bool { return f(v) }
```

`internal/sfu/testclient_test.go` (the synthetic Pion client used by every media test):
```go
package sfu

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/ryanwohara/webrtc-chat/internal/signal"
)

// clientAPI builds a browser-like client API (same codecs, default interceptors).
func clientAPI(t *testing.T) *webrtc.API {
	t.Helper()
	m := &webrtc.MediaEngine{}
	if err := m.RegisterDefaultCodecs(); err != nil {
		t.Fatal(err)
	}
	i := &interceptor.Registry{} // github.com/pion/interceptor (v4.2.17 has no webrtc.InterceptorRegistry)
	if err := webrtc.RegisterDefaultInterceptors(m, i); err != nil {
		t.Fatal(err)
	}
	return webrtc.NewAPI(webrtc.WithMediaEngine(m), webrtc.WithInterceptorRegistry(i))
}

// testClient is a synthetic in-process peer: a client-side PeerConnection whose
// signaling is looped back into an SFU Peer. It plays the browser's role
// (polite peer): answers server offers, sends its own offer when it publishes.
type testClient struct {
	t         *testing.T
	id        string
	server    *Peer
	pc        *webrtc.PeerConnection
	gotTrack  chan *webrtc.TrackRemote
	gotTracks chan signal.Tracks
}

func newTestClient(t *testing.T, s *SFU, slug, id string) *testClient {
	t.Helper()
	pc, err := clientAPI(t).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	tc := &testClient{t: t, id: id, pc: pc,
		gotTrack: make(chan *webrtc.TrackRemote, 16), gotTracks: make(chan signal.Tracks, 16)}
	t.Cleanup(func() { pc.Close() })

	server, err := s.AddPeer(slug, id, SignalerFunc(func(v any) bool { tc.fromServer(v); return true }))
	if err != nil {
		t.Fatal(err)
	}
	tc.server = server

	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		raw, _ := json.Marshal(c.ToJSON())
		_ = tc.server.HandleCandidate(raw)
	})
	pc.OnTrack(func(tr *webrtc.TrackRemote, _ *webrtc.RTPReceiver) { tc.gotTrack <- tr })
	return tc
}

// fromServer handles a signaling frame the SFU sent to this client.
func (tc *testClient) fromServer(v any) {
	switch m := v.(type) {
	case signal.Offer:
		if err := tc.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: m.SDP}); err != nil {
			return
		}
		ans, err := tc.pc.CreateAnswer(nil)
		if err != nil {
			return
		}
		if err := tc.pc.SetLocalDescription(ans); err != nil {
			return
		}
		_ = tc.server.HandleAnswer(ans.SDP)
	case signal.Answer:
		_ = tc.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: m.SDP})
	case signal.Candidate:
		var init webrtc.ICECandidateInit
		if json.Unmarshal(m.Candidate, &init) == nil {
			_ = tc.pc.AddICECandidate(init)
		}
	case signal.Tracks:
		tc.gotTracks <- m
	}
}

// publish adds a track (kind = "mic"|"camera"|"screen") and drives a client offer.
func (tc *testClient) publish(kind string) *webrtc.TrackLocalStaticRTP {
	tc.t.Helper()
	mime := webrtc.MimeTypeVP8
	if kind == "mic" {
		mime = webrtc.MimeTypeOpus
	}
	track, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: mime}, kind /*track ID = kind*/, tc.id /*stream ID*/)
	if err != nil {
		tc.t.Fatal(err)
	}
	if _, err := tc.pc.AddTrack(track); err != nil {
		tc.t.Fatal(err)
	}
	offer, err := tc.pc.CreateOffer(nil)
	if err != nil {
		tc.t.Fatal(err)
	}
	if err := tc.pc.SetLocalDescription(offer); err != nil {
		tc.t.Fatal(err)
	}
	if err := tc.server.HandleOffer(offer.SDP); err != nil {
		tc.t.Fatal(err)
	}
	return track
}

// waitConnected fails if the client PC does not reach Connected in time.
func (tc *testClient) waitConnected() {
	tc.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if tc.pc.ConnectionState() == webrtc.PeerConnectionStateConnected {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	tc.t.Fatalf("client %s never connected (state %v)", tc.id, tc.pc.ConnectionState())
}
```

`internal/sfu/sfu_test.go`:
```go
package sfu

import (
	"log/slog"
	"strings"
	"testing"

	"github.com/ryanwohara/webrtc-chat/internal/config"
)

func testSFU(t *testing.T) *SFU {
	t.Helper()
	e, err := NewEngine(config.Config{UDPPortMin: 0, UDPPortMax: 0}) // 0,0 => any ephemeral port
	if err != nil {
		t.Fatal(err)
	}
	return NewSFU(e, slog.New(slog.NewTextHandler(&strings.Builder{}, nil)))
}

func TestPeerConnectsAfterPublish(t *testing.T) {
	s := testSFU(t)
	c := newTestClient(t, s, "room", "p1")
	c.publish("camera")
	c.waitConnected()
}
```

Note: `NewEngine` with `UDPPortMin:0, UDPPortMax:0` — `SetEphemeralUDPPortRange(0,0)` means "any port". Confirm the min>max guard in engine.go treats `0,0` as valid (0 is not > 0). It does.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/sfu/ -run TestPeerConnectsAfterPublish`
Expected: FAIL — `undefined: NewSFU` / `AddPeer`.

- [ ] **Step 3: Implement sfu.go and peer.go**

`internal/sfu/sfu.go`:
```go
package sfu

import (
	"log/slog"
	"sync"

	"github.com/pion/webrtc/v4"
)

type localTrack struct {
	publisherID string
	kind        string // mic|camera|screen
	track       *webrtc.TrackLocalStaticRTP
}

type mroom struct {
	peers  map[string]*Peer
	tracks map[string]*localTrack // key = publisherID + ":" + kind
}

type SFU struct {
	engine *Engine
	log    *slog.Logger
	mu     sync.Mutex
	rooms  map[string]*mroom
}

func NewSFU(engine *Engine, log *slog.Logger) *SFU {
	return &SFU{engine: engine, log: log, rooms: map[string]*mroom{}}
}

func (s *SFU) roomLocked(slug string) *mroom {
	r := s.rooms[slug]
	if r == nil {
		r = &mroom{peers: map[string]*Peer{}, tracks: map[string]*localTrack{}}
		s.rooms[slug] = r
	}
	return r
}

func (s *SFU) AddPeer(slug, peerID string, sig Signaler) (*Peer, error) {
	pc, err := s.engine.NewPeerConnection()
	if err != nil {
		return nil, err
	}
	p := &Peer{id: peerID, slug: slug, sfu: s, sig: sig, pc: pc}

	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		raw, err := candidateJSON(c)
		if err != nil {
			return
		}
		sig.Send(candidateMsg(raw))
	})
	pc.OnConnectionStateChange(func(st webrtc.PeerConnectionState) {
		if st == webrtc.PeerConnectionStateFailed || st == webrtc.PeerConnectionStateClosed {
			s.RemovePeer(slug, peerID)
		}
	})
	p.wireOnTrack() // Task 3 fills this in; a no-op stub in Task 2

	s.mu.Lock()
	s.roomLocked(slug).peers[peerID] = p
	s.mu.Unlock()
	return p, nil
}

func (s *SFU) RemovePeer(slug, peerID string) {
	s.mu.Lock()
	r := s.rooms[slug]
	if r == nil {
		s.mu.Unlock()
		return
	}
	p := r.peers[peerID]
	delete(r.peers, peerID)
	// Task 7 also deletes this peer's published tracks here and renegotiates others.
	empty := len(r.peers) == 0
	if empty {
		delete(s.rooms, slug)
	}
	s.mu.Unlock()
	if p != nil {
		p.pc.Close()
	}
}
```

`internal/sfu/peer.go`:
```go
package sfu

import (
	"encoding/json"

	"github.com/pion/webrtc/v4"

	"github.com/ryanwohara/webrtc-chat/internal/signal"
)

type Peer struct {
	id   string
	slug string
	sfu  *SFU
	sig  Signaler
	pc   *webrtc.PeerConnection
}

func (p *Peer) HandleOffer(sdp string) error {
	if err := p.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: sdp}); err != nil {
		return err
	}
	answer, err := p.pc.CreateAnswer(nil)
	if err != nil {
		return err
	}
	if err := p.pc.SetLocalDescription(answer); err != nil {
		return err
	}
	p.sig.Send(signal.Answer{SDP: answer.SDP})
	return nil
}

func (p *Peer) HandleAnswer(sdp string) error {
	return p.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: sdp})
}

func (p *Peer) HandleCandidate(raw json.RawMessage) error {
	var init webrtc.ICECandidateInit
	if err := json.Unmarshal(raw, &init); err != nil {
		return err
	}
	return p.pc.AddICECandidate(init)
}

// wireOnTrack is filled in by Task 3 (publisher capture + fan-out). Stub now.
func (p *Peer) wireOnTrack() {}

// --- signaling helpers (kept here so sfu.go stays Pion-focused) ---

func candidateJSON(c *webrtc.ICECandidate) (json.RawMessage, error) {
	return json.Marshal(c.ToJSON())
}
func candidateMsg(raw json.RawMessage) signal.Candidate {
	return signal.Candidate{Candidate: raw}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/sfu/ -run TestPeerConnectsAfterPublish -v`
Expected: PASS (client and server complete offer/answer + ICE and reach Connected; typically < 1s on loopback).

- [ ] **Step 5: Run the package with the race detector**

Run: `go test -race ./internal/sfu/`
Expected: PASS, no data race. (If `OnICECandidate`/`OnConnectionStateChange` callbacks race `AddPeer`'s map write, guard the store as shown — the store happens after handlers are set but the callbacks only fire once ICE starts, i.e. after `HandleOffer`.)

- [ ] **Step 6: Commit**

```bash
git add internal/sfu/
git commit -m "feat(webrtc-chat): sfu peer lifecycle, ice signaling, synthetic client harness"
```

---

### Shared test helpers (build in Task 3; referenced by Tasks 3–9)

Add these to `internal/sfu/sfu_test.go` when Task 3 first needs them. Every later
task reuses them verbatim.

```go
import (
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

// waitFor polls pred until true or a 5s deadline (fatal on timeout).
func waitFor(t *testing.T, pred func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if pred() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("condition not met before deadline")
}

// writeTestRTP writes n minimal RTP packets to a local track (enough to make the
// server's OnTrack fire and the read loop run).
func writeTestRTP(t *testing.T, track *webrtc.TrackLocalStaticRTP, n int) {
	t.Helper()
	for i := 0; i < n; i++ {
		pkt := &rtp.Packet{
			Header:  rtp.Header{Version: 2, SequenceNumber: uint16(i), Timestamp: uint32(i * 3000), SSRC: 0x1234},
			Payload: []byte{0x90, 0x00, 0x00, 0x00, 0x00},
		}
		if err := track.WriteRTP(pkt); err != nil {
			t.Fatalf("WriteRTP: %v", err)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// writeTestRTPLoop writes RTP in the background until the test ends.
func writeTestRTPLoop(t *testing.T, track *webrtc.TrackLocalStaticRTP) {
	t.Helper()
	stop := make(chan struct{})
	t.Cleanup(func() { close(stop) })
	go func() {
		seq := 0
		for {
			select {
			case <-stop:
				return
			default:
			}
			track.WriteRTP(&rtp.Packet{
				Header:  rtp.Header{Version: 2, SequenceNumber: uint16(seq), Timestamp: uint32(seq * 3000), SSRC: 0x1234},
				Payload: []byte{0x90, 0x00, 0x00, 0x00, 0x00},
			})
			seq++
			time.Sleep(20 * time.Millisecond)
		}
	}()
}

// test-only accessors on *SFU (guarded by s.mu):
func (s *SFU) trackCount(slug string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r := s.rooms[slug]; r != nil {
		return len(r.tracks)
	}
	return 0
}
func (s *SFU) firstTrackKey(slug string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r := s.rooms[slug]; r != nil {
		for k := range r.tracks {
			return k
		}
	}
	return ""
}
```

(`github.com/pion/rtp` arrives transitively with `pion/webrtc/v4`; `go mod tidy`
in Task 1 records it. The `trackCount`/`firstTrackKey` accessors live in the
`_test.go` file so they never ship in the binary.)

---

### Task 3: Publisher capture — OnTrack into a publisher-keyed local track

**Files:** Modify `internal/sfu/sfu.go`, `internal/sfu/peer.go`; add test to `internal/sfu/sfu_test.go`.

**Interfaces produced (used by Tasks 4, 6, 7):**
```go
func (s *SFU) addLocalTrack(publisherID, kind string, remote *webrtc.TrackRemote) (*webrtc.TrackLocalStaticRTP, error)
func (s *SFU) removeLocalTrack(slug, key string)
// key convention: publisherID + ":" + kind
```

**Design:** `wireOnTrack` sets `pc.OnTrack`. On a remote track: read `remote.ID()` as
the kind (`mic`/`camera`/`screen`; default by RTP kind if empty — audio→`mic`,
video→`camera`), create a `TrackLocalStaticRTP` with the remote's codec, ID
`kind`, stream ID `publisherID`; register it under `publisherID:kind` in the
room's `tracks`; run `signalPeerConnections` (Task 4); then copy RTP
`remote.Read` → `local.Write` in a loop until EOF, and on exit `removeLocalTrack`
+ `signalPeerConnections` again.

- [ ] **Step 1: Failing test** — one client publishes a camera track; assert the
SFU stored exactly one local track keyed `p1:camera`.

```go
func TestPublishStoresLocalTrack(t *testing.T) {
	s := testSFU(t)
	c := newTestClient(t, s, "room", "p1")
	track := c.publish("camera")
	c.waitConnected()
	// write a few RTP packets so OnTrack fires on the server
	writeTestRTP(t, track, 5)
	waitFor(t, func() bool { return s.trackCount("room") == 1 })
	if key := s.firstTrackKey("room"); key != "p1:camera" {
		t.Errorf("track key = %q, want p1:camera", key)
	}
}
```
(Add test-only helpers `trackCount`/`firstTrackKey` on `*SFU` guarded by `s.mu`;
`writeTestRTP` writes N minimal VP8 RTP packets to a `*TrackLocalStaticRTP` via
`track.WriteRTP(&rtp.Packet{...})`; `waitFor` polls a predicate with a 5s bound.)

- [ ] **Step 2:** Run → FAIL (OnTrack is a stub; `trackCount` undefined).
- [ ] **Step 3:** Implement `wireOnTrack`, `addLocalTrack`, `removeLocalTrack`, and the test helpers. `wireOnTrack`:
```go
func (p *Peer) wireOnTrack() {
	p.pc.OnTrack(func(remote *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		kind := remote.ID()
		if kind != "mic" && kind != "camera" && kind != "screen" {
			if remote.Kind() == webrtc.RTPCodecTypeAudio {
				kind = "mic"
			} else {
				kind = "camera"
			}
		}
		local, err := p.sfu.addLocalTrack(p.id, kind, remote)
		if err != nil {
			return
		}
		defer p.sfu.removeLocalTrack(p.slug, p.id+":"+kind)
		buf := make([]byte, 1500)
		for {
			n, _, err := remote.Read(buf)
			if err != nil {
				return
			}
			if _, err := local.Write(buf[:n]); err != nil {
				return
			}
		}
	})
}
```
`addLocalTrack` creates the `TrackLocalStaticRTP` (`webrtc.NewTrackLocalStaticRTP(remote.Codec().RTPCodecCapability, kind, publisherID)`), stores it under `s.mu`, then calls `s.signalPeerConnections(slug)` (Task 4). `removeLocalTrack` deletes + `signalPeerConnections`.
- [ ] **Step 4:** Run → PASS; `go test -race ./internal/sfu/`.
- [ ] **Step 5:** Commit `feat(webrtc-chat): sfu captures published tracks into forwardable local tracks`.

---

### Task 4: Fan-out — signalPeerConnections (the heart)

**Files:** Modify `internal/sfu/sfu.go`; add test to `internal/sfu/sfu_test.go`.

**Interfaces produced:**
```go
func (s *SFU) signalPeerConnections(slug string) // sync every peer's senders to the track set, renegotiate changed peers
```

**Design (adapted from pion/example sfu-ws):** under `s.mu`, snapshot the room's
`peers` and `tracks`. For each peer P:
1. Build the set of track keys P already sends (`existing`) from `P.pc.GetSenders()` (a sender's `Track()` is a `*TrackLocalStaticRTP` whose `StreamID()`=publisherID, `ID()`=kind → key). Remove any sender whose key is no longer in `tracks` (`P.pc.RemoveTrack(sender)`).
2. For each `tracks` entry whose `publisherID != P.id` and not in `existing`, `P.pc.AddTrack(local.track)`.
3. If P's sender set changed, mark P for renegotiation.
Then, OUTSIDE the lock, for each changed P: `offer,_ := P.pc.CreateOffer(nil)`; `P.pc.SetLocalDescription(offer)`; `P.sig.Send(signal.Offer{SDP: offer.SDP})`; also send the `tracks` metadata (Task 5). Retry the whole pass up to 25× with a 20ms backoff if any `CreateOffer` fails with "signaling state" (a renegotiation is mid-flight) — matching sfu-ws's resilience.

**Concurrency:** do PC mutations (RemoveTrack/AddTrack) under `s.mu` to keep the
track set consistent, but do CreateOffer/SetLocal/Send after releasing the lock
(they can block). Never hold `s.mu` across a `sig.Send`.

- [ ] **Step 1: Failing test** — two clients; p1 publishes camera; assert p2 receives a track via `OnTrack` and RTP flows.
```go
func TestFanOutDeliversTrackToOtherPeer(t *testing.T) {
	s := testSFU(t)
	p1 := newTestClient(t, s, "room", "p1")
	p2 := newTestClient(t, s, "room", "p2")
	p2.publish("mic") // p2 must offer too so it has a live PC to receive on
	p2.waitConnected()
	track := p1.publish("camera")
	p1.waitConnected()
	writeTestRTPLoop(t, track) // background writer until test ends
	select {
	case tr := <-p2.gotTrack:
		if tr.StreamID() != "p1" {
			t.Errorf("received track stream = %q, want p1", tr.StreamID())
		}
		// read at least one RTP packet through the fan-out
		buf := make([]byte, 1500)
		tr.SetReadDeadline(time.Now().Add(5 * time.Second))
		if _, _, err := tr.Read(buf); err != nil {
			t.Fatalf("no RTP forwarded: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("p2 never received p1's track")
	}
}
```
- [ ] **Step 2:** Run → FAIL (no fan-out; `signalPeerConnections` empty/undefined).
- [ ] **Step 3:** Implement `signalPeerConnections` per the design above. Wire it into `addLocalTrack`/`removeLocalTrack` (Task 3 already calls it). Key helper: derive a sender's key:
```go
func senderKey(snd *webrtc.RTPSender) (string, bool) {
	t := snd.Track()
	if t == nil { return "", false }
	return t.StreamID() + ":" + t.ID(), true
}
```
- [ ] **Step 4:** Run → PASS; `go test -race ./internal/sfu/`. This is the milestone: media actually forwards.
- [ ] **Step 5:** Commit `feat(webrtc-chat): sfu fan-out with server-initiated renegotiation`.

---

### Task 5: tracks metadata message

**Files:** Modify `internal/sfu/sfu.go` (emit during renegotiation); test in `sfu_test.go`.

**Design:** whenever the server sends a renegotiation offer to peer P, also send
`signal.Tracks{Tracks: []signal.TrackInfo{...}}` mapping each of P's inbound
transceivers to `{Mid, ParticipantID, Kind}`. Build it from the transceivers P
receives: for each `P.pc.GetTransceivers()` with a receiving direction and a
`Receiver().Track()==nil` at negotiation time, correlate by the local track added
in the same pass. Simpler and robust: build `TrackInfo` from the tracks the SFU
just added to P (publisherID + kind are known); the mid is
`sender.Transceiver().Mid()` — send after `SetLocalDescription` so mids are assigned.

- [ ] **Step 1: Failing test** — extend Task 4's two-client test: assert p2 receives a `signal.Tracks` entry with `participantId=="p1"`, `kind=="camera"`, non-empty `mid`.
```go
	select {
	case tks := <-p2.gotTracks:
		found := false
		for _, ti := range tks.Tracks {
			if ti.ParticipantID == "p1" && ti.Kind == "camera" && ti.Mid != "" {
				found = true
			}
		}
		if !found { t.Errorf("tracks msg missing p1/camera: %+v", tks) }
	case <-time.After(5 * time.Second):
		t.Fatal("no tracks metadata")
	}
```
- [ ] **Step 2:** Run → FAIL. **Step 3:** emit `signal.Tracks` in `signalPeerConnections` after `SetLocalDescription`, mapping the added senders (`senderKey` → publisherID/kind; `sender.Transceiver().Mid()` → mid). **Step 4:** PASS + race. **Step 5:** Commit `feat(webrtc-chat): sfu emits tracks metadata on renegotiation`.

---

### Task 6: Keyframe / PLI dispatch

**Files:** Modify `internal/sfu/sfu.go`, `internal/sfu/peer.go`; test in `sfu_test.go`.

**Design:** two triggers. (a) When a new subscriber sender is added for a video
track in `signalPeerConnections`, request a keyframe from that video's publisher
so the new subscriber decodes promptly. (b) A per-room `time.Ticker` (3s) calls
`dispatchKeyFrame(slug)`. To send PLI to a publisher, write RTCP on the
publisher's PC for the remote SSRC: keep the `*webrtc.TrackRemote` (or its SSRC)
alongside each `localTrack`, and `publisherPeer.pc.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: uint32(ssrc)}})`.
Start the ticker when a room's first peer is added; stop it when the room empties
(in `RemovePeer`).

- [ ] **Step 1: Failing test** — a "publisher" client that counts inbound PLI
(`pc.OnTrack` → read RTCP via `receiver.Read`, or simpler: assert the publisher's
`TrackRemote`... ) Concretely: have `testClient.publish` return a handle whose
RTCP RTP-sender reads report a PLI within the ticker interval. Assert ≥1 PLI
received within 5s of a second peer subscribing.
- [ ] **Step 2:** Run → FAIL. **Step 3:** store `ssrc webrtc.SSRC` in `localTrack`; add `dispatchKeyFrame`; PLI on new video subscriber + a 3s ticker per room. **Step 4:** PASS + race. **Step 5:** Commit `feat(webrtc-chat): sfu PLI keyframe requests for new and ongoing subscribers`.

---

### Task 7: Leave cleanup — drop tracks, renegotiate subscribers

**Files:** Modify `internal/sfu/sfu.go` (`RemovePeer`); test in `sfu_test.go`.

**Design:** `RemovePeer` already removes the peer + closes its PC. Extend it to
also delete every `tracks` entry whose `publisherID == peerID`, then
`signalPeerConnections(slug)` so remaining peers drop the departed sender (each
gets a renegotiation offer). Stop the room's PLI ticker and delete the room only
when no peers remain.

- [ ] **Step 1: Failing test** — p1 publishes, p2 subscribes (receives track), then `s.RemovePeer("room","p1")`; assert p2's transceiver for p1's track goes inactive / p2 receives a renegotiation and the track key is gone from the room.
- [ ] **Step 2:** Run → FAIL. **Step 3:** implement the track-drop + renegotiate in `RemovePeer`. **Step 4:** PASS + race. **Step 5:** Commit `feat(webrtc-chat): sfu drops departed peer tracks and renegotiates subscribers`.

---

### Task 8: Perfect-negotiation glare (client-initiated screenshare renegotiation)

**Files:** Modify `internal/sfu/peer.go` (add glare state), `internal/sfu/sfu.go` (set `makingOffer` around server offers); test in `sfu_test.go`.

**Design (server = impolite):** add per-peer state guarded by `Peer.mu`:
`makingOffer bool`. In `signalPeerConnections`, set `makingOffer=true` before
`CreateOffer`, clear it after `SetLocalDescription` (or on error). In
`HandleOffer` (an offer arriving from the client), detect a collision:
`collision := p.makingOffer || p.pc.SignalingState() != webrtc.SignalingStateStable`.
Because the server is impolite, on collision it **ignores** the client's offer
(return nil without answering) — the polite client rolls back and re-offers once
the server's offer settles. Otherwise proceed with the normal setRemote→answer.
This lets a client add a screenshare track mid-call without deadlocking against a
concurrent server renegotiation.

- [ ] **Step 1: Failing test** — p1 publishes camera and connects; a second peer p2 joins and publishes (forcing server renegotiation of p1); at nearly the same moment p1 publishes screenshare (client offer). Assert the session converges: p1 ends Connected and p2 eventually receives BOTH p1 tracks (camera + screen). Drive the race by calling `p1.publish("screen")` immediately after adding p2.
- [ ] **Step 2:** Run → likely FAIL/flaky without glare handling (offer collision errors). **Step 3:** add `makingOffer`/collision handling. **Step 4:** PASS, and run `-count=20 -race` to confirm the convergence is stable. **Step 5:** Commit `fix(webrtc-chat): perfect-negotiation glare handling for client renegotiation`.

---

### Task 9: Wire into Hub.serve + main.go + end-to-end integration

**Files:** Modify `internal/server/server.go`, `cmd/webrtc-chat/main.go`; create `internal/sfu/integration_test.go` and `internal/server/media_test.go`.

**Interfaces:** `NewHub` gains an `*sfu.SFU` parameter (or Hub builds it from an
injected `*sfu.Engine`). Prefer: `NewHub(cfg, reg, log, now, mediaSFU *sfu.SFU)`;
update all `NewHub` call sites (server tests + main.go). `main.go` builds
`engine,_ := sfu.NewEngine(cfg)` and `sfu.NewSFU(engine, log)`.

**serve wiring** (in `internal/server/server.go`), after `rm.Join` succeeds and
`defer rm.Leave(p.ID)`:
```go
	mp, err := h.sfu.AddPeer(slug, p.ID, c) // c (*wsClient) satisfies sfu.Signaler
	if err != nil {
		reject(c, signal.Error{Code: "media", Message: "media setup failed"})
		return
	}
	defer h.sfu.RemovePeer(slug, p.ID)
	...
	case *signal.Offer:
		if err := mp.HandleOffer(m.SDP); err != nil { h.log.Debug("offer", "err", err) }
	case *signal.Answer:
		if err := mp.HandleAnswer(m.SDP); err != nil { h.log.Debug("answer", "err", err) }
	case *signal.Candidate:
		if err := mp.HandleCandidate(m.Candidate); err != nil { h.log.Debug("candidate", "err", err) }
```
(Change the read loop to bind the concrete message: `switch m := v.(type)` so
`m.SDP`/`m.Candidate` are available.)

- [ ] **Step 1:** `internal/server/media_test.go` — a synthetic client (reuse the sfu harness pattern, but drive signaling through a real WebSocket to the Hub) joins a room, publishes, and reaches Connected. This proves the Hub↔SFU wiring end-to-end over the real signaling path.
- [ ] **Step 2:** `internal/sfu/integration_test.go` — three clients in one room; each publishes mic+camera, one adds screen; assert every client receives the other two's tracks (2 peers × {mic,camera} = 4 inbound, +1 screen) and RTP flows on each. Bounded timeouts; `t.Cleanup` closes all.
- [ ] **Step 3:** Update `NewHub` signature + all call sites + `main.go`. Run `go build ./...`.
- [ ] **Step 4:** Full verification: `go vet ./... && go test -race ./...`. Smoke: `go run ./cmd/webrtc-chat -public-ip 127.0.0.1 &` then confirm `/healthz` and a WS join still work; kill.
- [ ] **Step 5:** Commit `feat(webrtc-chat): wire sfu media plane into the hub and main`.

---

## Plan 2 exit criteria

- `go test -race ./...` green; `go vet ./...` clean; binary builds.
- Three in-process Pion clients in a room see each other's mic/camera/screen RTP forwarded; `tracks` metadata labels every inbound track by `{participantId, kind}`; a leaving publisher's tracks are renegotiated away; a client-initiated screenshare converges under glare.
- `internal/room` still imports no Pion. Moderation/chat/lifecycle from Plan 1 unaffected (their tests stay green).
- Not in this plan: the browser client + Playwright E2E (Plan 3), Prometheus metrics + pprof, simulcast (v2), the Anope module (Plan 4). The client-side contract this plan fixes for Plan 3: publish tracks with IDs `mic`/`camera`/`screen`; be the polite peer; use the `tracks` message to label tiles; close the socket on `kicked`/`banned`.
- **Deferred from the spec, tracked for a follow-up (not blocking Plan 3):**
  - **ICE-TCP fallback** for UDP-hostile networks (spec's Network section). Adds a TCP listener via `SettingEngine.SetICETCPMux(webrtc.NewICETCPMux(...))` in Task 1's engine. Deferred because it needs a bound TCP port + config and is orthogonal to the forwarding path; add once UDP works end-to-end.
  - **Per-track bitrate caps** (camera ~800 kbps, screen ~1.5 Mbps) are a **client-side** concern (the browser's `RTCRtpSender.setParameters` encodings / `getUserMedia` constraints) — the SFU forwards whatever RTP it receives. These belong to the Plan 3 client, listed here so they aren't mistaken for a server gap.
