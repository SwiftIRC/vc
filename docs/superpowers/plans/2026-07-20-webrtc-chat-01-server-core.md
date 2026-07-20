# webrtc-chat Plan 1: Server Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The complete non-media core of webrtc-chat: config, HMAC tokens, room state + moderation, WebSocket signaling with reliability guarantees, and the HTTP API — a fully testable signaling/chat server.

**Architecture:** Single Go binary. Pure-state `room` package (no I/O) drives all room logic; a `signal` package defines the JSON wire protocol; the `server` package binds them to WebSockets with bounded send queues and panic isolation. Channel-room settings arrive via `/api/provision` pushes or token snapshots — zero persistence. The SFU media plane and browser client are Plan 2; the Anope module is Plan 3.

**Tech Stack:** Go 1.24+, `github.com/coder/websocket` (WS transport, incl. `wsjson` in tests), stdlib `log/slog`, `net/http`, `crypto/hmac`. No database.

**Spec:** `docs/superpowers/specs/2026-07-20-webrtc-chat-design.md` (read it first).

## Global Constraints

- Go module path: `github.com/ryanwohara/webrtc-chat`; `go 1.24`.
- webrtc-chat holds **no persistent state** — everything in memory; Anope is authoritative for channel bindings/settings.
- Token format (verbatim from spec): `base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload))`, hand-rolled, no JWT library. Compact single-letter payload keys. Tokenized links must stay ≲250 chars (single IRC NOTICE line).
- Chat history ring: **200 messages**, replayed to late joiners, dies with the room instance.
- Empty-room GC grace: **60 seconds** (default).
- Roles: `op` and participant are the only effective tiers; `voice` is a badge only; guests allowed unless room is identified-only. Ad-hoc rooms: **first joiner becomes op**.
- Mute/cut-video is a re-enableable **nudge**, never a gag. Bans are per-live-instance: by NickServ account (tokened) or IP (guests, best-effort).
- Clients auto-rejoin on any failure **except** after `kicked`/`banned`.
- Slow clients: bounded send queues; overflow disconnects that client, never stalls the room. All WS writes have deadlines; ping-timeout eviction.
- Panic in one connection/room must never kill the process.
- Config via flags > env (`WVC_*`) > defaults. Empty `-secret` disables channel-room features (provision + tokens rejected), ad-hoc keeps working.
- Every commit runs inside `/home/rohara/Workspace/webrtc-chat`; `go test ./...` must pass at every commit. Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## File Structure

```
webrtc-chat/
  go.mod
  cmd/webrtc-chat/main.go        — wiring: config, routes, GC ticker, graceful shutdown
  internal/config/config.go      — Config struct, Load(args, getenv)
  internal/token/token.go        — Claims, Sign, Verify, errors
  internal/token/testdata/vectors.json — shared test vectors (Plan 3 reuses these)
  internal/signal/messages.go    — wire structs, Decode (client set), Encode (server set)
  internal/room/room.go          — Room + Participant: join rules, chat, moderation (pure state)
  internal/room/registry.go      — Registry: resolve/create rooms, provision cache, GC sweep
  internal/server/server.go      — Hub: HTTP routes, /api/rooms, /api/provision
  internal/server/ws.go          — wsClient (bounded queue, pumps, panic recovery), join flow
```

Dependency direction: `server → room → signal`, `server → token`, `server → config`. `signal` and `token` import nothing internal.

### Task overview

1. Scaffold: go.mod, config package, main.go with /healthz + graceful shutdown
2. `token` package + shared test vectors
3. `signal` package: wire protocol
4. `room` package: Room state, join rules, chat ring
5. `room` package: moderation (kick/ban/mute/lock)
6. `room` Registry: resolve/provision/GC
7. `server`: wsClient transport (bounded queue, pumps, panic recovery)
8. `server`: WS join flow + roster + disconnect
9. `server`: chat, moderation commands over WS
10. HTTP API: /api/rooms/{room}, /api/provision
11. Lifecycle: GC ticker + shutdown broadcast, final wiring

---

### Task 1: Scaffold, config package, healthz

**Files:**
- Create: `go.mod`
- Create: `internal/config/config.go`
- Create: `internal/config/config_test.go`
- Create: `cmd/webrtc-chat/main.go`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `config.Config{Addr, PublicIP string; UDPPortMin, UDPPortMax int; Secret string; AdhocRooms bool; TLSCert, TLSKey string}` and `config.Load(args []string, getenv func(string) string) (Config, error)`. Later tasks read `cfg.Secret` and `cfg.AdhocRooms`.

- [ ] **Step 1: Initialize the module**

```bash
cd /home/rohara/Workspace/webrtc-chat && go mod init github.com/ryanwohara/webrtc-chat
```

Expected `go.mod`:

```
module github.com/ryanwohara/webrtc-chat

go 1.24
```

- [ ] **Step 2: Write the failing config test**

`internal/config/config_test.go`:

```go
package config

import "testing"

func TestDefaults(t *testing.T) {
	cfg, err := Load(nil, func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Addr != ":8080" {
		t.Errorf("Addr = %q, want :8080", cfg.Addr)
	}
	if !cfg.AdhocRooms {
		t.Error("AdhocRooms should default to true")
	}
	if cfg.UDPPortMin != 50000 || cfg.UDPPortMax != 50199 {
		t.Errorf("UDP range = %d-%d, want 50000-50199", cfg.UDPPortMin, cfg.UDPPortMax)
	}
	if cfg.Secret != "" {
		t.Errorf("Secret should default empty, got %q", cfg.Secret)
	}
}

func TestFlagBeatsEnv(t *testing.T) {
	env := map[string]string{"WVC_ADDR": ":9999", "WVC_SECRET": "envsecret", "WVC_ADHOC": "false"}
	cfg, err := Load([]string{"-addr", ":7777"}, func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Addr != ":7777" {
		t.Errorf("flag should beat env, got %q", cfg.Addr)
	}
	if cfg.Secret != "envsecret" {
		t.Errorf("Secret = %q, want envsecret", cfg.Secret)
	}
	if cfg.AdhocRooms {
		t.Error("WVC_ADHOC=false should disable ad-hoc rooms")
	}
}

func TestInvertedUDPRangeRejected(t *testing.T) {
	if _, err := Load([]string{"-udp-min", "60000", "-udp-max", "50000"}, func(string) string { return "" }); err == nil {
		t.Fatal("want error for inverted UDP range")
	}
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `go test ./internal/config/`
Expected: FAIL — `undefined: Load`

- [ ] **Step 4: Implement config**

`internal/config/config.go`:

```go
// Package config holds process configuration for webrtc-chat.
package config

import (
	"flag"
	"fmt"
	"io"
	"strconv"
)

type Config struct {
	Addr       string // HTTP listen address
	PublicIP   string // advertised ICE address (used by the media plane in Plan 2)
	UDPPortMin int    // media port range (Plan 2)
	UDPPortMax int
	Secret     string // shared HMAC secret; empty disables channel-room features
	AdhocRooms bool   // allow non-IRC rooms created by first join
	TLSCert    string // optional built-in TLS
	TLSKey     string
}

