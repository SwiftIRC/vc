package server

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/coder/websocket"

	"github.com/ryanwohara/webrtc-chat/internal/config"
	"github.com/ryanwohara/webrtc-chat/internal/room"
	"github.com/ryanwohara/webrtc-chat/internal/sfu"
	"github.com/ryanwohara/webrtc-chat/internal/signal"
	"github.com/ryanwohara/webrtc-chat/internal/token"
)

var joinTimeout = 10 * time.Second

// rejectGrace bounds how long a rejected socket is held open after its error
// frame is sent. See reject.
var rejectGrace = 5 * time.Second

var slugRe = regexp.MustCompile(`^[a-z0-9-]{1,32}$`)

type Hub struct {
	cfg config.Config
	reg *room.Registry
	log *slog.Logger
	now func() time.Time
	sfu *sfu.SFU
	// conns tracks each connection's writePump goroutine so their lifetime
	// is joinable (graceful drain, and a happens-before edge for tests that
	// mutate the ws.go tunables).
	conns sync.WaitGroup
}

func NewHub(cfg config.Config, reg *room.Registry, log *slog.Logger, now func() time.Time, mediaSFU *sfu.SFU) *Hub {
	if now == nil {
		now = time.Now
	}
	return &Hub{cfg: cfg, reg: reg, log: log, now: now, sfu: mediaSFU}
}

// shutdownGrace is how long Shutdown waits after broadcasting ServerRestarting
// before closing sockets, so writePump flushes the frame first. Small so tests
// stay fast; negligible on a real restart.
var shutdownGrace = 250 * time.Millisecond

// Shutdown tells every participant the server is restarting (clients show
// "reconnecting…" and rejoin-loop), waits a grace so the frame is delivered,
// then closes their connections.
func (h *Hub) Shutdown() {
	rooms := h.reg.Rooms()
	for _, rm := range rooms {
		rm.Broadcast(signal.ServerRestarting{}, "")
	}
	time.Sleep(shutdownGrace)
	for _, rm := range rooms {
		rm.CloseConns()
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

func (h *Hub) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "ok\n")
	})
	mux.HandleFunc("GET /ws/{room}", h.handleWS)
	mux.HandleFunc("GET /api/rooms/{room}", h.handleRoomPeek)
	mux.HandleFunc("GET /api/version", h.handleVersion)
	mux.HandleFunc("POST /api/provision", h.handleProvision)
	// Catch-all app shell + static assets. The specific routes above are more
	// specific and still win under Go 1.22 mux precedence (verified in tests).
	mux.HandleFunc("GET /", h.handleStatic)
	return mux
}

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
	h.conns.Add(1)
	go func() {
		defer h.conns.Done()
		c.writePump()
	}()
	defer recoverGuard(h.log, "ws "+slug)
	defer c.Close()
	h.serve(c, slug, clientIP(r, h.cfg.TrustProxy))
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
		reject(c, signal.Error{Code: "protocol", Message: "first message must be join"})
		return
	}

	var claims *token.Claims
	if join.Token != "" {
		if h.cfg.Secret == "" {
			reject(c, signal.Error{Code: "token-invalid", Message: "tokens not enabled on this server"})
			return
		}
		cl, err := token.Verify(join.Token, []byte(h.cfg.Secret), h.now())
		switch {
		case errors.Is(err, token.ErrExpired):
			reject(c, signal.Error{Code: "token-expired", Message: "token expired; run !vc again"})
			return
		case err != nil:
			reject(c, signal.Error{Code: "token-invalid", Message: "invalid token"})
			return
		}
		if cl.Room != slug {
			reject(c, signal.Error{Code: "token-invalid", Message: "token is for another room"})
			return
		}
		claims = &cl
	}

	rm, err := h.reg.Resolve(slug, claims)
	if err != nil {
		reject(c, signal.Error{Code: "not-provisioned", Message: "room not active; run !vc in its channel"})
		return
	}

	p := &room.Participant{ID: newID(), IP: ip, Conn: c}
	if claims != nil {
		p.Name, p.Account, p.Role = claims.Nick, claims.Account, roleFromClaim(claims.Role)
	} else {
		p.Name, p.Role = sanitizeName(join.Name), room.RoleGuest
	}
	// Carry the joiner's reported mic/camera into the room before Join, so its
	// roster + PeerJoined broadcast reflect the real state (a pre-join mute shows
	// crossed-out immediately). A client that omits the fields defaults to ON.
	p.SetInitialMedia(join.Mic == nil || *join.Mic, join.Camera == nil || *join.Camera)
	if err := rm.Join(p, join.Password); err != nil {
		reject(c, signal.Error{Code: errCode(err), Message: err.Error()})
		return
	}
	defer rm.Leave(p.ID)

	// Attach the participant to the media plane: one SFU peer per socket,
	// signaling looped back through c (which satisfies sfu.Signaler via Send).
	mp, err := h.sfu.AddPeer(slug, p.ID, c)
	if err != nil {
		reject(c, signal.Error{Code: "media", Message: "media setup failed"})
		return
	}
	defer h.sfu.RemovePeer(slug, p.ID)

	for {
		v, err := c.readNext(c.ctx)
		if err != nil {
			return
		}
		switch m := v.(type) {
		case *signal.Leave:
			return
		case *signal.Chat, *signal.SetLock, *signal.Kick, *signal.MutePeer, *signal.Ban, *signal.GrantOp, *signal.Countdown, *signal.MediaState:
			h.dispatch(rm, p, m)
		case *signal.Offer:
			if err := mp.HandleOffer(m.SDP, m.Kinds); err != nil {
				h.log.Debug("offer", "err", err)
			}
		case *signal.Answer:
			if err := mp.HandleAnswer(m.SDP); err != nil {
				h.log.Debug("answer", "err", err)
			}
		case *signal.Candidate:
			if err := mp.HandleCandidate(m.Candidate); err != nil {
				h.log.Debug("candidate", "err", err)
			}
		}
	}
}

