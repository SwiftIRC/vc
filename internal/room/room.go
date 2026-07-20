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
	// Do not close the socket here: closing cancels the target's read context,
	// which hard-closes the connection and would race (drop) the frame just
	// sent. The client closes itself on "kicked"; the server reaps on EOF or
	// ping-eviction.
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
	// Same as Kick: deliver the frame, don't close. The ban is recorded above,
	// so any rejoin attempt is refused; the client closes itself on "banned".
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