// Load parses configuration: flags (highest precedence), then env via
// getenv (WVC_*), then defaults. getenv is injected for testability.
func Load(args []string, getenv func(string) string) (Config, error) {
	str := func(key, fallback string) string {
		if v := getenv(key); v != "" {
			return v
		}
		return fallback
	}
	boolean := func(key string, fallback bool) bool {
		if v := getenv(key); v != "" {
			b, err := strconv.ParseBool(v)
			if err == nil {
				return b
			}
		}
		return fallback
	}
	integer := func(key string, fallback int) int {
		if v := getenv(key); v != "" {
			n, err := strconv.Atoi(v)
			if err == nil {
				return n
			}
		}
		return fallback
	}

	fs := flag.NewFlagSet("webrtc-chat", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	var cfg Config
	fs.StringVar(&cfg.Addr, "addr", str("WVC_ADDR", ":8080"), "HTTP listen address")
	fs.StringVar(&cfg.PublicIP, "public-ip", str("WVC_PUBLIC_IP", ""), "advertised ICE address")
	fs.IntVar(&cfg.UDPPortMin, "udp-min", integer("WVC_UDP_MIN", 50000), "media UDP port range start")
	fs.IntVar(&cfg.UDPPortMax, "udp-max", integer("WVC_UDP_MAX", 50199), "media UDP port range end")
	fs.StringVar(&cfg.Secret, "secret", str("WVC_SECRET", ""), "shared HMAC secret for tokens and provisioning")
	fs.BoolVar(&cfg.AdhocRooms, "adhoc", boolean("WVC_ADHOC", true), "allow ad-hoc (non-IRC) rooms")
	fs.StringVar(&cfg.TLSCert, "tls-cert", str("WVC_TLS_CERT", ""), "TLS certificate file (optional)")
	fs.StringVar(&cfg.TLSKey, "tls-key", str("WVC_TLS_KEY", ""), "TLS key file (optional)")
	if err := fs.Parse(args); err != nil {
		return Config{}, err
	}
	if cfg.UDPPortMin > cfg.UDPPortMax {
		return Config{}, fmt.Errorf("udp-min %d > udp-max %d", cfg.UDPPortMin, cfg.UDPPortMax)
	}
	if (cfg.TLSCert == "") != (cfg.TLSKey == "") {
		return Config{}, fmt.Errorf("tls-cert and tls-key must be set together")
	}
	return cfg, nil
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `go test ./internal/config/`
Expected: `ok  	github.com/ryanwohara/webrtc-chat/internal/config`

- [ ] **Step 6: Write main.go with /healthz and graceful shutdown**

`cmd/webrtc-chat/main.go`:

```go
package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/ryanwohara/webrtc-chat/internal/config"
)

func main() {
	cfg, err := config.Load(os.Args[1:], os.Getenv)
	if err != nil {
		slog.Error("config", "err", err)
		os.Exit(2)
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "ok\n")
	})

	srv := &http.Server{Addr: cfg.Addr, Handler: mux}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		srv.Shutdown(sctx)
	}()

	log.Info("listening", "addr", cfg.Addr)
	if cfg.TLSCert != "" {
		err = srv.ListenAndServeTLS(cfg.TLSCert, cfg.TLSKey)
	} else {
		err = srv.ListenAndServe()
	}
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Error("serve", "err", err)
		os.Exit(1)
	}
}
```

- [ ] **Step 7: Verify it runs**

Run: `go run ./cmd/webrtc-chat & sleep 1 && curl -s localhost:8080/healthz && kill %1`
Expected output: `ok`

- [ ] **Step 8: Commit**

```bash
git add go.mod cmd/ internal/
git commit -m "feat(webrtc-chat): scaffold binary with config and healthz"
```

---

### Task 2: Token package with shared test vectors

**Files:**
- Create: `internal/token/token.go`
- Create: `internal/token/token_test.go`
- Create: `internal/token/testdata/vectors.json`

**Interfaces:**
- Consumes: nothing internal.
- Produces (used by Tasks 6, 8; vectors reused by Plan 3's Anope module):

```go
type Claims struct {
	Channel   string `json:"c"`
	Room      string `json:"r"`
	Account   string `json:"a"`
	Nick      string `json:"n"`
	Role      string `json:"o"` // "op" | "voice" | "user"
	Flags     int    `json:"f"` // bitmask; FlagIdentifiedOnly = 1
	IssuedAt  int64  `json:"i"` // unix seconds
	ExpiresAt int64  `json:"e"`
}
const FlagIdentifiedOnly = 1
func Sign(c Claims, secret []byte) (string, error)
func Verify(tok string, secret []byte, now time.Time) (Claims, error)
var ErrMalformed, ErrBadSignature, ErrExpired error
```

**Design notes for the implementer:**
- The signature is HMAC-SHA256 over the **base64url payload string bytes** (not the decoded JSON). Verify MUST HMAC the received payload segment as-is — never re-marshal the claims — so any JSON-producing implementation (the C++ module) interoperates byte-for-byte.
- base64url = `base64.RawURLEncoding` (no padding).
- Reject tokens longer than 1024 bytes before any parsing (defense against junk).
- `vectors.json` is the cross-implementation contract: Plan 3's C++ tests must produce/verify these exact strings.

- [ ] **Step 1: Write the failing tests**

`internal/token/token_test.go`:

```go
package token

import (
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

var secret = []byte("test-secret-0123456789abcdef")

func claims() Claims {
	return Claims{
		Channel: "#swift", Room: "swift", Account: "Ryan", Nick: "Ryan",
		Role: "op", Flags: FlagIdentifiedOnly,
		IssuedAt: 1753000000, ExpiresAt: 1753000600,
	}
}

func TestSignVerifyRoundTrip(t *testing.T) {
	tok, err := Sign(claims(), secret)
	if err != nil {
		t.Fatal(err)
	}
	got, err := Verify(tok, secret, time.Unix(1753000100, 0))
	if err != nil {
		t.Fatal(err)
	}
	if got != claims() {
		t.Errorf("round trip mismatch: %+v", got)
	}
}

func TestExpired(t *testing.T) {
	tok, _ := Sign(claims(), secret)
	if _, err := Verify(tok, secret, time.Unix(1753000601, 0)); !errors.Is(err, ErrExpired) {
		t.Fatalf("want ErrExpired, got %v", err)
	}
}

func TestBadSignature(t *testing.T) {
	tok, _ := Sign(claims(), secret)
	if _, err := Verify(tok, []byte("wrong-secret"), time.Unix(1753000100, 0)); !errors.Is(err, ErrBadSignature) {
		t.Fatalf("want ErrBadSignature, got %v", err)
	}
	// Tampered payload must also fail: flip one payload char.
	parts := strings.SplitN(tok, ".", 2)
	tampered := parts[0][:len(parts[0])-1] + "A" + "." + parts[1]
	if _, err := Verify(tampered, secret, time.Unix(1753000100, 0)); err == nil {
		t.Fatal("tampered token verified")
	}
}

func TestMalformed(t *testing.T) {
	for _, tok := range []string{"", "no-dot", "a.b.c", strings.Repeat("x", 2000) + ".sig"} {
		if _, err := Verify(tok, secret, time.Unix(1753000100, 0)); !errors.Is(err, ErrMalformed) && !errors.Is(err, ErrBadSignature) {
			t.Errorf("Verify(%.20q) = %v, want malformed/bad-signature", tok, err)
		}
	}
}

// TestVectors pins the cross-implementation contract with the Anope module.
func TestVectors(t *testing.T) {
	raw, err := os.ReadFile("testdata/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vs []struct {
		Name   string `json:"name"`
		Secret string `json:"secret"`
		Token  string `json:"token"`
		Now    int64  `json:"now"`
		Want   string `json:"want"` // "ok" | "expired" | "bad-signature"
		Claims Claims `json:"claims"`
	}
	if err := json.Unmarshal(raw, &vs); err != nil {
		t.Fatal(err)
	}
	if len(vs) == 0 {
		t.Fatal("no vectors")
	}
	for _, v := range vs {
		got, err := Verify(v.Token, []byte(v.Secret), time.Unix(v.Now, 0))
		switch v.Want {
		case "ok":
			if err != nil {
				t.Errorf("%s: %v", v.Name, err)
			} else if got != v.Claims {
				t.Errorf("%s: claims %+v != %+v", v.Name, got, v.Claims)
			}
		case "expired":
			if !errors.Is(err, ErrExpired) {
				t.Errorf("%s: want ErrExpired, got %v", v.Name, err)
			}
		case "bad-signature":
			if !errors.Is(err, ErrBadSignature) {
				t.Errorf("%s: want ErrBadSignature, got %v", v.Name, err)
			}
		}
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/token/`
Expected: FAIL — `undefined: Claims`, `undefined: Sign`, etc.

- [ ] **Step 3: Implement the package**

`internal/token/token.go`:

```go
// Package token implements the HMAC-signed identity tokens issued by the
// Anope module and verified by webrtc-chat. Format:
// base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload-b64-bytes)).
// The signature covers the encoded payload string, so verifiers never
// re-marshal JSON and any issuer implementation interoperates.
package token

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

type Claims struct {
	Channel   string `json:"c"`
	Room      string `json:"r"`
	Account   string `json:"a"`
	Nick      string `json:"n"`
	Role      string `json:"o"`
	Flags     int    `json:"f"`
	IssuedAt  int64  `json:"i"`
	ExpiresAt int64  `json:"e"`
}

const FlagIdentifiedOnly = 1

const maxTokenLen = 1024

var (
	ErrMalformed    = errors.New("token: malformed")
	ErrBadSignature = errors.New("token: bad signature")
	ErrExpired      = errors.New("token: expired")
)

func Sign(c Claims, secret []byte) (string, error) {
	payload, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	p64 := base64.RawURLEncoding.EncodeToString(payload)
	return p64 + "." + sign64(p64, secret), nil
}

func Verify(tok string, secret []byte, now time.Time) (Claims, error) {
	if len(tok) == 0 || len(tok) > maxTokenLen {
		return Claims{}, ErrMalformed
	}
	p64, s64, ok := strings.Cut(tok, ".")
	if !ok || strings.Contains(s64, ".") {
		return Claims{}, ErrMalformed
	}
	if !hmac.Equal([]byte(sign64(p64, secret)), []byte(s64)) {
		return Claims{}, ErrBadSignature
	}
	payload, err := base64.RawURLEncoding.DecodeString(p64)
	if err != nil {
		return Claims{}, ErrMalformed
	}
	var c Claims
	if err := json.Unmarshal(payload, &c); err != nil {
		return Claims{}, ErrMalformed
	}
	if now.Unix() >= c.ExpiresAt {
		return Claims{}, ErrExpired
	}
	return c, nil
}

func sign64(p64 string, secret []byte) string {
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(p64))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
```

- [ ] **Step 4: Generate the vectors file**

Write a throwaway generator (do not commit it) and run it once:

```bash
cat > /tmp/claude-1000/-home-rohara-Workspace-webrtc-chat/e09e4614-545d-4af4-bf08-148b3ad218ee/scratchpad/genvec.go <<'EOF'
//go:build ignore
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/ryanwohara/webrtc-chat/internal/token"
)

func main() {
	secret := "test-secret-0123456789abcdef"
	base := token.Claims{Channel: "#swift", Room: "swift", Account: "Ryan",
		Nick: "Ryan", Role: "op", Flags: 1, IssuedAt: 1753000000, ExpiresAt: 1753000600}
	guest := token.Claims{Channel: "#help", Room: "help", Account: "alice",
		Nick: "alice|away", Role: "user", Flags: 0, IssuedAt: 1753000000, ExpiresAt: 1753000600}
	type vec struct {
		Name, Secret, Token string
		Now                 int64
		Want                string
		Claims              *token.Claims `json:",omitempty"`
	}
	sign := func(c token.Claims, s string) string { t, _ := token.Sign(c, []byte(s)); return t }
	vs := []vec{
		{"valid-op", secret, sign(base, secret), 1753000100, "ok", &base},
		{"valid-user", secret, sign(guest, secret), 1753000100, "ok", &guest},
		{"expired", secret, sign(base, secret), 1753000600, "expired", nil},
		{"bad-signature", secret, sign(base, "other-secret"), 1753000100, "bad-signature", nil},
	}
	out, _ := json.MarshalIndent(vs, "", "  ")
	os.WriteFile("internal/token/testdata/vectors.json", out, 0644)
	fmt.Println(string(out))
}
EOF
mkdir -p internal/token/testdata
go run /tmp/claude-1000/-home-rohara-Workspace-webrtc-chat/e09e4614-545d-4af4-bf08-148b3ad218ee/scratchpad/genvec.go
```

Then hand-edit `vectors.json` field names to lowercase to match the test's
struct tags (`name`, `secret`, `token`, `now`, `want`, `claims`) — or add
matching JSON tags to the generator's `vec` struct before running. The
committed file must use the lowercase keys.

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test ./internal/token/ -v`
Expected: all 5 tests PASS, including `TestVectors` over 4 vectors.

- [ ] **Step 6: Sanity-check the length budget**

Run: `go test ./internal/token/ -run TestSignVerifyRoundTrip -v` then add and run this quick check as a test:

```go
func TestLengthBudget(t *testing.T) {
	c := claims()
	c.Account = strings.Repeat("N", 30) // worst-case IRC-ish lengths
	c.Nick = strings.Repeat("N", 30)
	c.Channel = "#" + strings.Repeat("c", 32)
	c.Room = strings.Repeat("r", 32)
	tok, _ := Sign(c, secret)
	if len(tok) > 320 {
		t.Errorf("worst-case token %d chars, budget 320", len(tok))
	}
}
```

Expected: PASS. Worst-case (all fields maxed) is ~310 chars — well inside
the single-NOTICE-line budget (~440); typical tokens land ~180–250 chars.

- [ ] **Step 7: Commit**

```bash
git add internal/token/
git commit -m "feat(webrtc-chat): HMAC identity tokens with cross-impl test vectors"
```

---

### Task 3: Signal package — wire protocol

**Files:**
- Create: `internal/signal/messages.go`
- Create: `internal/signal/messages_test.go`

**Interfaces:**
- Consumes: nothing internal.
- Produces (used by every later task): the message structs below, plus
  `Decode(data []byte) (any, error)` (client→server set; returns a pointer,
  e.g. `*Join`) and `Encode(v any) ([]byte, error)` (server→client set plus
  `Offer`/`Answer`/`Candidate`, which flow both directions).

- [ ] **Step 1: Write the failing tests**

`internal/signal/messages_test.go`:

```go
package signal

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestDecodeClientMessages(t *testing.T) {
	cases := []struct {
		in   string
		want any
	}{
		{`{"type":"join","name":"alice","password":"pw","token":"abc.def"}`, &Join{Name: "alice", Password: "pw", Token: "abc.def"}},
		{`{"type":"offer","sdp":"v=0"}`, &Offer{SDP: "v=0"}},
		{`{"type":"answer","sdp":"v=0"}`, &Answer{SDP: "v=0"}},
		{`{"type":"chat","text":"hi"}`, &Chat{Text: "hi"}},
		{`{"type":"set-lock","password":"s3cret"}`, &SetLock{Password: "s3cret"}},
		{`{"type":"set-lock"}`, &SetLock{}},
		{`{"type":"kick","id":"p1"}`, &Kick{ID: "p1"}},
		{`{"type":"mute-peer","id":"p1","kind":"mic"}`, &MutePeer{ID: "p1", Kind: "mic"}},
		{`{"type":"ban","id":"p1"}`, &Ban{ID: "p1"}},
		{`{"type":"leave"}`, &Leave{}},
	}
	for _, c := range cases {
		got, err := Decode([]byte(c.in))
		if err != nil {
			t.Errorf("Decode(%s): %v", c.in, err)
			continue
		}
		gotJSON, _ := json.Marshal(got)
		wantJSON, _ := json.Marshal(c.want)
		if string(gotJSON) != string(wantJSON) {
			t.Errorf("Decode(%s) = %s, want %s", c.in, gotJSON, wantJSON)
		}
	}
}

func TestDecodeCandidatePreservesRawJSON(t *testing.T) {
	in := `{"type":"candidate","candidate":{"candidate":"candidate:1 1 udp 2 1.2.3.4 5 typ host","sdpMid":"0"}}`
	got, err := Decode([]byte(in))
	if err != nil {
		t.Fatal(err)
	}
	c, ok := got.(*Candidate)
	if !ok {
		t.Fatalf("got %T", got)
	}
	if !strings.Contains(string(c.Candidate), "sdpMid") {
		t.Errorf("raw candidate lost: %s", c.Candidate)
	}
}

func TestDecodeRejectsUnknownAndMalformed(t *testing.T) {
	for _, in := range []string{`{"type":"nope"}`, `{}`, `not json`, `{"type":"joined"}`} {
		if _, err := Decode([]byte(in)); err == nil {
			t.Errorf("Decode(%s) should fail", in)
		}
	}
}

func TestEncodeServerMessages(t *testing.T) {
	cases := []struct {
		in       any
		wantType string
		contains []string
	}{
		{Joined{SelfID: "p1", Role: "op", Peers: []PeerInfo{{ID: "p2", Name: "bob", Role: "user"}}}, "joined", []string{`"selfId":"p1"`, `"role":"op"`, `"peers"`}},
		{PeerJoined{ID: "p2", Name: "bob", Role: "voice"}, "peer-joined", []string{`"id":"p2"`}},
		{PeerLeft{ID: "p2"}, "peer-left", nil},
		{Offer{SDP: "v=0"}, "offer", []string{`"sdp":"v=0"`}},
		{Tracks{Tracks: []TrackInfo{{Mid: "0", ParticipantID: "p2", Kind: "camera"}}}, "tracks", []string{`"participantId":"p2"`}},
		{ChatEvent{From: "alice", Text: "hi", TS: 1753000000}, "chat", []string{`"ts":1753000000`}},
		{Moderation{Actor: "alice", Action: "kick", Target: "bob"}, "moderation", nil},
		{Kicked{By: "alice"}, "kicked", nil},
		{Banned{By: "alice"}, "banned", nil},
		{Muted{Kind: "mic"}, "muted", nil},
		{RoomLocked{}, "room-locked", nil},
		{RoomUnlocked{}, "room-unlocked", nil},
		{ServerRestarting{}, "server-restarting", nil},
		{Error{Code: "bad-password", Message: "wrong password"}, "error", []string{`"code":"bad-password"`}},
	}
	for _, c := range cases {
		raw, err := Encode(c.in)
		if err != nil {
			t.Errorf("Encode(%T): %v", c.in, err)
			continue
		}
		var env struct {
			Type string `json:"type"`
		}
		json.Unmarshal(raw, &env)
		if env.Type != c.wantType {
			t.Errorf("Encode(%T) type = %q, want %q", c.in, env.Type, c.wantType)
		}
		for _, sub := range c.contains {
			if !strings.Contains(string(raw), sub) {
				t.Errorf("Encode(%T) = %s, missing %s", c.in, raw, sub)
			}
		}
	}
}

func TestEncodeRejectsClientOnlyTypes(t *testing.T) {
	if _, err := Encode(Join{Name: "x"}); err == nil {
		t.Error("Encode(Join) should fail — client-only type")
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/signal/`
Expected: FAIL — `undefined: Join`, etc.

- [ ] **Step 3: Implement the package**

`internal/signal/messages.go`:

```go
// Package signal defines the JSON wire protocol carried over each
// participant's WebSocket. Every frame is an object with a "type" field
// and the message's fields inlined alongside it.
package signal

import (
	"encoding/json"
	"fmt"
)

// ---- client → server ----

type Join struct {
	Name     string `json:"name,omitempty"`     // guest display name
	Password string `json:"password,omitempty"` // for locked rooms
	Token    string `json:"token,omitempty"`    // identity token from !vc
}
type Offer struct {
	SDP string `json:"sdp"`
}
type Answer struct {
	SDP string `json:"sdp"`
}
// Candidate carries the browser's RTCIceCandidateInit verbatim.
type Candidate struct {
	Candidate json.RawMessage `json:"candidate"`
}
type Chat struct {
	Text string `json:"text"`
}
type SetLock struct {
	Password string `json:"password,omitempty"` // empty = unlock
}
type Kick struct {
	ID string `json:"id"`
}
type MutePeer struct {
	ID   string `json:"id"`
	Kind string `json:"kind"` // "mic" | "camera" | "screen"
}
type Ban struct {
	ID string `json:"id"`
}
type Leave struct{}

// ---- server → client ----

type PeerInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Role string `json:"role"` // "op" | "voice" | "user" | "guest"
}
type Joined struct {
	SelfID string     `json:"selfId"`
	Role   string     `json:"role"`
	Peers  []PeerInfo `json:"peers"`
}
type PeerJoined struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Role string `json:"role"`
}
type PeerLeft struct {
	ID string `json:"id"`
}
type TrackInfo struct {
	Mid           string `json:"mid"`
	ParticipantID string `json:"participantId"`
	Kind          string `json:"kind"` // "mic" | "camera" | "screen"
}
type Tracks struct {
	Tracks []TrackInfo `json:"tracks"`
}
type ChatEvent struct {
	From string `json:"from"`
	Text string `json:"text"`
	TS   int64  `json:"ts"` // unix seconds
}
// Moderation is the visible feed entry; Action ∈ kick|ban|mute|lock|unlock.
type Moderation struct {
	Actor  string `json:"actor"`
	Action string `json:"action"`
	Target string `json:"target,omitempty"`
	Kind   string `json:"kind,omitempty"` // for mute: which track
}
type Kicked struct {
	By string `json:"by"`
}
type Banned struct {
	By string `json:"by"`
}
type Muted struct {
	Kind string `json:"kind"`
}
type RoomLocked struct{}
type RoomUnlocked struct{}
type ServerRestarting struct{}
// Error codes: bad-password | banned | identified-only | not-provisioned |
// not-op | no-such-peer | token-invalid | token-expired | protocol
type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Decode parses a client→server frame, returning a pointer to the struct.
func Decode(data []byte) (any, error) {
	var env struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(data, &env); err != nil {
		return nil, fmt.Errorf("signal: %w", err)
	}
	var v any
	switch env.Type {
	case "join":
		v = &Join{}
	case "offer":
		v = &Offer{}
	case "answer":
		v = &Answer{}
	case "candidate":
		v = &Candidate{}
	case "chat":
		v = &Chat{}
	case "set-lock":
		v = &SetLock{}
	case "kick":
		v = &Kick{}
	case "mute-peer":
		v = &MutePeer{}
	case "ban":
		v = &Ban{}
	case "leave":
		v = &Leave{}
	default:
		return nil, fmt.Errorf("signal: unknown client type %q", env.Type)
	}
	if err := json.Unmarshal(data, v); err != nil {
		return nil, fmt.Errorf("signal: %w", err)
	}
	return v, nil
}

// Encode marshals a server→client message, injecting its "type" field.
func Encode(v any) ([]byte, error) {
	name, err := serverTypeName(v)
	if err != nil {
		return nil, err
	}
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, err
	}
	m["type"] = name
	return json.Marshal(m)
}

func serverTypeName(v any) (string, error) {
	switch v.(type) {
	case Joined, *Joined:
		return "joined", nil
	case PeerJoined, *PeerJoined:
		return "peer-joined", nil
	case PeerLeft, *PeerLeft:
		return "peer-left", nil
	case Offer, *Offer:
		return "offer", nil
	case Answer, *Answer:
		return "answer", nil
	case Candidate, *Candidate:
		return "candidate", nil
	case Tracks, *Tracks:
		return "tracks", nil
	case ChatEvent, *ChatEvent:
		return "chat", nil
	case Moderation, *Moderation:
		return "moderation", nil
	case Kicked, *Kicked:
		return "kicked", nil
	case Banned, *Banned:
		return "banned", nil
	case Muted, *Muted:
		return "muted", nil
	case RoomLocked, *RoomLocked:
		return "room-locked", nil
	case RoomUnlocked, *RoomUnlocked:
		return "room-unlocked", nil
	case ServerRestarting, *ServerRestarting:
		return "server-restarting", nil
	case Error, *Error:
		return "error", nil
	}
	return "", fmt.Errorf("signal: %T is not a server→client message", v)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/signal/ -v`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/signal/
git commit -m "feat(webrtc-chat): JSON wire protocol with typed encode/decode"
```

---

### Task 4: Room package — state, join rules, chat

**Files:**
- Create: `internal/room/room.go`
- Create: `internal/room/room_test.go`

**Interfaces:**
- Consumes: `signal` message structs.
- Produces (used by Tasks 5–11):

```go
type Role string // RoleOp "op", RoleVoice "voice", RoleUser "user", RoleGuest "guest"
type Conn interface {
	Send(v any) bool // non-blocking enqueue; false = overflow
	Close()
}
type Participant struct{ ID, Name, Account, IP string; Role Role; Conn Conn }
type Config struct {
	Slug, Channel  string           // Channel "" for ad-hoc rooms
	IdentifiedOnly bool
	Adhoc          bool             // first joiner becomes op
	Now            func() time.Time // injected clock (nil → time.Now)
}
func New(cfg Config) *Room
func (r *Room) Join(p *Participant, password string) error
func (r *Room) Leave(id string)
func (r *Room) Chat(fromID, text string)
func (r *Room) Broadcast(v any, exceptID string)
func (r *Room) Count() int
func (r *Room) Locked() bool
func (r *Room) Slug() string
func (r *Room) EmptySince() (time.Time, bool) // zero,false while occupied
func (r *Room) SetIdentifiedOnly(v bool)
func (r *Room) Shutdown() // ServerRestarting to all, then Close all
var ErrBadPassword, ErrBanned, ErrIdentifiedOnly, ErrNotOp, ErrNoSuchPeer error
const ChatHistory = 200
```

**Design notes:** the Room owns ALL fan-out — `Join` itself sends `Joined` +
chat replay to the joiner and broadcasts `PeerJoined`; callers never
hand-assemble rosters. Everything is guarded by one mutex; methods never call
out while holding it except `Conn.Send`, which must be non-blocking by
contract. A `Send` returning false means the peer's queue overflowed — the
room `Close()`s that conn (the transport layer will then call `Leave`).

- [ ] **Step 1: Write the failing tests**

`internal/room/room_test.go`:

```go
package room

import (
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/ryanwohara/webrtc-chat/internal/signal"
)

type fakeConn struct {
	mu     sync.Mutex
	msgs   []any
	closed bool
	full   bool
}

func (f *fakeConn) Send(v any) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.full {
		return false
	}
	f.msgs = append(f.msgs, v)
	return true
}
func (f *fakeConn) Close() { f.mu.Lock(); f.closed = true; f.mu.Unlock() }
func (f *fakeConn) typed(t *testing.T) (kinds []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, m := range f.msgs {
		kinds = append(kinds, fmt.Sprintf("%T", m))
	}
	return
}

func member(id, name string, role Role) (*Participant, *fakeConn) {
	c := &fakeConn{}
	return &Participant{ID: id, Name: name, Role: role, Conn: c}, c
}

func TestJoinSendsRosterAndBroadcasts(t *testing.T) {
	r := New(Config{Slug: "swift", Adhoc: true})
	alice, ac := member("p1", "alice", RoleUser)
	if err := r.Join(alice, ""); err != nil {
		t.Fatal(err)
	}
	if alice.Role != RoleOp {
		t.Errorf("first ad-hoc joiner role = %q, want op", alice.Role)
	}
	bob, bc := member("p2", "bob", RoleUser)
	if err := r.Join(bob, ""); err != nil {
		t.Fatal(err)
	}
	if bob.Role != RoleUser {
		t.Errorf("second joiner role = %q, want user", bob.Role)
	}
	// bob got a Joined with alice in the roster
	joined, ok := bc.msgs[0].(signal.Joined)
	if !ok {
		t.Fatalf("bob msg[0] = %T, want signal.Joined", bc.msgs[0])
	}
	if joined.SelfID != "p2" || len(joined.Peers) != 1 || joined.Peers[0].ID != "p1" || joined.Peers[0].Role != "op" {
		t.Errorf("bad Joined: %+v", joined)
	}
	// alice was told bob arrived
	last := ac.msgs[len(ac.msgs)-1]
	pj, ok := last.(signal.PeerJoined)
	if !ok || pj.ID != "p2" || pj.Name != "bob" {
		t.Errorf("alice last msg = %#v, want PeerJoined p2", last)
	}
	if r.Count() != 2 {
		t.Errorf("Count = %d", r.Count())
	}
}

func TestChannelRoomDoesNotPromoteFirstJoiner(t *testing.T) {
	r := New(Config{Slug: "swift", Channel: "#swift"})
	alice, _ := member("p1", "alice", RoleUser)
	r.Join(alice, "")
	if alice.Role != RoleUser {
		t.Errorf("channel-room joiner promoted to %q", alice.Role)
	}
}

func TestLockedRoomPassword(t *testing.T) {
	r := New(Config{Slug: "s", Adhoc: true})
	op, _ := member("p1", "op", RoleUser)
	r.Join(op, "")
	if err := r.SetLock("p1", "sesame"); err != nil {
		t.Fatal(err)
	}
	joiner, _ := member("p2", "eve", RoleUser)
	if err := r.Join(joiner, "wrong"); err != ErrBadPassword {
		t.Errorf("wrong password: %v", err)
	}
	if err := r.Join(joiner, "sesame"); err != nil {
		t.Errorf("right password: %v", err)
	}
}

func TestIdentifiedOnlyRejectsGuests(t *testing.T) {
	r := New(Config{Slug: "s", Channel: "#s", IdentifiedOnly: true})
	guest, _ := member("p1", "rando", RoleGuest)
	if err := r.Join(guest, ""); err != ErrIdentifiedOnly {
		t.Errorf("guest join: %v", err)
	}
	ident, _ := member("p2", "alice", RoleUser)
	ident.Account = "alice"
	if err := r.Join(ident, ""); err != nil {
		t.Errorf("identified join: %v", err)
	}
}

func TestChatReplayRingCap(t *testing.T) {
	r := New(Config{Slug: "s", Adhoc: true})
	alice, _ := member("p1", "alice", RoleUser)
	r.Join(alice, "")
	for i := 0; i < ChatHistory+5; i++ {
		r.Chat("p1", fmt.Sprintf("msg-%d", i))
	}
	late, lc := member("p9", "late", RoleUser)
	r.Join(late, "")
	var replayed []signal.ChatEvent
	for _, m := range lc.msgs {
		if ce, ok := m.(signal.ChatEvent); ok {
			replayed = append(replayed, ce)
		}
	}
	if len(replayed) != ChatHistory {
		t.Fatalf("replayed %d, want %d", len(replayed), ChatHistory)
	}
	if replayed[0].Text != "msg-5" || replayed[len(replayed)-1].Text != fmt.Sprintf("msg-%d", ChatHistory+4) {
		t.Errorf("ring window wrong: first=%q last=%q", replayed[0].Text, replayed[len(replayed)-1].Text)
	}
}

func TestOverflowingConnGetsClosed(t *testing.T) {
	r := New(Config{Slug: "s", Adhoc: true})
	alice, _ := member("p1", "alice", RoleUser)
	r.Join(alice, "")
	slow, sc := member("p2", "slow", RoleUser)
	r.Join(slow, "")
	sc.mu.Lock()
	sc.full = true
	sc.mu.Unlock()
	r.Chat("p1", "hello")
	sc.mu.Lock()
	closed := sc.closed
	sc.mu.Unlock()
	if !closed {
		t.Error("overflowing conn was not closed")
	}
}

func TestLeaveAndEmptySince(t *testing.T) {
	now := time.Unix(1000, 0)
	r := New(Config{Slug: "s", Adhoc: true, Now: func() time.Time { return now }})
	alice, _ := member("p1", "alice", RoleUser)
	bob, bc := member("p2", "bob", RoleUser)
	r.Join(alice, "")
	r.Join(bob, "")
	r.Leave("p1")
	pl, ok := bc.msgs[len(bc.msgs)-1].(signal.PeerLeft)
	if !ok || pl.ID != "p1" {
		t.Errorf("bob last msg = %#v, want PeerLeft p1", bc.msgs[len(bc.msgs)-1])
	}
	if _, empty := r.EmptySince(); empty {
		t.Error("room reported empty while bob present")
	}
	r.Leave("p2")
	since, empty := r.EmptySince()
	if !empty || !since.Equal(now) {
		t.Errorf("EmptySince = %v,%v", since, empty)
	}
}

func TestShutdownNotifiesAndCloses(t *testing.T) {
	r := New(Config{Slug: "s", Adhoc: true})
	alice, ac := member("p1", "alice", RoleUser)
	r.Join(alice, "")
	r.Shutdown()
	found := false
	ac.mu.Lock()
	for _, m := range ac.msgs {
		if _, ok := m.(signal.ServerRestarting); ok {
			found = true
		}
	}
	closed := ac.closed
	ac.mu.Unlock()
	if !found || !closed {
		t.Errorf("shutdown: restarting=%v closed=%v", found, closed)
	}
}
```

Note: `SetLock` is implemented in Task 5 but referenced here — declare a
minimal working `SetLock` in this task (op check + set password + broadcasts
come in Task 5; here it may simply set the password and lock flag for the
test to pass, Task 5 replaces it with the full role-checked version). To keep
this task self-contained, implement the simple version now:
`func (r *Room) SetLock(actorID, password string) error` that sets/clears the
password with no role check yet.

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/room/`
Expected: FAIL — `undefined: New`, etc.

- [ ] **Step 3: Implement the package**

`internal/room/room.go`:

```go
// Package room holds all per-room state and fan-out logic. It performs no
// I/O of its own: participants' connections are reached only through the
// Conn interface, whose Send must be non-blocking.
package room

import (
	"crypto/subtle"
	"errors"
	"sync"
	"time"

	"github.com/ryanwohara/webrtc-chat/internal/signal"
)

type Role string

const (
	RoleOp    Role = "op"
	RoleVoice Role = "voice"
	RoleUser  Role = "user"
	RoleGuest Role = "guest"
)

type Conn interface {
	Send(v any) bool
	Close()
}

type Participant struct {
	ID      string
	Name    string
	Account string // NickServ account; "" for guests
	IP      string
	Role    Role
	Conn    Conn
}

type Config struct {
	Slug           string
	Channel        string
	IdentifiedOnly bool
	Adhoc          bool
	Now            func() time.Time
}

const ChatHistory = 200

var (
	ErrBadPassword    = errors.New("room: bad password")
	ErrBanned         = errors.New("room: banned")
	ErrIdentifiedOnly = errors.New("room: identified only")
	ErrNotOp          = errors.New("room: not op")
	ErrNoSuchPeer     = errors.New("room: no such peer")
)

type Room struct {
	mu             sync.Mutex
	cfg            Config
	locked         bool
	password       string
	parts          map[string]*Participant
	chat           []signal.ChatEvent
	bannedAccounts map[string]struct{}
	bannedIPs      map[string]struct{}
	emptySince     time.Time
	hasBeenJoined  bool
}

func New(cfg Config) *Room {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	return &Room{
		cfg:            cfg,
		parts:          map[string]*Participant{},
		bannedAccounts: map[string]struct{}{},
		bannedIPs:      map[string]struct{}{},
	}
}

func (r *Room) Slug() string { r.mu.Lock(); defer r.mu.Unlock(); return r.cfg.Slug }

func (r *Room) Join(p *Participant, password string) error {
	r.mu.Lock()
	if r.locked && subtle.ConstantTimeCompare([]byte(password), []byte(r.password)) != 1 {
		r.mu.Unlock()
		return ErrBadPassword
	}
	if r.cfg.IdentifiedOnly && p.Account == "" {
		r.mu.Unlock()
		return ErrIdentifiedOnly
	}
	if _, banned := r.bannedAccounts[p.Account]; banned && p.Account != "" {
		r.mu.Unlock()
		return ErrBanned
	}
	if _, banned := r.bannedIPs[p.IP]; banned && p.Account == "" {
		r.mu.Unlock()
		return ErrBanned
	}
	if r.cfg.Adhoc && !r.hasBeenJoined {
		p.Role = RoleOp
	}
	r.hasBeenJoined = true
	roster := make([]signal.PeerInfo, 0, len(r.parts))
	for _, q := range r.parts {
		roster = append(roster, signal.PeerInfo{ID: q.ID, Name: q.Name, Role: string(q.Role)})
	}
	replay := append([]signal.ChatEvent(nil), r.chat...)
	r.parts[p.ID] = p
	r.emptySince = time.Time{}
	r.mu.Unlock()

	p.Conn.Send(signal.Joined{SelfID: p.ID, Role: string(p.Role), Peers: roster})
	for _, ce := range replay {
		p.Conn.Send(ce)
	}
	r.Broadcast(signal.PeerJoined{ID: p.ID, Name: p.Name, Role: string(p.Role)}, p.ID)
	return nil
}

func (r *Room) Leave(id string) {
	r.mu.Lock()
	p, ok := r.parts[id]
	if !ok {
		r.mu.Unlock()
		return
	}
	delete(r.parts, id)
	if len(r.parts) == 0 {
		r.emptySince = r.cfg.Now()
	}
	r.mu.Unlock()
	_ = p
	r.Broadcast(signal.PeerLeft{ID: id}, "")
}

func (r *Room) Chat(fromID, text string) {
	r.mu.Lock()
	from, ok := r.parts[fromID]
	if !ok {
		r.mu.Unlock()
		return
	}
	ev := signal.ChatEvent{From: from.Name, Text: text, TS: r.cfg.Now().Unix()}
	r.chat = append(r.chat, ev)
	if len(r.chat) > ChatHistory {
		r.chat = r.chat[len(r.chat)-ChatHistory:]
	}
	r.mu.Unlock()
	r.Broadcast(ev, "")
}

// Broadcast sends v to every participant except exceptID ("" = everyone).
// Connections that report overflow are closed; their Leave arrives when the
// transport notices the close.
func (r *Room) Broadcast(v any, exceptID string) {
	r.mu.Lock()
	targets := make([]*Participant, 0, len(r.parts))
	for _, p := range r.parts {
		if p.ID != exceptID {
			targets = append(targets, p)
		}
	}
	r.mu.Unlock()
	for _, p := range targets {
		if !p.Conn.Send(v) {
			p.Conn.Close()
		}
	}
}

// SetLock: Task 4 ships this minimal version (no role check); Task 5
// replaces it with the op-gated, broadcasting version.
func (r *Room) SetLock(actorID, password string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.password = password
	r.locked = password != ""
	return nil
}

func (r *Room) Count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.parts)
}

func (r *Room) Locked() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.locked
}

