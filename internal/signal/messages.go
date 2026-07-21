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

// Countdown is a client's request to start or stop the synced countdown sound.
// Action ∈ start|stop. The server is authoritative: only the participant who
// started it may stop it, and while it runs others are locked out.
type Countdown struct {
	Action string `json:"action"` // "start" | "stop"
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
// CountdownEvent tells every client the synced countdown started or stopped.
// By is the starter's display name. On start clients play /RocketCountdown.mp3
// and lock the control for everyone but the starter; on stop they reset it.
type CountdownEvent struct {
	Action string `json:"action"` // "start" | "stop"
	By     string `json:"by"`
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
	case "countdown":
		v = &Countdown{}
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
	case CountdownEvent, *CountdownEvent:
		return "countdown", nil
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
