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
	// CloseAfter closes the connection after d elapses. Used to evict a
	// kicked/banned client after its notification frame has been delivered,
	// without racing the frame write (the socket stays open during d).
	CloseAfter(d time.Duration)
}

type Participant struct {
	ID      string
	Name    string
	Account string // NickServ account; "" for guests
	IP      string
	Role    Role
	Conn    Conn
	// Self-reported media state: is the mic / camera currently enabled? Both
	// default true on Join and are updated by SetMediaState when the participant
	// broadcasts a change. Stored here so the roster can convey it to late
	// joiners. Guarded by Room.mu.
	Mic    bool
	Camera bool
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

	ErrCountdownActive   = errors.New("room: countdown already active")
	ErrCountdownInactive = errors.New("room: no countdown active")
	ErrCountdownNotOwner = errors.New("room: only the starter can stop the countdown")
	ErrBadCountdown      = errors.New("room: bad countdown action")
)

// evictGrace is how long a kicked/banned client's socket stays open after its
// notification frame is sent, before being force-closed. Long enough for the
// client to receive the frame; bounded so an uncooperative client is still
// evicted.
var evictGrace = 5 * time.Second

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
	// Synced countdown sound. countdownActive gates the control for everyone;
	// countdownBy is the starter's participant ID so only they may stop it.
	countdownActive bool
	countdownBy     string
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
	// Media defaults ON; the client re-asserts its true state (which may be muted,
	// e.g. a pre-join toggle) with a media-state frame right after join.
	p.Mic = true
	p.Camera = true
	roster := make([]signal.PeerInfo, 0, len(r.parts))
	for _, q := range r.parts {
		roster = append(roster, signal.PeerInfo{ID: q.ID, Name: q.Name, Role: string(q.Role), Mic: q.Mic, Camera: q.Camera})
	}
	replay := append([]signal.ChatEvent(nil), r.chat...)
	r.parts[p.ID] = p
	r.emptySince = time.Time{}
	r.mu.Unlock()

	p.Conn.Send(signal.Joined{SelfID: p.ID, Role: string(p.Role), Peers: roster})
	for _, ce := range replay {
		p.Conn.Send(ce)
	}
	r.Broadcast(signal.PeerJoined{ID: p.ID, Name: p.Name, Role: string(p.Role), Mic: p.Mic, Camera: p.Camera}, p.ID)
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
	// If the leaver owned an active countdown, clear it so the control does not
	// stay locked for everyone else with no one able to stop it.
	countdownCleared := r.countdownActive && r.countdownBy == id
	if countdownCleared {
		r.countdownActive = false
		r.countdownBy = ""
	}
	r.mu.Unlock()
	if countdownCleared {
		r.Broadcast(signal.CountdownEvent{Action: "stop", By: p.Name}, "")
	}
	r.Broadcast(signal.PeerLeft{ID: id}, "")
}

// Countdown starts or stops the room's synced countdown sound. It is
// authoritative: a start is refused when one is already running, and only the
// participant who started it may stop it. Mutations happen under the mutex; the
// resulting CountdownEvent fans out after the lock is released (lock discipline
// matching Chat/SetLock). A late joiner is not synced — the sound is short, so a
// client that arrives mid-countdown simply won't hear it or see the lock.
func (r *Room) Countdown(actorID, action string) error {
	r.mu.Lock()
	actor, ok := r.parts[actorID]
	if !ok {
		r.mu.Unlock()
		return ErrNoSuchPeer
	}
	switch action {
	case "start":
		if r.countdownActive {
			r.mu.Unlock()
			return ErrCountdownActive
		}
		r.countdownActive = true
		r.countdownBy = actorID
		by := actor.Name
		r.mu.Unlock()
		r.Broadcast(signal.CountdownEvent{Action: "start", By: by}, "")
		return nil
	case "stop":
		if !r.countdownActive {
			r.mu.Unlock()
			return ErrCountdownInactive
		}
		if r.countdownBy != actorID {
			r.mu.Unlock()
			return ErrCountdownNotOwner
		}
		r.countdownActive = false
		r.countdownBy = ""
		by := actor.Name
		r.mu.Unlock()
		r.Broadcast(signal.CountdownEvent{Action: "stop", By: by}, "")
		return nil
	default:
		r.mu.Unlock()
		return ErrBadCountdown
	}
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

// SetMediaState records a participant's self-reported mic/camera enabled state
// and fans the change out to the OTHER participants so everyone's remote mute
// indicators stay correct. The sender is excluded (its own tile is driven locally,
// not by this echo). Unknown ids are a silent no-op. Lock discipline matches
// Chat/Countdown: the state is mutated under the mutex, then the PeerMediaState is
// broadcast after the lock is released. Stored on the Participant so a late joiner's
// roster (built in Join) reflects the current state without a replayed event.
func (r *Room) SetMediaState(id string, mic, camera bool) {
	r.mu.Lock()
	p, ok := r.parts[id]
	if !ok {
		r.mu.Unlock()
		return
	}
	p.Mic = mic
	p.Camera = camera
	r.mu.Unlock()
	r.Broadcast(signal.PeerMediaState{ID: id, Mic: mic, Camera: camera}, id)
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
	// Frame delivered; now schedule a bounded force-close so a live but
	// uncooperative client is still evicted rather than lingering indefinitely.
	tgt.Conn.CloseAfter(evictGrace)
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
	// Frame delivered; schedule a bounded force-close (same as Kick) so an
	// uncooperative client is evicted deterministically.
	tgt.Conn.CloseAfter(evictGrace)
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

// CloseConns closes every participant's connection. It does NOT broadcast:
// the caller (Hub.Shutdown) broadcasts ServerRestarting first and waits a grace
// so the frame flushes before these closes tear the sockets down.
func (r *Room) CloseConns() {
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