func (r *Room) EmptySince() (time.Time, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.parts) > 0 || r.emptySince.IsZero() {
		return time.Time{}, false
	}
	return r.emptySince, true
}

func (r *Room) SetIdentifiedOnly(v bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.cfg.IdentifiedOnly = v
}

func (r *Room) Shutdown() {
	r.Broadcast(signal.ServerRestarting{}, "")
	r.mu.Lock()
	targets := make([]*Participant, 0, len(r.parts))
	for _, p := range r.parts {
		targets = append(targets, p)
	}
	r.mu.Unlock()
	for _, p := range targets {
		p.Conn.Close()
	}
}
```

Note the subtle rule in `Join`: an unlocked room ignores the password
argument entirely (`r.locked` guards the compare), and ban checks are
account-based for identified users, IP-based only for guests — matching the
spec's "account (solid) / IP (best-effort)" split.

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/room/ -v`
Expected: all tests PASS. Also run `go test -race ./internal/room/` — PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/room/
git commit -m "feat(webrtc-chat): room state with join rules, chat ring, overflow policy"
```

---

### Task 5: Room moderation — kick, ban, mute, lock

**Files:**
- Modify: `internal/room/room.go` (replace Task 4's minimal `SetLock`; add moderation methods)
- Create: `internal/room/moderation_test.go`

**Interfaces:**
- Consumes: Task 4's Room internals.
- Produces (used by Task 9):

```go
func (r *Room) Kick(actorID, targetID string) error
func (r *Room) Ban(actorID, targetID string) error
func (r *Room) MutePeer(actorID, targetID, kind string) error // kind: mic|camera|screen
func (r *Room) SetLock(actorID, password string) error        // now op-gated; "" unlocks
```

All return `ErrNotOp` for non-op actors, `ErrNoSuchPeer` for unknown targets.
Every action broadcasts a `signal.Moderation` feed entry.

- [ ] **Step 1: Write the failing tests**

`internal/room/moderation_test.go`:

```go
package room

