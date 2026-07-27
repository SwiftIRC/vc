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
	Token    string `json:"token,omitempty"`    // identity token from !vc (long link, #t=)
	Invite   string `json:"invite,omitempty"`   // short invite id resolved server-side (#i=)
	Session  string `json:"session,omitempty"`  // opaque per-tab nonce; binds a #i= invite to one session (single-use)
	// Mic/Camera is the joiner's initial self-reported media state, so existing
	// peers render the correct mute indicators the instant this peer appears —
	// with no "briefly un-muted" flash while a separate media-state frame
	// round-trips. Pointers: absent (an older or tokened client that omits them)
	// means "unknown", which the server defaults to ON.
	Mic    *bool `json:"mic,omitempty"`
	Camera *bool `json:"camera,omitempty"`
	// Gravatar is the SHA-256 hex hash of the joiner's normalized email, computed
	// client-side. Only the hash is ever sent — never the raw email. Cosmetic and
	// unverified (like Name for a guest); the server hex-validates it.
	Gravatar string `json:"gravatar,omitempty"`
}
type Offer struct {
	SDP string `json:"sdp"`
	// Kinds maps each locally published track's MSID stream id -> kind
	// (mic|camera|screen). A browser cannot set an arbitrary MSID stream id
	// (MediaStream.id is read-only and random), so it declares the kind here rather
	// than encoding it in the stream id; the SFU joins this to remote.StreamID().
	Kinds map[string]string `json:"kinds,omitempty"`
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

// GrantOp is an op promoting another participant to op (op-only).
type GrantOp struct {
	ID string `json:"id"`
}

// SetQuality is an op capping the session's outbound video quality (op-only). Target is
// "camera" or "screen"; Tier is a tier id the CLIENT maps to a resolution/framerate cap
// (the server only stores and relays the id).
type SetQuality struct {
	Target string `json:"target"` // "camera" | "screen"
	Tier   string `json:"tier"`   // auto|ultra|fast|high|medium|low
}

// SetReceiveVideo is a participant's own inbound-video gate — a per-user "low
// bandwidth" switch, NOT op-gated and NOT call-wide. Enabled=false asks the SFU
// to stop forwarding ALL video (camera + screenshare) to THIS peer, so a
// mobile/slow client downloads none of it; audio (mic, screen-audio) keeps
// flowing and the peer's own published tracks are unaffected. Never broadcast —
// it only changes the requester's own subscription, so no other client cares.
type SetReceiveVideo struct {
	Enabled bool `json:"enabled"`
}

// Countdown is a client's request to start or stop the synced countdown sound.
// Action ∈ start|stop. The server is authoritative: only the participant who
// started it may stop it, and while it runs others are locked out.
type Countdown struct {
	Action string `json:"action"` // "start" | "stop"
}

// MediaState is a participant's report of its OWN current mic/camera enabled
// state (true = live, false = self-muted / camera off). Sent on every local
// toggle and once right after join, so the server can store it and convey it to
// others. A self-muted track is still published (silence/black frames), so no
// track-end fires — this is the only signal others have that a peer is muted.
type MediaState struct {
	Mic    bool `json:"mic"`
	Camera bool `json:"camera"`
}

// Rename is a participant changing its OWN display name mid-call (display-only —
// the server keeps the account/role from the join token untouched).
type Rename struct {
	Name string `json:"name"`
}

// ---- polls ----

// CreatePoll opens a poll, replacing any existing one. Op-gated.
type CreatePoll struct {
	Question string   `json:"question"`
	Options  []string `json:"options"`
}

// Vote casts or changes this participant's vote. PollID keeps a client whose card is
// out of date from voting on a poll that has since been replaced.
type Vote struct {
	PollID string `json:"pollId"`
	Choice int    `json:"choice"` // index into the poll's Options
}

// ClosePoll freezes the tallies. Op-gated.
type ClosePoll struct {
	PollID string `json:"pollId"`
}

type Leave struct{}

// ---- server → client ----

type PeerInfo struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Role   string `json:"role"` // "op" | "voice" | "user" | "guest"
	Mic    bool   `json:"mic"`  // sender's mic enabled? (stored server-side)
	Camera bool   `json:"camera"`
	// Ref is a stable, opaque per-session id (derived from the client's session nonce,
	// never the nonce itself). It survives a reconnect — which mints a fresh ID — so a
	// client can tell a reconnecting member apart from a new one and skip the join/leave
	// chime for it. "" when the client supplied no session nonce.
	Ref      string `json:"ref,omitempty"`
	Gravatar string `json:"gravatar,omitempty"` // SHA-256 email hash for the peer's Gravatar; "" if none
}
type Joined struct {
	SelfID     string        `json:"selfId"`
	Role       string        `json:"role"`
	Peers      []PeerInfo    `json:"peers"`
	Quality    Quality       `json:"quality"`           // current session video caps, so a late joiner applies them
	RoomAgeSec int64         `json:"roomAge,omitempty"` // seconds the room has existed, as of this join
	Poll       *PollSnapshot `json:"poll,omitempty"`    // the room's active poll, or absent
}

