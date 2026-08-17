package room

import (
	"errors"
	"strconv"
	"strings"

	"github.com/SwiftIRC/coyote/internal/signal"
)

// Limits on a poll's text, mirroring maxChatRunes on the chat path. The client's
// compose form applies the same ones, so a frame that violates them is hand-rolled.
const (
	MaxPollQuestionRunes = 200
	MaxPollOptionRunes   = 80
	MinPollOptions       = 2
	MaxPollOptions       = 6
)

var (
	ErrNoPoll        = errors.New("room: no poll")
	ErrPollClosed    = errors.New("room: poll closed")
	ErrStalePoll     = errors.New("room: stale poll id")
	ErrBadPollChoice = errors.New("room: bad poll choice")
	ErrBadPoll       = errors.New("room: bad poll")
)

// Poll is the room's single active poll. Votes are anonymous to every client: the
// per-voter map exists only to stop double-voting and to let someone change their
// mind, and is never broadcast in any form.
type Poll struct {
	ID       string
	Question string
	Options  []string
	Open     bool
	ByName   string
	votes    map[string]int // voterKey -> index into Options
}

// tallies counts votes per option. Called with r.mu held.
func (p *Poll) tallies() []int {
	out := make([]int, len(p.Options))
	for _, choice := range p.votes {
		if choice >= 0 && choice < len(out) {
			out[choice]++
		}
	}
	return out
}

// event builds the broadcast form of the poll. Options is copied so a later mutation
// of the stored poll cannot race a frame already queued for a slow client.
// Called with r.mu held.
func (p *Poll) event(action string) signal.PollEvent {
	return signal.PollEvent{
		Action:   action,
		ID:       p.ID,
		Question: p.Question,
		Options:  append([]string(nil), p.Options...),
		Tallies:  p.tallies(),
		By:       p.ByName,
		Open:     p.Open,
	}
}

// voterKey identifies a voter across reconnects. A reconnect mints a fresh
// participant ID but carries the same session ref, so ref wins where there is one.
// A participant with no ref (a client that sent no session nonce) falls back to its
// ID, which is unique per connection — the "ref:"/"id:" prefixes keep the two
// namespaces from ever colliding, so ref-less voters can never share a bucket the
// way an unprefixed "" key would.
func voterKey(p *Participant) string {
	if p.Ref != "" {
		return "ref:" + p.Ref
	}
	return "id:" + p.ID
}

// CreatePoll opens a poll, replacing any existing one (its votes go with it). Op-only.
// Validation runs before the lock — it needs no room state.
func (r *Room) CreatePoll(actorID, question string, options []string) error {
	question = strings.TrimSpace(question)
	if question == "" || len([]rune(question)) > MaxPollQuestionRunes {
		return ErrBadPoll
	}
	clean := make([]string, 0, len(options))
	for _, o := range options {
		o = strings.TrimSpace(o)
		if o == "" || len([]rune(o)) > MaxPollOptionRunes {
			return ErrBadPoll
		}
		clean = append(clean, o)
	}
	if len(clean) < MinPollOptions || len(clean) > MaxPollOptions {
		return ErrBadPoll
	}

	r.mu.Lock()
	actor, ok := r.parts[actorID]
	if !ok {
		r.mu.Unlock()
		return ErrNoSuchPeer
	}
	if actor.Role != RoleOp {
		r.mu.Unlock()
		return ErrNotOp
	}
	r.pollSeq++
	r.poll = &Poll{
		ID:       strconv.Itoa(r.pollSeq),
		Question: question,
		Options:  clean,
		Open:     true,
		ByName:   actor.Name,
		votes:    map[string]int{},
	}
	ev := r.poll.event("open")
	by := actor.Name
	r.mu.Unlock()

	r.Broadcast(ev, "")
	r.Broadcast(signal.Moderation{Actor: by, Action: "poll-open"}, "")
	return nil
}

// Vote casts or changes actorID's vote. Anyone in the room may vote.
func (r *Room) Vote(actorID, pollID string, choice int) error {
	r.mu.Lock()
	actor, ok := r.parts[actorID]
	if !ok {
		r.mu.Unlock()
		return ErrNoSuchPeer
	}
	if r.poll == nil {
		r.mu.Unlock()
		return ErrNoPoll
	}
	if r.poll.ID != pollID {
		r.mu.Unlock()
		return ErrStalePoll
	}
	if !r.poll.Open {
		r.mu.Unlock()
		return ErrPollClosed
	}
	if choice < 0 || choice >= len(r.poll.Options) {
		r.mu.Unlock()
		return ErrBadPollChoice
	}
	key := voterKey(actor)
	if existing, ok := r.poll.votes[key]; ok && existing == choice {
		// Re-selecting the same choice changes no state, so there is nothing to
		// broadcast: skip the fan-out (a repeat click otherwise sends a full poll
		// frame to the whole room for zero state change, with no rate limiting).
		r.mu.Unlock()
		return nil
	}
	r.poll.votes[key] = choice
	ev := r.poll.event("update")
	r.mu.Unlock()

	r.Broadcast(ev, "")
	return nil
}

// ClosePoll freezes the tallies. Any op may close, not only the creator: unlike the
// countdown, a poll outliving its creator's reconnect is the point of the feature.
func (r *Room) ClosePoll(actorID, pollID string) error {
	r.mu.Lock()
	actor, ok := r.parts[actorID]
	if !ok {
		r.mu.Unlock()
		return ErrNoSuchPeer
	}
	if actor.Role != RoleOp {
		r.mu.Unlock()
		return ErrNotOp
	}
	if r.poll == nil {
		r.mu.Unlock()
		return ErrNoPoll
	}
	if r.poll.ID != pollID {
		r.mu.Unlock()
		return ErrStalePoll
	}
	if !r.poll.Open {
		r.mu.Unlock()
		return ErrPollClosed
	}
	r.poll.Open = false
	ev := r.poll.event("close")
	by := actor.Name
	r.mu.Unlock()

	r.Broadcast(ev, "")
	r.Broadcast(signal.Moderation{Actor: by, Action: "poll-close"}, "")
	return nil
}

// pollSnapshot is the active poll as p should see it on join: the shared fields plus
// p's OWN vote, which the broadcast never carries. Returns nil when no poll exists.
// Called with r.mu held (from Join).
func (r *Room) pollSnapshot(p *Participant) *signal.PollSnapshot {
	if r.poll == nil {
		return nil
	}
	snap := &signal.PollSnapshot{
		ID:       r.poll.ID,
		Question: r.poll.Question,
		Options:  append([]string(nil), r.poll.Options...),
		Tallies:  r.poll.tallies(),
		By:       r.poll.ByName,
		Open:     r.poll.Open,
	}
	if choice, ok := r.poll.votes[voterKey(p)]; ok {
		c := choice
		snap.YourVote = &c
	}
	return snap
}