import (
	"errors"
	"testing"

	"github.com/ryanwohara/webrtc-chat/internal/signal"
)

// setup: adhoc room, alice joins first (auto-op), bob second (user).
func modRoom(t *testing.T) (*Room, *Participant, *fakeConn, *Participant, *fakeConn) {
	t.Helper()
	r := New(Config{Slug: "s", Adhoc: true})
	alice, ac := member("p1", "alice", RoleUser)
	bob, bc := member("p2", "bob", RoleUser)
	if err := r.Join(alice, ""); err != nil {
		t.Fatal(err)
	}
	if err := r.Join(bob, ""); err != nil {
		t.Fatal(err)
	}
	return r, alice, ac, bob, bc
}

func lastModeration(c *fakeConn) (signal.Moderation, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for i := len(c.msgs) - 1; i >= 0; i-- {
		if m, ok := c.msgs[i].(signal.Moderation); ok {
			return m, true
		}
	}
	return signal.Moderation{}, false
}

func TestNonOpCannotModerate(t *testing.T) {
	r, _, _, _, _ := modRoom(t)
	for _, err := range []error{
		r.Kick("p2", "p1"),
		r.Ban("p2", "p1"),
		r.MutePeer("p2", "p1", "mic"),
		r.SetLock("p2", "pw"),
	} {
		if !errors.Is(err, ErrNotOp) {
			t.Errorf("non-op action: %v, want ErrNotOp", err)
		}
	}
}

func TestKick(t *testing.T) {
	r, _, ac, _, bc := modRoom(t)
	if err := r.Kick("p1", "p2"); err != nil {
		t.Fatal(err)
	}
	bc.mu.Lock()
	var kicked bool
	for _, m := range bc.msgs {
		if k, ok := m.(signal.Kicked); ok && k.By == "alice" {
			kicked = true
		}
	}
	closed := bc.closed
	bc.mu.Unlock()
	if !kicked || !closed {
		t.Errorf("target: kicked=%v closed=%v", kicked, closed)
	}
	if r.Count() != 1 {
		t.Errorf("Count = %d after kick", r.Count())
	}
	if m, ok := lastModeration(ac); !ok || m.Action != "kick" || m.Target != "bob" {
		t.Errorf("feed entry = %+v ok=%v", m, ok)
	}
	// kicked ≠ banned: bob can rejoin
	bob2, _ := member("p3", "bob", RoleUser)
	if err := r.Join(bob2, ""); err != nil {
		t.Errorf("kicked user rejoin: %v", err)
	}
}

func TestBanByAccountAndIP(t *testing.T) {
	r, _, _, bob, _ := modRoom(t)
	bob.Account = "bobacct"
	if err := r.Ban("p1", "p2"); err != nil {
		t.Fatal(err)
	}
	again, _ := member("p3", "bob", RoleUser)
	again.Account = "bobacct"
	if err := r.Join(again, ""); !errors.Is(err, ErrBanned) {
		t.Errorf("banned account rejoin: %v", err)
	}
	// guest ban falls back to IP
	guest, _ := member("p4", "rando", RoleGuest)
	guest.IP = "10.0.0.9"
	r.Join(guest, "")
	if err := r.Ban("p1", "p4"); err != nil {
		t.Fatal(err)
	}
	guest2, _ := member("p5", "rando2", RoleGuest)
	guest2.IP = "10.0.0.9"
	if err := r.Join(guest2, ""); !errors.Is(err, ErrBanned) {
		t.Errorf("banned IP rejoin: %v", err)
	}
}

func TestMutePeerIsANudge(t *testing.T) {
	r, _, ac, _, bc := modRoom(t)
	if err := r.MutePeer("p1", "p2", "mic"); err != nil {
		t.Fatal(err)
	}
	if err := r.MutePeer("p1", "p2", "sausage"); err == nil {
		t.Error("invalid kind accepted")
	}
	bc.mu.Lock()
	var muted bool
	for _, m := range bc.msgs {
		if mm, ok := m.(signal.Muted); ok && mm.Kind == "mic" {
			muted = true
		}
	}
	stillOpen := !bc.closed
	bc.mu.Unlock()
	if !muted || !stillOpen {
		t.Errorf("nudge: muted=%v stillOpen=%v (mute must never disconnect)", muted, stillOpen)
	}
	if m, _ := lastModeration(ac); m.Action != "mute" || m.Kind != "mic" {
		t.Errorf("feed entry = %+v", m)
	}
}