// Quality is the session's outbound-video caps: each field is a tier id the client
// applies to its camera / screenshare senders. Broadcast on change and carried in Joined.
type Quality struct {
	Camera string `json:"camera"` // tier id; "" / "auto" = uncapped
	Screen string `json:"screen"`
}
type PeerJoined struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Role     string `json:"role"`
	Mic      bool   `json:"mic"` // initial mic state (defaults true on join)
	Camera   bool   `json:"camera"`
	Ref      string `json:"ref,omitempty"`      // stable per-session id; see PeerInfo.Ref
	Gravatar string `json:"gravatar,omitempty"` // see PeerInfo.Gravatar
}

// PeerMediaState tells every client that a peer's mic/camera enabled state
// changed. It is authoritative for the remote mute indicators (track presence
// cannot reflect a self-mute, since a muted track is still published).
type PeerMediaState struct {
	ID     string `json:"id"`
	Mic    bool   `json:"mic"`
	Camera bool   `json:"camera"`
}

// PeerRenamed tells every client (the sender included) a peer's display name changed.
type PeerRenamed struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}
type PeerLeft struct {
	ID  string `json:"id"`
	Ref string `json:"ref,omitempty"` // stable per-session id; see PeerInfo.Ref
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

// Moderation is the visible feed entry; Action ∈ kick|ban|mute|lock|unlock|op.
type Moderation struct {
	Actor  string `json:"actor"`
	Action string `json:"action"`
	Target string `json:"target,omitempty"`
	Kind   string `json:"kind,omitempty"` // for mute: which track
}

// RoleChange announces a participant's new role (currently only op promotion) so
// clients update the badge; the promoted client also gains its op controls.
type RoleChange struct {
	ID   string `json:"id"`
	Role string `json:"role"`
}

// CountdownEvent tells every client the synced countdown started or stopped.
// By is the starter's display name. On start clients play /RocketCountdown.mp3
// and lock the control for everyone but the starter; on stop they reset it.
type CountdownEvent struct {
	Action string `json:"action"` // "start" | "stop"
	By     string `json:"by"`
}

// PollEvent is the whole poll, broadcast on open, on every vote, and on close.
//
// It deliberately carries NO per-recipient data. A client knows its own vote because
// it cast it, and a reconnecting one gets it back from the Joined snapshot — putting
// yourVote here would force a per-recipient send loop in place of Broadcast.
type PollEvent struct {
	Action   string   `json:"action"` // "open" | "update" | "close"
	ID       string   `json:"id"`
	Question string   `json:"question"`
	Options  []string `json:"options"`
	Tallies  []int    `json:"tallies"` // parallel to Options
	By       string   `json:"by"`      // creator's display name
	Open     bool     `json:"open"`
}

// PollSnapshot is the active poll as a JOINER sees it: PollEvent's fields plus that
// joiner's own vote, which the broadcast omits. Carried in Joined.
type PollSnapshot struct {
	ID       string   `json:"id"`
	Question string   `json:"question"`
	Options  []string `json:"options"`
	Tallies  []int    `json:"tallies"`
	By       string   `json:"by"`
	Open     bool     `json:"open"`
	YourVote *int     `json:"yourVote,omitempty"` // nil = this joiner has not voted
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
	case "grant-op":
		v = &GrantOp{}
	case "set-quality":
		v = &SetQuality{}
	case "set-receive-video":
		v = &SetReceiveVideo{}
	case "countdown":
		v = &Countdown{}
	case "media-state":
		v = &MediaState{}
	case "rename":
		v = &Rename{}
	case "create-poll":
		v = &CreatePoll{}
	case "vote":
		v = &Vote{}
	case "close-poll":
		v = &ClosePoll{}
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
	case PeerMediaState, *PeerMediaState:
		return "peer-media-state", nil
	case PeerRenamed, *PeerRenamed:
		return "peer-renamed", nil
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
	case RoleChange, *RoleChange:
		return "role", nil
	case Moderation, *Moderation:
		return "moderation", nil
	case CountdownEvent, *CountdownEvent:
		return "countdown", nil
	case PollEvent, *PollEvent:
		return "poll", nil
	case Kicked, *Kicked:
		return "kicked", nil
	case Banned, *Banned:
		return "banned", nil
	case Muted, *Muted:
		return "muted", nil
	case Quality, *Quality:
		return "quality", nil
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