// reject delivers a terminal error and then keeps the socket open until the
// peer disconnects (it has no reason to send anything after a rejection) or a
// short grace elapses. The wait matters: Send only enqueues the frame for
// writePump, and the caller returns immediately into handleWS's deferred
// Close, which cancels the write context — so without holding the socket open
// the client would see the close frame and never the error. Blocking on the
// read keeps c.ctx alive across the flush, exactly as the post-join read loop
// does for a successful join.
func reject(c *wsClient, e signal.Error) {
	c.Send(e)
	ctx, cancel := c.withTimeout(rejectGrace)
	defer cancel()
	for {
		if _, err := c.readNext(ctx); err != nil {
			return
		}
	}
}

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
	case *signal.Countdown:
		// Countdown refusals (already active, not the starter, idle stop) are
		// deliberately silent: the client control already reflects the
		// authoritative state from the broadcast, and a lost start/stop race
		// self-heals when the winner's CountdownEvent arrives. We also avoid
		// sending an "error" frame here, which the in-call client would treat as
		// a terminal join error.
		if err := rm.Countdown(p.ID, m.Action); err != nil {
			h.log.Debug("countdown refused", "from", p.ID, "action", m.Action, "err", err)
		}
		return
	case *signal.MediaState:
		// A participant's own mic/camera state changed (or its initial post-join
		// assertion). Store it and fan it out so remote mute indicators are correct.
		rm.SetMediaState(p.ID, m.Mic, m.Camera)
		return
	case *signal.SetLock:
		err = rm.SetLock(p.ID, m.Password)
	case *signal.Kick:
		err = rm.Kick(p.ID, m.ID)
	case *signal.MutePeer:
		err = rm.MutePeer(p.ID, m.ID, m.Kind)
	case *signal.Ban:
		err = rm.Ban(p.ID, m.ID)
	case *signal.GrantOp:
		err = rm.GrantOp(p.ID, m.ID)
	default:
		return
	}
	if err != nil {
		p.Conn.Send(signal.Error{Code: errCode(err), Message: err.Error()})
	}
}

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

// clientIP returns the peer address. X-Forwarded-For is trusted ONLY when
// trustProxy is set (deployment is behind a trusted reverse proxy); in that
// case the trustworthy client is the RIGHTMOST hop, since the proxy appends the
// real peer. Otherwise the header is ignored and RemoteAddr is used.
func clientIP(r *http.Request, trustProxy bool) string {
	if trustProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			return strings.TrimSpace(parts[len(parts)-1])
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