func TestSetLockOpGatedAndBroadcasts(t *testing.T) {
	r, _, _, _, bc := modRoom(t)
	if err := r.SetLock("p1", "sesame"); err != nil {
		t.Fatal(err)
	}
	if !r.Locked() {
		t.Error("room not locked")
	}
	bc.mu.Lock()
	var lockedMsg bool
	for _, m := range bc.msgs {
		if _, ok := m.(signal.RoomLocked); ok {
			lockedMsg = true
		}
	}
	bc.mu.Unlock()
	if !lockedMsg {
		t.Error("RoomLocked not broadcast")
	}
	if err := r.SetLock("p1", ""); err != nil {
		t.Fatal(err)
	}
	if r.Locked() {
		t.Error("room still locked after unlock")
	}
}

func TestModerateUnknownTarget(t *testing.T) {
	r, _, _, _, _ := modRoom(t)
	if err := r.Kick("p1", "nope"); !errors.Is(err, ErrNoSuchPeer) {
		t.Errorf("Kick unknown: %v", err)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/room/`
Expected: FAIL — `undefined: (*Room).Kick` etc.; `TestNonOpCannotModerate` fails against Task 4's ungated `SetLock`.

- [ ] **Step 3: Implement moderation**

Append to `internal/room/room.go`, and REPLACE Task 4's `SetLock` entirely:

```go
// requireOp returns the actor if present and op. Callers hold no lock.
func (r *Room) requireOp(actorID string) (*Participant, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	actor, ok := r.parts[actorID]
	if !ok {
		return nil, ErrNoSuchPeer
	}
	if actor.Role != RoleOp {
		return nil, ErrNotOp
	}
	return actor, nil
}

func (r *Room) target(id string) (*Participant, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	p, ok := r.parts[id]
	if !ok {
		return nil, ErrNoSuchPeer
	}
	return p, nil
}

func (r *Room) Kick(actorID, targetID string) error {
	actor, err := r.requireOp(actorID)
	if err != nil {
		return err
	}
	tgt, err := r.target(targetID)
	if err != nil {
		return err
	}
	tgt.Conn.Send(signal.Kicked{By: actor.Name})
	tgt.Conn.Close()
	r.Leave(targetID) // broadcasts PeerLeft
	r.Broadcast(signal.Moderation{Actor: actor.Name, Action: "kick", Target: tgt.Name}, "")
	return nil
}

func (r *Room) Ban(actorID, targetID string) error {
	actor, err := r.requireOp(actorID)
	if err != nil {
		return err
	}
	tgt, err := r.target(targetID)
	if err != nil {
		return err
	}
	r.mu.Lock()
	if tgt.Account != "" {
		r.bannedAccounts[tgt.Account] = struct{}{}
	} else if tgt.IP != "" {
		r.bannedIPs[tgt.IP] = struct{}{}
	}
	r.mu.Unlock()
	tgt.Conn.Send(signal.Banned{By: actor.Name})
	tgt.Conn.Close()
	r.Leave(targetID)
	r.Broadcast(signal.Moderation{Actor: actor.Name, Action: "ban", Target: tgt.Name}, "")
	return nil
}

// MutePeer is a nudge: it tells the target to stop a track. The target may
// re-enable at will; nothing is torn down. (Plan 2 additionally pauses
// server-side forwarding of that track until the target re-enables.)
func (r *Room) MutePeer(actorID, targetID, kind string) error {
	if kind != "mic" && kind != "camera" && kind != "screen" {
		return errors.New("room: bad kind")
	}
	actor, err := r.requireOp(actorID)
	if err != nil {
		return err
	}
	tgt, err := r.target(targetID)
	if err != nil {
		return err
	}
	tgt.Conn.Send(signal.Muted{Kind: kind})
	r.Broadcast(signal.Moderation{Actor: actor.Name, Action: "mute", Target: tgt.Name, Kind: kind}, "")
	return nil
}

// SetLock sets (non-empty) or clears (empty) the room password. Op-only.
func (r *Room) SetLock(actorID, password string) error {
	actor, err := r.requireOp(actorID)
	if err != nil {
		return err
	}
	r.mu.Lock()
	r.password = password
	r.locked = password != ""
	locked := r.locked
	r.mu.Unlock()
	if locked {
		r.Broadcast(signal.RoomLocked{}, "")
		r.Broadcast(signal.Moderation{Actor: actor.Name, Action: "lock"}, "")
	} else {
		r.Broadcast(signal.RoomUnlocked{}, "")
		r.Broadcast(signal.Moderation{Actor: actor.Name, Action: "unlock"}, "")
	}
	return nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test -race ./internal/room/ -v`
Expected: all room tests PASS (Task 4's suite still green).

- [ ] **Step 5: Commit**

```bash
git add internal/room/
git commit -m "feat(webrtc-chat): op-gated moderation - kick, ban, mute nudge, lock"
```

---

### Task 6: Registry — resolve, provision, GC

**Files:**
- Create: `internal/room/registry.go`
- Create: `internal/room/registry_test.go`

**Interfaces:**
- Consumes: `room.Room`, `token.Claims`.
- Produces (used by Tasks 8, 10, 11):

```go
type Registry struct{ ... }
const GCGrace = 60 * time.Second
var ErrNotProvisioned error
func NewRegistry(adhocAllowed bool, now func() time.Time) *Registry
func (g *Registry) Provision(channel, slug string, identifiedOnly bool)
func (g *Registry) Resolve(slug string, claims *token.Claims) (*Room, error)
func (g *Registry) Peek(slug string) (count int, locked bool)
func (g *Registry) Sweep()          // GC rooms empty > GCGrace; meta survives
func (g *Registry) Rooms() []*Room  // snapshot, for shutdown broadcast
```

**Resolve rules (from the spec), in order:**
1. If `claims != nil && claims.Room == slug`, first apply the token's
   settings snapshot as a provision (tokens double as provisioning fallback).
2. A live room with that slug → return it.
3. Provisioned meta for the slug → create a channel room from it.
4. Otherwise, ad-hoc allowed → create an ad-hoc room; ad-hoc disabled →
   `ErrNotProvisioned`.

- [ ] **Step 1: Write the failing tests**

`internal/room/registry_test.go`:

```go
package room

import (
	"errors"
	"testing"
	"time"

	"github.com/ryanwohara/webrtc-chat/internal/token"
)

func TestResolveAdhoc(t *testing.T) {
	g := NewRegistry(true, time.Now)
	r, err := g.Resolve("random", nil)
	if err != nil {
		t.Fatal(err)
	}
	r2, _ := g.Resolve("random", nil)
	if r != r2 {
		t.Error("same slug resolved to different rooms")
	}
}

func TestResolveAdhocDisabled(t *testing.T) {
	g := NewRegistry(false, time.Now)
	if _, err := g.Resolve("random", nil); !errors.Is(err, ErrNotProvisioned) {
		t.Fatalf("want ErrNotProvisioned, got %v", err)
	}
}

func TestProvisionThenResolve(t *testing.T) {
	g := NewRegistry(false, time.Now)
	g.Provision("#swift", "swift", true)
	r, err := g.Resolve("swift", nil)
	if err != nil {
		t.Fatal(err)
	}
	// identified-only came through: a guest join must be rejected
	guest, _ := member("p1", "rando", RoleGuest)
	if err := r.Join(guest, ""); !errors.Is(err, ErrIdentifiedOnly) {
		t.Errorf("guest join on identified-only channel room: %v", err)
	}
	// channel rooms never promote first joiner
	ident, _ := member("p2", "alice", RoleUser)
	ident.Account = "alice"
	r.Join(ident, "")
	if ident.Role != RoleUser {
		t.Errorf("channel room promoted joiner to %q", ident.Role)
	}
}

func TestTokenProvisionsRoom(t *testing.T) {
	g := NewRegistry(false, time.Now)
	claims := &token.Claims{Channel: "#swift", Room: "swift", Account: "Ryan",
		Nick: "Ryan", Role: "op", Flags: token.FlagIdentifiedOnly}
	if _, err := g.Resolve("swift", claims); err != nil {
		t.Fatalf("token should provision: %v", err)
	}
	// mismatched slug in token must NOT provision other rooms
	if _, err := g.Resolve("other", claims); !errors.Is(err, ErrNotProvisioned) {
		t.Errorf("mismatched token slug provisioned a room: %v", err)
	}
}

func TestProvisionUpdatesLiveRoom(t *testing.T) {
	g := NewRegistry(false, time.Now)
	g.Provision("#swift", "swift", false)
	r, _ := g.Resolve("swift", nil)
	g.Provision("#swift", "swift", true) // ops flipped IDENTIFIED ON
	guest, _ := member("p1", "rando", RoleGuest)
	if err := r.Join(guest, ""); !errors.Is(err, ErrIdentifiedOnly) {
		t.Errorf("live room did not pick up IDENTIFIED ON: %v", err)
	}
}

func TestSweepGCAndMetaSurvives(t *testing.T) {
	now := time.Unix(1000, 0)
	clock := func() time.Time { return now }
	g := NewRegistry(true, clock)
	g.Provision("#swift", "swift", false)
	r, _ := g.Resolve("swift", nil)
	p, _ := member("p1", "alice", RoleUser)
	r.Join(p, "")
	r.Leave("p1")

	now = now.Add(30 * time.Second)
	g.Sweep()
	if r2, _ := g.Resolve("swift", nil); r2 != r {
		t.Fatal("room GC'd before grace expired")
	}

	now = now.Add(31 * time.Second)
	g.Sweep()
	r3, err := g.Resolve("swift", nil)
	if err != nil {
		t.Fatalf("meta must survive GC: %v", err)
	}
	if r3 == r {
		t.Error("room instance not GC'd after grace")
	}
	if count, _ := g.Peek("swift"); count != 0 {
		t.Errorf("Peek count = %d", count)
	}
}

func TestPeek(t *testing.T) {
	g := NewRegistry(true, time.Now)
	if count, locked := g.Peek("ghost"); count != 0 || locked {
		t.Errorf("Peek(ghost) = %d,%v", count, locked)
	}
	r, _ := g.Resolve("busy", nil)
	p, _ := member("p1", "alice", RoleUser)
	r.Join(p, "")
	r.SetLock("p1", "pw") // p1 is op (ad-hoc first joiner)
	if count, locked := g.Peek("busy"); count != 1 || !locked {
		t.Errorf("Peek(busy) = %d,%v", count, locked)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/room/`
Expected: FAIL — `undefined: NewRegistry`, etc.

- [ ] **Step 3: Implement the registry**

`internal/room/registry.go`:

```go
package room

import (
	"errors"
	"sync"
	"time"

	"github.com/ryanwohara/webrtc-chat/internal/token"
)

const GCGrace = 60 * time.Second

var ErrNotProvisioned = errors.New("registry: room not provisioned")

type meta struct {
	channel        string
	identifiedOnly bool
}

type Registry struct {
	mu           sync.Mutex
	adhocAllowed bool
	now          func() time.Time
	rooms        map[string]*Room
	metas        map[string]meta
}

func NewRegistry(adhocAllowed bool, now func() time.Time) *Registry {
	if now == nil {
		now = time.Now
	}
	return &Registry{
		adhocAllowed: adhocAllowed,
		now:          now,
		rooms:        map[string]*Room{},
		metas:        map[string]meta{},
	}
}

// Provision records (or refreshes) a channel→room binding pushed by the
// Anope module, and applies setting changes to a live room instance.
func (g *Registry) Provision(channel, slug string, identifiedOnly bool) {
	g.mu.Lock()
	g.metas[slug] = meta{channel: channel, identifiedOnly: identifiedOnly}
	r := g.rooms[slug]
	g.mu.Unlock()
	if r != nil {
		r.SetIdentifiedOnly(identifiedOnly)
	}
}

func (g *Registry) Resolve(slug string, claims *token.Claims) (*Room, error) {
	if claims != nil && claims.Room == slug {
		g.Provision(claims.Channel, slug, claims.Flags&token.FlagIdentifiedOnly != 0)
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if r, ok := g.rooms[slug]; ok {
		return r, nil
	}
	if m, ok := g.metas[slug]; ok {
		r := New(Config{Slug: slug, Channel: m.channel, IdentifiedOnly: m.identifiedOnly, Now: g.now})
		g.rooms[slug] = r
		return r, nil
	}
	if !g.adhocAllowed {
		return nil, ErrNotProvisioned
	}
	r := New(Config{Slug: slug, Adhoc: true, Now: g.now})
	g.rooms[slug] = r
	return r, nil
}

func (g *Registry) Peek(slug string) (count int, locked bool) {
	g.mu.Lock()
	r := g.rooms[slug]
	g.mu.Unlock()
	if r == nil {
		return 0, false
	}
	return r.Count(), r.Locked()
}

// Sweep deletes room instances empty for longer than GCGrace. Channel metas
// are never swept — the binding is permanent until process restart (and is
// refreshed by any !vc or tokened join anyway).
func (g *Registry) Sweep() {
	cutoff := g.now().Add(-GCGrace)
	g.mu.Lock()
	defer g.mu.Unlock()
	for slug, r := range g.rooms {
		if since, empty := r.EmptySince(); empty && since.Before(cutoff) {
			delete(g.rooms, slug)
		}
	}
}

func (g *Registry) Rooms() []*Room {
	g.mu.Lock()
	defer g.mu.Unlock()
	out := make([]*Room, 0, len(g.rooms))
	for _, r := range g.rooms {
		out = append(out, r)
	}
	return out
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test -race ./internal/room/ -v`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/room/
git commit -m "feat(webrtc-chat): room registry with provisioning and GC sweep"
```

---

### Task 7: WS transport — wsClient with bounded queue, pings, panic guard

**Files:**
- Create: `internal/server/ws.go`
- Create: `internal/server/ws_test.go`
- Modify: `go.mod` (adds `github.com/coder/websocket`)

**Interfaces:**
- Consumes: `signal.Encode`/`signal.Decode`; implements `room.Conn`.
- Produces (used by Tasks 8, 9):

```go
const sendQueueCap = 64
var pingInterval = 20 * time.Second   // vars so tests can shrink them
var writeTimeout = 5 * time.Second
func newWSClient(conn *websocket.Conn, log *slog.Logger) *wsClient
func (c *wsClient) Send(v any) bool           // room.Conn
func (c *wsClient) Close()                    // room.Conn; idempotent
func (c *wsClient) writePump()                // caller runs: go c.writePump()
func (c *wsClient) readNext(ctx context.Context) (any, error)
func (c *wsClient) done() <-chan struct{}     // closed once the client is closing
func recoverGuard(log *slog.Logger, where string) // deferred panic barrier
```

- [ ] **Step 1: Add the dependency**

```bash
go get github.com/coder/websocket@latest && go mod tidy
```

- [ ] **Step 2: Write the failing tests**

`internal/server/ws_test.go`:

```go
package server

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/ryanwohara/webrtc-chat/internal/signal"
)

var testLog = slog.New(slog.NewTextHandler(&strings.Builder{}, nil))

// wsPair spins up a server whose handler passes the accepted wsClient to fn,
// and returns a dialed client-side conn.
func wsPair(t *testing.T, fn func(c *wsClient)) *websocket.Conn {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		conn.SetReadLimit(16384)
		c := newWSClient(conn, testLog)
		go c.writePump()
		fn(c)
	}))
	t.Cleanup(srv.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	dial, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { dial.Close(websocket.StatusNormalClosure, "") })
	return dial
}

func TestSendDeliversTypedFrame(t *testing.T) {
	dial := wsPair(t, func(c *wsClient) {
		if !c.Send(signal.Joined{SelfID: "p1", Role: "op"}) {
			t.Error("Send returned false")
		}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, data, err := dial.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var env map[string]any
	json.Unmarshal(data, &env)
	if env["type"] != "joined" || env["selfId"] != "p1" {
		t.Errorf("frame = %s", data)
	}
}

func TestReadNextDecodes(t *testing.T) {
	got := make(chan any, 1)
	dial := wsPair(t, func(c *wsClient) {
		v, err := c.readNext(context.Background())
		if err != nil {
			t.Error(err)
			return
		}
		got <- v
	})
	ctx := context.Background()
	dial.Write(ctx, websocket.MessageText, []byte(`{"type":"chat","text":"hi"}`))
	select {
	case v := <-got:
		if chat, ok := v.(*signal.Chat); !ok || chat.Text != "hi" {
			t.Errorf("got %#v", v)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout")
	}
}

func TestOverflowReturnsFalse(t *testing.T) {
	// No writePump: the queue can only fill.
	c := &wsClient{send: make(chan []byte, 2), log: testLog}
	c.ctx, c.cancel = context.WithCancel(context.Background())
	if !c.Send(signal.PeerLeft{ID: "a"}) || !c.Send(signal.PeerLeft{ID: "b"}) {
		t.Fatal("queue should accept up to cap")
	}
	if c.Send(signal.PeerLeft{ID: "c"}) {
		t.Error("Send should report overflow when queue is full")
	}
}

func TestPingEvictsDeadPeer(t *testing.T) {
	oldPing, oldWrite := pingInterval, writeTimeout
	pingInterval, writeTimeout = 30*time.Millisecond, 100*time.Millisecond
	t.Cleanup(func() { pingInterval, writeTimeout = oldPing, oldWrite })

	closed := make(chan struct{})
	_ = wsPair(t, func(c *wsClient) {
		<-c.done()
		close(closed)
	})
	// Dial-side never reads → pongs never processed → ping times out.
	select {
	case <-closed:
	case <-time.After(3 * time.Second):
		t.Fatal("dead peer was not evicted")
	}
}

func TestCloseIsIdempotent(t *testing.T) {
	dial := wsPair(t, func(c *wsClient) {
		c.Close()
		c.Close() // must not panic
	})
	_ = dial
}

func TestRecoverGuard(t *testing.T) {
	func() {
		defer recoverGuard(testLog, "test")
		panic("boom")
	}() // must not crash the test binary
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `go test ./internal/server/`
Expected: FAIL — `undefined: newWSClient`, etc.

- [ ] **Step 4: Implement the transport**

`internal/server/ws.go`:

```go
// Package server binds rooms to HTTP/WebSocket transport.
package server

import (
	"context"
	"errors"
	"log/slog"
	"runtime/debug"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/ryanwohara/webrtc-chat/internal/signal"
)

const sendQueueCap = 64

var (
	pingInterval = 20 * time.Second
	writeTimeout = 5 * time.Second
)

// wsClient adapts a websocket.Conn to room.Conn: a bounded, non-blocking
// send queue drained by writePump, with ping-based dead-peer eviction.
type wsClient struct {
	conn   *websocket.Conn
	log    *slog.Logger
	send   chan []byte
	ctx    context.Context
	cancel context.CancelFunc
	once   sync.Once
}

func newWSClient(conn *websocket.Conn, log *slog.Logger) *wsClient {
	ctx, cancel := context.WithCancel(context.Background())
	return &wsClient{
		conn: conn, log: log,
		send: make(chan []byte, sendQueueCap),
		ctx:  ctx, cancel: cancel,
	}
}

// Send encodes and enqueues. false = queue overflow (slow consumer); the
// caller (Room) responds by closing this client. Encoding failures are
// programming errors: logged, reported as delivered so the peer isn't
// punished for our bug.
func (c *wsClient) Send(v any) bool {
	data, err := signal.Encode(v)
	if err != nil {
		c.log.Error("encode", "err", err)
		return true
	}
	select {
	case c.send <- data:
		return true
	case <-c.ctx.Done():
		return true // already closing; not an overflow
	default:
		return false
	}
}

func (c *wsClient) Close() {
	c.once.Do(func() {
		c.cancel()
		c.conn.Close(websocket.StatusNormalClosure, "bye")
	})
}

func (c *wsClient) done() <-chan struct{} { return c.ctx.Done() }

func (c *wsClient) writePump() {
	defer recoverGuard(c.log, "writePump")
	defer c.Close()
	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()
	for {
		select {
		case data := <-c.send:
			wctx, cancel := context.WithTimeout(c.ctx, writeTimeout)
			err := c.conn.Write(wctx, websocket.MessageText, data)
			cancel()
			if err != nil {
				return
			}
		case <-ticker.C:
			wctx, cancel := context.WithTimeout(c.ctx, writeTimeout)
			err := c.conn.Ping(wctx)
			cancel()
			if err != nil {
				return
			}
		case <-c.ctx.Done():
			return
		}
	}
}

// readNext blocks for one client frame and decodes it.
func (c *wsClient) readNext(ctx context.Context) (any, error) {
	typ, data, err := c.conn.Read(ctx)
	if err != nil {
		return nil, err
	}
	if typ != websocket.MessageText {
		return nil, errors.New("server: binary frame rejected")
	}
	return signal.Decode(data)
}

// recoverGuard is the per-goroutine panic barrier: one connection's bug
// must never take down the process.
func recoverGuard(log *slog.Logger, where string) {
	if v := recover(); v != nil {
		log.Error("panic recovered", "where", where, "panic", v, "stack", string(debug.Stack()))
	}
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test -race ./internal/server/ -v`
Expected: all 6 tests PASS. `TestPingEvictsDeadPeer` may take ~1s.

- [ ] **Step 6: Commit**

```bash
git add go.mod go.sum internal/server/
git commit -m "feat(webrtc-chat): ws transport with bounded queue, ping eviction, panic guard"
```

---

### Task 8: Hub — WS join flow, roster, disconnect

**Files:**
- Create: `internal/server/server.go`
- Create: `internal/server/server_test.go`

**Interfaces:**
- Consumes: `config.Config`, `room.Registry`, `token.Verify`, `wsClient` (Task 7).
- Produces (used by Tasks 9–11 and `main.go`):

```go
type Hub struct{ ... }
func NewHub(cfg config.Config, reg *room.Registry, log *slog.Logger, now func() time.Time) *Hub
func (h *Hub) Routes() http.Handler // GET /healthz, GET /ws/{room}; Task 10 adds the /api routes
var joinTimeout = 10 * time.Second
```

**Join flow rules (from the spec):**
1. First frame on the socket must be `join`, within `joinTimeout`.
2. A presented token must verify (HMAC, expiry) and its `Room` claim must equal the URL slug; failures → `error` with code `token-invalid` / `token-expired`. Tokens are rejected outright when no `-secret` is configured.
3. `Resolve` may refuse with `not-provisioned` (channel-rooms-only mode).
4. `room.Join` errors map to codes: `bad-password`, `banned`, `identified-only`.
5. Tokened participants get Name/Account/Role from claims (`op`/`voice`→ those roles, anything else →`user`); guests get a sanitized display name and `RoleGuest`.
6. On socket close or `leave`: `room.Leave(id)` runs (deferred), broadcasting `peer-left`.

- [ ] **Step 1: Write the failing tests**

`internal/server/server_test.go`:

```go
package server

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"github.com/ryanwohara/webrtc-chat/internal/config"
	"github.com/ryanwohara/webrtc-chat/internal/room"
	"github.com/ryanwohara/webrtc-chat/internal/token"
)

const testSecret = "test-secret-0123456789abcdef"

func newTestHub(t *testing.T, secret string, adhoc bool) (*Hub, *httptest.Server) {
	t.Helper()
	cfg := config.Config{Secret: secret, AdhocRooms: adhoc}
	reg := room.NewRegistry(adhoc, time.Now)
	h := NewHub(cfg, reg, testLog, time.Now)
	srv := httptest.NewServer(h.Routes())
	t.Cleanup(srv.Close)
	return h, srv
}

func dialRoom(t *testing.T, srv *httptest.Server, slug string) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/ws/"+slug, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close(websocket.StatusNormalClosure, "") })
	return conn
}

func send(t *testing.T, c *websocket.Conn, v map[string]any) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := wsjson.Write(ctx, c, v); err != nil {
		t.Fatal(err)
	}
}

// recv reads frames until one matches wantType (skipping others), failing
// after a short deadline.
func recv(t *testing.T, c *websocket.Conn, wantType string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		ctx, cancel := context.WithDeadline(context.Background(), deadline)
		var m map[string]any
		err := wsjson.Read(ctx, c, &m)
		cancel()
		if err != nil {
			t.Fatalf("waiting for %q: %v", wantType, err)
		}
		if m["type"] == wantType {
			return m
		}
	}
	t.Fatalf("no %q frame before deadline", wantType)
	return nil
}

func opToken(t *testing.T, slug string, flags int) string {
	t.Helper()
	tok, err := token.Sign(token.Claims{
		Channel: "#" + slug, Room: slug, Account: "Ryan", Nick: "Ryan", Role: "op",
		Flags: flags, IssuedAt: time.Now().Unix(), ExpiresAt: time.Now().Add(10 * time.Minute).Unix(),
	}, []byte(testSecret))
	if err != nil {
		t.Fatal(err)
	}
	return tok
}

func TestGuestJoinAndRoster(t *testing.T) {
	_, srv := newTestHub(t, "", true)
	a := dialRoom(t, srv, "lobby")
	send(t, a, map[string]any{"type": "join", "name": "alice"})
	ja := recv(t, a, "joined")
	if ja["role"] != "op" { // ad-hoc first joiner
		t.Errorf("first joiner role = %v", ja["role"])
	}
	b := dialRoom(t, srv, "lobby")
	send(t, b, map[string]any{"type": "join", "name": "bob"})
	jb := recv(t, b, "joined")
	if jb["role"] != "guest" {
		t.Errorf("guest role = %v", jb["role"])
	}
	peers := jb["peers"].([]any)
	if len(peers) != 1 || peers[0].(map[string]any)["name"] != "alice" {
		t.Errorf("roster = %v", peers)
	}
	pj := recv(t, a, "peer-joined")
	if pj["name"] != "bob" {
		t.Errorf("peer-joined = %v", pj)
	}
	b.Close(websocket.StatusNormalClosure, "")
	pl := recv(t, a, "peer-left")
	if pl["id"] != jb["selfId"] {
		t.Errorf("peer-left id = %v, want %v", pl["id"], jb["selfId"])
	}
}

func TestWrongPassword(t *testing.T) {
	h, srv := newTestHub(t, "", true)
	rm, _ := h.reg.Resolve("locked", nil)
	op := &room.Participant{ID: "op1", Name: "op", Role: room.RoleUser, Conn: nopConn{}}
	rm.Join(op, "")
	rm.SetLock("op1", "sesame")

	c := dialRoom(t, srv, "locked")
	send(t, c, map[string]any{"type": "join", "name": "eve", "password": "wrong"})
	e := recv(t, c, "error")
	if e["code"] != "bad-password" {
		t.Errorf("code = %v", e["code"])
	}
}

func TestTokenJoinProvisionsAndGrantsOp(t *testing.T) {
	_, srv := newTestHub(t, testSecret, false) // channel-rooms-only
	c := dialRoom(t, srv, "swift")
	send(t, c, map[string]any{"type": "join", "token": opToken(t, "swift", 0)})
	j := recv(t, c, "joined")
	if j["role"] != "op" {
		t.Errorf("tokened op role = %v", j["role"])
	}
}

func TestUnprovisionedRejected(t *testing.T) {
	_, srv := newTestHub(t, testSecret, false)
	c := dialRoom(t, srv, "ghost")
	send(t, c, map[string]any{"type": "join", "name": "eve"})
	if e := recv(t, c, "error"); e["code"] != "not-provisioned" {
		t.Errorf("code = %v", e["code"])
	}
}

func TestIdentifiedOnlyRejectsGuest(t *testing.T) {
	_, srv := newTestHub(t, testSecret, false)
	c := dialRoom(t, srv, "swift")
	send(t, c, map[string]any{"type": "join", "token": opToken(t, "swift", token.FlagIdentifiedOnly)})
	recv(t, c, "joined")
	g := dialRoom(t, srv, "swift")
	send(t, g, map[string]any{"type": "join", "name": "rando"})
	if e := recv(t, g, "error"); e["code"] != "identified-only" {
		t.Errorf("code = %v", e["code"])
	}
}

func TestBadAndExpiredTokens(t *testing.T) {
	_, srv := newTestHub(t, testSecret, false)
	c := dialRoom(t, srv, "swift")
	send(t, c, map[string]any{"type": "join", "token": "garbage.token"})
	if e := recv(t, c, "error"); e["code"] != "token-invalid" {
		t.Errorf("code = %v", e["code"])
	}
	expired, _ := token.Sign(token.Claims{Room: "swift", Nick: "x", Role: "op",
		IssuedAt: 1, ExpiresAt: 2}, []byte(testSecret))
	c2 := dialRoom(t, srv, "swift")
	send(t, c2, map[string]any{"type": "join", "token": expired})
	if e := recv(t, c2, "error"); e["code"] != "token-expired" {
		t.Errorf("code = %v", e["code"])
	}
}

func TestJoinTimeout(t *testing.T) {
	old := joinTimeout
	joinTimeout = 100 * time.Millisecond
	t.Cleanup(func() { joinTimeout = old })
	_, srv := newTestHub(t, "", true)
	c := dialRoom(t, srv, "lobby")
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if _, _, err := c.Read(ctx); err == nil {
		t.Error("socket should close when no join arrives")
	}
}

type nopConn struct{}

func (nopConn) Send(v any) bool { return true }
func (nopConn) Close()          {}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/server/`
Expected: FAIL — `undefined: NewHub`, etc.

- [ ] **Step 3: Implement the hub**

`internal/server/server.go`:

```go
package server

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode"

	"github.com/coder/websocket"

	"github.com/ryanwohara/webrtc-chat/internal/config"
	"github.com/ryanwohara/webrtc-chat/internal/room"
	"github.com/ryanwohara/webrtc-chat/internal/signal"
	"github.com/ryanwohara/webrtc-chat/internal/token"
)

var joinTimeout = 10 * time.Second

var slugRe = regexp.MustCompile(`^[a-z0-9-]{1,32}$`)

type Hub struct {
	cfg config.Config
	reg *room.Registry
	log *slog.Logger
	now func() time.Time
}

func NewHub(cfg config.Config, reg *room.Registry, log *slog.Logger, now func() time.Time) *Hub {
	if now == nil {
		now = time.Now
	}
	return &Hub{cfg: cfg, reg: reg, log: log, now: now}
}

func (h *Hub) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "ok\n")
	})
	mux.HandleFunc("GET /ws/{room}", h.handleWS)
	return mux
}

