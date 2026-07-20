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
	"sync"
	"time"
	"unicode"

	"github.com/coder/websocket"

	"github.com/ryanwohara/webrtc-chat/internal/config"
	"github.com/ryanwohara/webrtc-chat/internal/room"
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
	// conns tracks each connection's writePump goroutine so their lifetime
	// is joinable (graceful drain, and a happens-before edge for tests that
	// mutate the ws.go tunables).
	conns sync.WaitGroup
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
	h.conns.Add(1)
	go func() {
		defer h.conns.Done()
		c.writePump()
	}()
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
	if err := rm.Join(p, join.Password); err != nil {
		reject(c, signal.Error{Code: errCode(err), Message: err.Error()})
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