func (h *Hub) handleWS(w http.ResponseWriter, r *http.Request) {
	slug := strings.ToLower(r.PathValue("room"))
	if !slugRe.MatchString(slug) {
		http.Error(w, "bad room name", http.StatusBadRequest)
		return
	}
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	conn.SetReadLimit(16384)
	c := newWSClient(conn, h.log.With("room", slug))
	go c.writePump()
	defer recoverGuard(h.log, "ws "+slug)
	defer c.Close()
	h.serve(c, slug, clientIP(r))
}

func (h *Hub) serve(c *wsClient, slug, ip string) {
	jctx, cancel := c.withTimeout(joinTimeout)
	first, err := c.readNext(jctx)
	cancel()
	if err != nil {
		return
	}
	join, ok := first.(*signal.Join)
	if !ok {
		c.Send(signal.Error{Code: "protocol", Message: "first message must be join"})
		return
	}

	var claims *token.Claims
	if join.Token != "" {
		if h.cfg.Secret == "" {
			c.Send(signal.Error{Code: "token-invalid", Message: "tokens not enabled on this server"})
			return
		}
		cl, err := token.Verify(join.Token, []byte(h.cfg.Secret), h.now())
		switch {
		case errors.Is(err, token.ErrExpired):
			c.Send(signal.Error{Code: "token-expired", Message: "token expired; run !vc again"})
			return
		case err != nil:
			c.Send(signal.Error{Code: "token-invalid", Message: "invalid token"})
			return
		}
		if cl.Room != slug {
			c.Send(signal.Error{Code: "token-invalid", Message: "token is for another room"})
			return
		}
		claims = &cl
	}

	rm, err := h.reg.Resolve(slug, claims)
	if err != nil {
		c.Send(signal.Error{Code: "not-provisioned", Message: "room not active; run !vc in its channel"})
		return
	}

	p := &room.Participant{ID: newID(), IP: ip, Conn: c}
	if claims != nil {
		p.Name, p.Account, p.Role = claims.Nick, claims.Account, roleFromClaim(claims.Role)
	} else {
		p.Name, p.Role = sanitizeName(join.Name), room.RoleGuest
	}
	if err := rm.Join(p, join.Password); err != nil {
		c.Send(signal.Error{Code: errCode(err), Message: err.Error()})
		return
	}
	defer rm.Leave(p.ID)

	for {
		v, err := c.readNext(c.ctx)
		if err != nil {
			return
		}
		switch v.(type) {
		case *signal.Leave:
			return
		case *signal.Chat, *signal.SetLock, *signal.Kick, *signal.MutePeer, *signal.Ban:
			h.dispatch(rm, p, v) // Task 9
		case *signal.Offer, *signal.Answer, *signal.Candidate:
			// Media negotiation lands in Plan 2.
		}
	}
}

// dispatch handles in-room commands. Filled in by Task 9.
func (h *Hub) dispatch(rm *room.Room, p *room.Participant, v any) {}

func roleFromClaim(role string) room.Role {
	switch role {
	case "op":
		return room.RoleOp
	case "voice":
		return room.RoleVoice
	}
	return room.RoleUser
}

func errCode(err error) string {
	switch {
	case errors.Is(err, room.ErrBadPassword):
		return "bad-password"
	case errors.Is(err, room.ErrBanned):
		return "banned"
	case errors.Is(err, room.ErrIdentifiedOnly):
		return "identified-only"
	case errors.Is(err, room.ErrNotOp):
		return "not-op"
	case errors.Is(err, room.ErrNoSuchPeer):
		return "no-such-peer"
	}
	return "error"
}

func newID() string {
	var b [9]byte
	rand.Read(b[:])
	return base64.RawURLEncoding.EncodeToString(b[:])
}

// sanitizeName strips control characters, collapses whitespace, and caps
// guest names at 24 runes; empty becomes "guest".
func sanitizeName(name string) string {
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, name)
	name = strings.Join(strings.Fields(name), " ")
	runes := []rune(name)
	if len(runes) > 24 {
		name = string(runes[:24])
	}
	if name == "" {
		return "guest"
	}
	return name
}

// clientIP prefers the first X-Forwarded-For hop (we deploy behind a
// reverse proxy per the spec), falling back to the socket address.
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		first, _, _ := strings.Cut(xff, ",")
		return strings.TrimSpace(first)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
```

Also add this tiny helper to `internal/server/ws.go` (it needs wsClient's
internals):

```go
// withTimeout derives a read context bounded by both the client lifetime
// and d.
func (c *wsClient) withTimeout(d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(c.ctx, d)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test -race ./internal/server/ -v`
Expected: all tests PASS (Task 7's suite still green).

- [ ] **Step 5: Commit**

```bash
git add internal/server/
git commit -m "feat(webrtc-chat): ws join flow with tokens, guests, roster events"
```

---

### Task 9: Chat and moderation commands over WS

**Files:**
- Modify: `internal/server/server.go` (fill in `dispatch`)
- Create: `internal/server/dispatch_test.go`

**Interfaces:**
- Consumes: `room.Room` methods (Tasks 4–5), `Hub.serve` loop (Task 8).
- Produces: the complete in-room command surface. `dispatch` keeps the exact
  signature Task 8 declared: `func (h *Hub) dispatch(rm *room.Room, p *room.Participant, v any)`.

**Rules:**
- `chat`: trim; reject empty or >2000 runes silently (log at debug). Otherwise `rm.Chat`.
- `set-lock` / `kick` / `mute-peer` / `ban`: call the room method; a returned
  error goes back **only to the actor** as an `error` frame (e.g. `not-op`) —
  moderation failures are private, successes are broadcast by the Room itself.

- [ ] **Step 1: Write the failing tests**

`internal/server/dispatch_test.go`:

```go
package server

import (
	"testing"

	"github.com/ryanwohara/webrtc-chat/internal/token"
)

func TestChatFanOutAndReplay(t *testing.T) {
	_, srv := newTestHub(t, "", true)
	a := dialRoom(t, srv, "cafe")
	send(t, a, map[string]any{"type": "join", "name": "alice"})
	recv(t, a, "joined")
	b := dialRoom(t, srv, "cafe")
	send(t, b, map[string]any{"type": "join", "name": "bob"})
	recv(t, b, "joined")

	send(t, a, map[string]any{"type": "chat", "text": "hello"})
	m := recv(t, b, "chat")
	if m["from"] != "alice" || m["text"] != "hello" {
		t.Errorf("chat = %v", m)
	}
	// late joiner gets replay
	c := dialRoom(t, srv, "cafe")
	send(t, c, map[string]any{"type": "join", "name": "carol"})
	recv(t, c, "joined")
	if m := recv(t, c, "chat"); m["text"] != "hello" {
		t.Errorf("replay = %v", m)
	}
}

func TestModerationOverWS(t *testing.T) {
	_, srv := newTestHub(t, testSecret, false)
	op := dialRoom(t, srv, "swift")
	send(t, op, map[string]any{"type": "join", "token": opToken(t, "swift", 0)})
	recv(t, op, "joined")
	guest := dialRoom(t, srv, "swift")
	send(t, guest, map[string]any{"type": "join", "name": "troll"})
	j := recv(t, guest, "joined")
	trollID := j["selfId"].(string)

	// guest cannot moderate: error comes back only to them
	send(t, guest, map[string]any{"type": "kick", "id": "whoever"})
	if e := recv(t, guest, "error"); e["code"] != "not-op" {
		t.Errorf("code = %v", e["code"])
	}

	// op mutes: guest gets muted, op sees the feed entry
	send(t, op, map[string]any{"type": "mute-peer", "id": trollID, "kind": "mic"})
	if m := recv(t, guest, "muted"); m["kind"] != "mic" {
		t.Errorf("muted = %v", m)
	}
	if m := recv(t, op, "moderation"); m["action"] != "mute" {
		t.Errorf("feed = %v", m)
	}

	// op locks, then kicks
	send(t, op, map[string]any{"type": "set-lock", "password": "pw"})
	recv(t, op, "room-locked")
	send(t, op, map[string]any{"type": "kick", "id": trollID})
	if k := recv(t, guest, "kicked"); k["by"] != "Ryan" {
		t.Errorf("kicked = %v", k)
	}
}

func TestBanOverWSBlocksRejoin(t *testing.T) {
	_, srv := newTestHub(t, testSecret, false)
	op := dialRoom(t, srv, "swift")
	send(t, op, map[string]any{"type": "join", "token": opToken(t, "swift", 0)})
	recv(t, op, "joined")

	victimTok, _ := token.Sign(token.Claims{Room: "swift", Channel: "#swift",
		Account: "victim", Nick: "victim", Role: "user",
		IssuedAt: 1, ExpiresAt: 9999999999}, []byte(testSecret))
	v1 := dialRoom(t, srv, "swift")
	send(t, v1, map[string]any{"type": "join", "token": victimTok})
	j := recv(t, v1, "joined")

	send(t, op, map[string]any{"type": "ban", "id": j["selfId"].(string)})
	recv(t, v1, "banned")

	v2 := dialRoom(t, srv, "swift")
	send(t, v2, map[string]any{"type": "join", "token": victimTok})
	if e := recv(t, v2, "error"); e["code"] != "banned" {
		t.Errorf("rejoin code = %v", e["code"])
	}
}

func TestOversizedChatDropped(t *testing.T) {
	_, srv := newTestHub(t, "", true)
	a := dialRoom(t, srv, "cafe")
	send(t, a, map[string]any{"type": "join", "name": "alice"})
	recv(t, a, "joined")
	big := make([]byte, 3000)
	for i := range big {
		big[i] = 'x'
	}
	send(t, a, map[string]any{"type": "chat", "text": string(big)})
	send(t, a, map[string]any{"type": "chat", "text": "small"})
	if m := recv(t, a, "chat"); m["text"] != "small" {
		t.Errorf("oversized chat was not dropped: %v", m["text"])
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/server/`
Expected: `TestChatFanOutAndReplay` etc. FAIL (dispatch is a no-op stub).

- [ ] **Step 3: Implement dispatch**

Replace the stub in `internal/server/server.go`:

```go
const maxChatRunes = 2000

// dispatch handles in-room commands after join. Moderation errors are
// private to the actor; successes broadcast via the Room.
func (h *Hub) dispatch(rm *room.Room, p *room.Participant, v any) {
	var err error
	switch m := v.(type) {
	case *signal.Chat:
		text := strings.TrimSpace(m.Text)
		if text == "" || len([]rune(text)) > maxChatRunes {
			h.log.Debug("chat dropped", "from", p.ID, "len", len(m.Text))
			return
		}
		rm.Chat(p.ID, text)
		return
	case *signal.SetLock:
		err = rm.SetLock(p.ID, m.Password)
	case *signal.Kick:
		err = rm.Kick(p.ID, m.ID)
	case *signal.MutePeer:
		err = rm.MutePeer(p.ID, m.ID, m.Kind)
	case *signal.Ban:
		err = rm.Ban(p.ID, m.ID)
	default:
		return
	}
	if err != nil {
		p.Conn.Send(signal.Error{Code: errCode(err), Message: err.Error()})
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test -race ./internal/server/ -v`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/server/
git commit -m "feat(webrtc-chat): chat and moderation commands over websocket"
```

---

### Task 10: HTTP API — room peek and provisioning

**Files:**
- Modify: `internal/server/server.go` (add routes + handlers)
- Create: `internal/server/api_test.go`

**Interfaces:**
- Consumes: `Registry.Peek`, `Registry.Provision`, `cfg.Secret`.
- Produces (consumed by the pre-join screen in Plan 2 and the Anope module in Plan 3):
  - `GET /api/rooms/{room}` → `200 {"count": N, "locked": bool}` — always 200
    for valid slugs (a dead room is `{"count":0,"locked":false}`), 400 for bad slugs.
  - `POST /api/provision` with `Authorization: Bearer <secret>`, body
    `{"channel":"#swift","room":"swift","settings":{"identifiedOnly":true}}`
    → `204`. `401` on missing/wrong secret (constant-time compare), `403` when
    no secret is configured, `400` on bad body/slug.

- [ ] **Step 1: Write the failing tests**

`internal/server/api_test.go`:

```go
package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func get(t *testing.T, url string) (int, map[string]any) {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var m map[string]any
	json.NewDecoder(resp.Body).Decode(&m)
	return resp.StatusCode, m
}

func provision(t *testing.T, url, secret, body string) int {
	t.Helper()
	req, _ := http.NewRequest("POST", url+"/api/provision", strings.NewReader(body))
	if secret != "" {
		req.Header.Set("Authorization", "Bearer "+secret)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	return resp.StatusCode
}

func TestRoomPeek(t *testing.T) {
	h, srv := newTestHub(t, "", true)
	if code, m := get(t, srv.URL+"/api/rooms/ghost"); code != 200 || m["count"].(float64) != 0 {
		t.Errorf("ghost: %d %v", code, m)
	}
	rm, _ := h.reg.Resolve("busy", nil)
	rm.Join(&room.Participant{ID: "p1", Name: "a", Role: room.RoleUser, Conn: nopConn{}}, "")
	rm.SetLock("p1", "pw")
	if _, m := get(t, srv.URL+"/api/rooms/busy"); m["count"].(float64) != 1 || m["locked"] != true {
		t.Errorf("busy: %v", m)
	}
	if code, _ := get(t, srv.URL + "/api/rooms/Bad!Slug"); code != 400 {
		t.Errorf("bad slug code = %d", code)
	}
}

func TestProvisionAuth(t *testing.T) {
	_, srv := newTestHub(t, testSecret, false)
	body := `{"channel":"#swift","room":"swift","settings":{"identifiedOnly":false}}`
	if code := provision(t, srv.URL, "", body); code != 401 {
		t.Errorf("no auth = %d", code)
	}
	if code := provision(t, srv.URL, "wrong", body); code != 401 {
		t.Errorf("wrong secret = %d", code)
	}
	if code := provision(t, srv.URL, testSecret, body); code != 204 {
		t.Errorf("good secret = %d", code)
	}
	if code := provision(t, srv.URL, testSecret, `{"room":"Bad!"}`); code != 400 {
		t.Errorf("bad slug = %d", code)
	}
	// provisioning makes the room joinable in channel-rooms-only mode
	c := dialRoom(t, srv, "swift")
	send(t, c, map[string]any{"type": "join", "name": "guest"})
	recv(t, c, "joined")
}

func TestProvisionDisabledWithoutSecret(t *testing.T) {
	_, srv := newTestHub(t, "", true)
	body := `{"channel":"#x","room":"x","settings":{}}`
	if code := provision(t, srv.URL, "anything", body); code != 403 {
		t.Errorf("no-secret server = %d", code)
	}
}
```

Add `"github.com/ryanwohara/webrtc-chat/internal/room"` to this file's imports.

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/server/`
Expected: FAIL — 404s (routes missing).

- [ ] **Step 3: Implement the handlers**

In `internal/server/server.go`, register in `Routes()`:

```go
	mux.HandleFunc("GET /api/rooms/{room}", h.handleRoomPeek)
	mux.HandleFunc("POST /api/provision", h.handleProvision)
```

and add (imports: `crypto/subtle`, `encoding/json`):

```go
func (h *Hub) handleRoomPeek(w http.ResponseWriter, r *http.Request) {
	slug := strings.ToLower(r.PathValue("room"))
	if !slugRe.MatchString(slug) {
		http.Error(w, "bad room name", http.StatusBadRequest)
		return
	}
	count, locked := h.reg.Peek(slug)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"count": count, "locked": locked})
}

func (h *Hub) handleProvision(w http.ResponseWriter, r *http.Request) {
	if h.cfg.Secret == "" {
		http.Error(w, "provisioning disabled", http.StatusForbidden)
		return
	}
	auth := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if subtle.ConstantTimeCompare([]byte(auth), []byte(h.cfg.Secret)) != 1 {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	var body struct {
		Channel  string `json:"channel"`
		Room     string `json:"room"`
		Settings struct {
			IdentifiedOnly bool `json:"identifiedOnly"`
		} `json:"settings"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
		http.Error(w, "bad body", http.StatusBadRequest)
		return
	}
	slug := strings.ToLower(body.Room)
	if !slugRe.MatchString(slug) || body.Channel == "" {
		http.Error(w, "bad channel/room", http.StatusBadRequest)
		return
	}
	h.reg.Provision(body.Channel, slug, body.Settings.IdentifiedOnly)
	h.log.Info("provisioned", "channel", body.Channel, "room", slug, "identifiedOnly", body.Settings.IdentifiedOnly)
	w.WriteHeader(http.StatusNoContent)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test -race ./internal/server/ -v`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/server/
git commit -m "feat(webrtc-chat): room peek and authenticated provisioning API"
```

---

### Task 11: Lifecycle — GC ticker, shutdown broadcast, final wiring

**Files:**
- Modify: `cmd/webrtc-chat/main.go` (replace the Task 1 skeleton's mux with the Hub; add GC ticker + shutdown broadcast)
- Create: `internal/server/lifecycle_test.go`
- Modify: `internal/server/server.go` (add `Hub.Shutdown`, `Hub.RunGC`)

**Interfaces:**
- Consumes: everything prior.
- Produces:

```go
func (h *Hub) Shutdown()                      // ServerRestarting to every room, close all conns
func (h *Hub) RunGC(ctx context.Context)      // ticker loop calling reg.Sweep(); returns on ctx cancel
```

- [ ] **Step 1: Write the failing tests**

`internal/server/lifecycle_test.go`:

```go
package server

import (
	"testing"
)

func TestShutdownBroadcasts(t *testing.T) {
	h, srv := newTestHub(t, "", true)
	a := dialRoom(t, srv, "lobby")
	send(t, a, map[string]any{"type": "join", "name": "alice"})
	recv(t, a, "joined")
	go h.Shutdown()
	if m := recv(t, a, "server-restarting"); m == nil {
		t.Fatal("no server-restarting frame")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/server/ -run TestShutdownBroadcasts`
Expected: FAIL — `undefined: (*Hub).Shutdown`.

- [ ] **Step 3: Implement lifecycle methods**

Add to `internal/server/server.go` (import `context`):

```go
// Shutdown tells every participant the server is restarting (clients show
// "reconnecting…" and rejoin-loop) and closes their connections.
func (h *Hub) Shutdown() {
	for _, rm := range h.reg.Rooms() {
		rm.Shutdown()
	}
}

// RunGC sweeps empty rooms every 15s until ctx is cancelled.
func (h *Hub) RunGC(ctx context.Context) {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			h.reg.Sweep()
		case <-ctx.Done():
			return
		}
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test -race ./internal/server/ -v`
Expected: all tests PASS.

- [ ] **Step 5: Wire main.go**

Replace `cmd/webrtc-chat/main.go`'s body:

```go
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/ryanwohara/webrtc-chat/internal/config"
	"github.com/ryanwohara/webrtc-chat/internal/room"
	"github.com/ryanwohara/webrtc-chat/internal/server"
)

func main() {
	cfg, err := config.Load(os.Args[1:], os.Getenv)
	if err != nil {
		slog.Error("config", "err", err)
		os.Exit(2)
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))

	reg := room.NewRegistry(cfg.AdhocRooms, time.Now)
	hub := server.NewHub(cfg, reg, log, time.Now)
	srv := &http.Server{Addr: cfg.Addr, Handler: hub.Routes()}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go hub.RunGC(ctx)
	go func() {
		<-ctx.Done()
		hub.Shutdown()
		sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		srv.Shutdown(sctx)
	}()

	log.Info("listening", "addr", cfg.Addr, "adhoc", cfg.AdhocRooms, "tokens", cfg.Secret != "")
	if cfg.TLSCert != "" {
		err = srv.ListenAndServeTLS(cfg.TLSCert, cfg.TLSKey)
	} else {
		err = srv.ListenAndServe()
	}
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Error("serve", "err", err)
		os.Exit(1)
	}
}
```

- [ ] **Step 6: Full verification**

Run: `go vet ./... && go test -race ./...`
Expected: vet clean, every package PASS.

Run a smoke test:

```bash
go run ./cmd/webrtc-chat -secret devsecret &
sleep 1
curl -s localhost:8080/api/rooms/lobby   # {"count":0,"locked":false}
curl -s -X POST -H "Authorization: Bearer devsecret" \
  -d '{"channel":"#swift","room":"swift","settings":{"identifiedOnly":false}}' \
  -i localhost:8080/api/provision | head -1   # HTTP/1.1 204
kill %1
```

- [ ] **Step 7: Commit**

```bash
git add cmd/ internal/
git commit -m "feat(webrtc-chat): lifecycle wiring - GC ticker and graceful shutdown broadcast"
```

---

## Plan 1 exit criteria

- `go test -race ./...` green; `go vet ./...` clean.
- A running binary accepts WS joins (guest + tokened), fans out chat with
  replay, enforces locks/bans/identified-only, exposes peek + provision APIs,
  and survives `kill -TERM` by telling clients to reconnect.
- No media yet: `offer`/`answer`/`candidate` frames are accepted and ignored.
  Plan 2 (media plane, vanilla JS client, Playwright E2E, Prometheus
  metrics + pprof, load-sanity script, deploy docs) builds directly on
  `Hub.serve`'s negotiation cases and `signal.Tracks`. Plan 3 (Anope module)
  builds against `internal/token/testdata/vectors.json` and `/api/provision`.
  Those two plans complete the spec's remaining requirements.

