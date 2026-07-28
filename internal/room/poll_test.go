package room

import (
	"errors"
	"strings"
	"testing"

	"github.com/ryanwohara/webrtc-chat/internal/signal"
)

// lastPoll returns the most recent PollEvent a fakeConn received, matching the
// lastCountdown / lastModeration helpers already in this package.
func lastPoll(c *fakeConn) (signal.PollEvent, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for i := len(c.msgs) - 1; i >= 0; i-- {
		if m, ok := c.msgs[i].(signal.PollEvent); ok {
			return m, true
		}
	}
	return signal.PollEvent{}, false
}

// countPollEvents counts every PollEvent a fakeConn received, matching countRenamed
// in rename_test.go — needed because lastPoll alone can't prove a SECOND broadcast
// never happened (the "last" one could just be the first, seen twice by coincidence).
func countPollEvents(c *fakeConn) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := 0
	for _, m := range c.msgs {
		if _, ok := m.(signal.PollEvent); ok {
			n++
		}
	}
	return n
}

// joinWithRef joins a participant carrying an explicit session ref, which member()
// does not set. Used for the reconnect tests, where the ref is the whole point.
func joinWithRef(t *testing.T, r *Room, id, name, ref string) (*Participant, *fakeConn) {
	t.Helper()
	p, c := member(id, name, RoleUser)
	p.Ref = ref
	if err := r.Join(p, ""); err != nil {
		t.Fatalf("join %s: %v", id, err)
	}
	return p, c
}

func TestOnlyOpCanCreateOrClosePoll(t *testing.T) {
	r, _, _, _, _ := modRoom(t) // p1 = op (first ad-hoc joiner), p2 = user

	if err := r.CreatePoll("p2", "Ship it?", []string{"Yes", "No"}); !errors.Is(err, ErrNotOp) {
		t.Fatalf("non-op create = %v, want ErrNotOp", err)
	}
	if err := r.CreatePoll("p1", "Ship it?", []string{"Yes", "No"}); err != nil {
		t.Fatalf("op create: %v", err)
	}
	id := r.poll.ID
	if err := r.ClosePoll("p2", id); !errors.Is(err, ErrNotOp) {
		t.Fatalf("non-op close = %v, want ErrNotOp", err)
	}
	if err := r.ClosePoll("p1", id); err != nil {
		t.Fatalf("op close: %v", err)
	}
}

// The open reaches everyone, including the creator, and carries the creator's name.
func TestCreatePollBroadcastsToAll(t *testing.T) {
	r, _, ac, _, bc := modRoom(t)
	if err := r.CreatePoll("p1", "Ship it?", []string{"Yes", "No"}); err != nil {
		t.Fatal(err)
	}
	for who, c := range map[string]*fakeConn{"alice": ac, "bob": bc} {
		ev, ok := lastPoll(c)
		if !ok || ev.Action != "open" || ev.By != "alice" || len(ev.Options) != 2 || !ev.Open {
			t.Errorf("%s got %+v ok=%v", who, ev, ok)
		}
		if len(ev.Tallies) != 2 || ev.Tallies[0] != 0 {
			t.Errorf("%s got tallies %v, want zeroed", who, ev.Tallies)
		}
	}
	if m, ok := lastModeration(ac); !ok || m.Actor != "alice" || m.Action != "poll-open" {
		t.Errorf("moderation feed = %+v ok=%v, want actor=alice action=poll-open", m, ok)
	}
}

func TestVoteCountsAndChanges(t *testing.T) {
	r, _, _, _, bc := modRoom(t)
	if err := r.CreatePoll("p1", "Ship it?", []string{"Yes", "No"}); err != nil {
		t.Fatal(err)
	}
	id := r.poll.ID

	if err := r.Vote("p2", id, 0); err != nil {
		t.Fatalf("vote: %v", err)
	}
	if got := r.poll.tallies(); got[0] != 1 || got[1] != 0 {
		t.Fatalf("tallies after one vote = %v", got)
	}
	if ev, ok := lastPoll(bc); !ok || ev.Action != "update" || ev.Tallies[0] != 1 {
		t.Errorf("update broadcast = %+v ok=%v", ev, ok)
	}
	// Changing a vote moves it; it does not add one.
	if err := r.Vote("p2", id, 1); err != nil {
		t.Fatalf("revote: %v", err)
	}
	if got := r.poll.tallies(); got[0] != 0 || got[1] != 1 {
		t.Fatalf("tallies after revote = %v", got)
	}
}

// Re-selecting the choice you already have changes no state, so it must not
// re-broadcast: a repeat click on your own selection would otherwise fan a full poll
// frame out to the whole room for zero state change, with no rate limiting.
func TestRepeatVoteSameChoiceDoesNotRebroadcast(t *testing.T) {
	r, _, _, _, bc := modRoom(t)
	if err := r.CreatePoll("p1", "Ship it?", []string{"Yes", "No"}); err != nil {
		t.Fatal(err)
	}
	id := r.poll.ID

	if err := r.Vote("p2", id, 0); err != nil {
		t.Fatalf("first vote: %v", err)
	}
	before := countPollEvents(bc)

	if err := r.Vote("p2", id, 0); err != nil {
		t.Fatalf("repeat vote (same choice): %v", err)
	}
	if got := countPollEvents(bc); got != before {
		t.Fatalf("repeat vote for the same choice broadcast again: %d poll events, want %d", got, before)
	}
	if got := r.poll.tallies(); got[0] != 1 || got[1] != 0 {
		t.Fatalf("tallies after repeat vote = %v, want unchanged [1 0]", got)
	}

	// A genuine change (different choice) must still broadcast.
	if err := r.Vote("p2", id, 1); err != nil {
		t.Fatalf("changed vote: %v", err)
	}
	if got := countPollEvents(bc); got != before+1 {
		t.Fatalf("changed vote did not broadcast: %d poll events, want %d", got, before+1)
	}
}

func TestVoteRefusals(t *testing.T) {
	r, _, _, _, _ := modRoom(t)

	if err := r.Vote("p2", "1", 0); !errors.Is(err, ErrNoPoll) {
		t.Fatalf("vote with no poll = %v, want ErrNoPoll", err)
	}
	if err := r.CreatePoll("p1", "Ship it?", []string{"Yes", "No"}); err != nil {
		t.Fatal(err)
	}
	id := r.poll.ID

	if err := r.Vote("p2", "not-"+id, 0); !errors.Is(err, ErrStalePoll) {
		t.Fatalf("stale id = %v, want ErrStalePoll", err)
	}
	if err := r.Vote("p2", id, 2); !errors.Is(err, ErrBadPollChoice) {
		t.Fatalf("out-of-range choice = %v, want ErrBadPollChoice", err)
	}
	if err := r.Vote("p2", id, -1); !errors.Is(err, ErrBadPollChoice) {
		t.Fatalf("negative choice = %v, want ErrBadPollChoice", err)
	}
	if err := r.ClosePoll("p1", id); err != nil {
		t.Fatal(err)
	}
	if err := r.Vote("p2", id, 0); !errors.Is(err, ErrPollClosed) {
		t.Fatalf("vote on closed poll = %v, want ErrPollClosed", err)
	}
}

// Mirrors TestVoteRefusals: ClosePoll's own no-poll/stale-id/already-closed guards,
// which TestOnlyOpCanCreateOrClosePoll never exercises (it only checks the op gate).
// Also pins the close broadcast itself — action must be "close" with open=false (a
// client keys off action === "close" to freeze the card) — and the moderation-feed
// entry, so a dropped or renamed line fails here rather than shipping silently.
func TestClosePollRefusals(t *testing.T) {
	r, _, ac, _, _ := modRoom(t)

	if err := r.ClosePoll("p1", "1"); !errors.Is(err, ErrNoPoll) {
		t.Fatalf("close with no poll = %v, want ErrNoPoll", err)
	}
	if err := r.CreatePoll("p1", "Ship it?", []string{"Yes", "No"}); err != nil {
		t.Fatal(err)
	}
	id := r.poll.ID

	if err := r.ClosePoll("p1", "not-"+id); !errors.Is(err, ErrStalePoll) {
		t.Fatalf("stale id = %v, want ErrStalePoll", err)
	}
	if err := r.ClosePoll("p1", id); err != nil {
		t.Fatal(err)
	}
	if ev, ok := lastPoll(ac); !ok || ev.Action != "close" || ev.Open {
		t.Errorf("close broadcast = %+v ok=%v, want action=close open=false", ev, ok)
	}
	if m, ok := lastModeration(ac); !ok || m.Actor != "alice" || m.Action != "poll-close" {
		t.Errorf("moderation feed = %+v ok=%v, want actor=alice action=poll-close", m, ok)
	}
	if err := r.ClosePoll("p1", id); !errors.Is(err, ErrPollClosed) {
		t.Fatalf("close on already-closed poll = %v, want ErrPollClosed", err)
	}
}

// A replacement poll gets a new ID, so a card still showing the old one cannot vote
// into the new tallies.
func TestNewPollSupersedesTheOld(t *testing.T) {
	r, _, _, _, _ := modRoom(t)
	if err := r.CreatePoll("p1", "First?", []string{"Yes", "No"}); err != nil {
		t.Fatal(err)
	}
	first := r.poll.ID
	if err := r.Vote("p2", first, 0); err != nil {
		t.Fatal(err)
	}
	if err := r.CreatePoll("p1", "Second?", []string{"Yes", "No"}); err != nil {
		t.Fatal(err)
	}
	if r.poll.ID == first {
		t.Fatal("replacement poll reused the previous id")
	}
	if got := r.poll.tallies(); got[0] != 0 || got[1] != 0 {
		t.Fatalf("replacement poll inherited tallies %v", got)
	}
	if err := r.Vote("p2", first, 0); !errors.Is(err, ErrStalePoll) {
		t.Fatalf("vote against superseded id = %v, want ErrStalePoll", err)
	}
}

// THE critical one: a reconnect mints a fresh participant ID but keeps the session
// ref, so the vote must stay put and come back in the snapshot.
func TestVoteSurvivesReconnectByRef(t *testing.T) {
	r, _, _, _, _ := modRoom(t)
	voter, _ := joinWithRef(t, r, "p3", "carol", "ref-carol")
	if err := r.CreatePoll("p1", "Ship it?", []string{"Yes", "No"}); err != nil {
		t.Fatal(err)
	}
	id := r.poll.ID
	if err := r.Vote(voter.ID, id, 1); err != nil {
		t.Fatal(err)
	}

	r.Leave("p3")
	again, _ := joinWithRef(t, r, "p4", "carol", "ref-carol") // same ref, fresh ID

	if got := r.poll.tallies(); got[1] != 1 {
		t.Fatalf("tally after reconnect = %v, want the vote still on option 1", got)
	}
	r.mu.Lock()
	snap := r.pollSnapshot(again)
	r.mu.Unlock()
	if snap == nil || snap.YourVote == nil || *snap.YourVote != 1 {
		t.Fatalf("reconnected voter's own vote not restored: %+v", snap)
	}
	// And voting again from the new ID must not add a second vote.
	if err := r.Vote(again.ID, id, 1); err != nil {
		t.Fatal(err)
	}
	if got := r.poll.tallies(); got[1] != 1 {
		t.Fatalf("re-vote after reconnect double-counted: %v", got)
	}
}

// The analogue of TestEmptyRefNeverInheritsOp: two ref-less participants must not
// share one vote bucket, or the second silently overwrites the first.
func TestEmptyRefVotersNeverShareABucket(t *testing.T) {
	r, _, _, _, _ := modRoom(t)
	a, _ := joinWithRef(t, r, "p3", "anon-a", "")
	b, _ := joinWithRef(t, r, "p4", "anon-b", "")
	if err := r.CreatePoll("p1", "Ship it?", []string{"Yes", "No"}); err != nil {
		t.Fatal(err)
	}
	id := r.poll.ID
	if err := r.Vote(a.ID, id, 0); err != nil {
		t.Fatal(err)
	}
	if err := r.Vote(b.ID, id, 1); err != nil {
		t.Fatal(err)
	}
	if got := r.poll.tallies(); got[0] != 1 || got[1] != 1 {
		t.Fatalf("tallies = %v, want one vote each", got)
	}
}

// Unlike the countdown, which Leave clears, a poll outlives its creator — that is the
// point of the feature, and this pins the deliberate difference.
func TestPollSurvivesItsCreatorLeaving(t *testing.T) {
	r, _, _, _, _ := modRoom(t)
	if err := r.CreatePoll("p1", "Ship it?", []string{"Yes", "No"}); err != nil {
		t.Fatal(err)
	}
	id := r.poll.ID
	r.Leave("p1")
	if r.poll == nil || !r.poll.Open || r.poll.ID != id {
		t.Fatalf("poll did not survive its creator leaving: %+v", r.poll)
	}
	if err := r.Vote("p2", id, 0); err != nil {
		t.Fatalf("vote after creator left: %v", err)
	}
}

func TestPollSnapshotForNonVoter(t *testing.T) {
	r, _, _, bob, _ := modRoom(t)
	r.mu.Lock()
	none := r.pollSnapshot(bob)
	r.mu.Unlock()
	if none != nil {
		t.Fatalf("snapshot with no poll = %+v, want nil", none)
	}
	if err := r.CreatePoll("p1", "Ship it?", []string{"Yes", "No"}); err != nil {
		t.Fatal(err)
	}
	r.mu.Lock()
	snap := r.pollSnapshot(bob)
	r.mu.Unlock()
	if snap == nil {
		t.Fatal("snapshot missing for an active poll")
	}
	if snap.YourVote != nil {
		t.Errorf("non-voter YourVote = %v, want nil", *snap.YourVote)
	}
	if snap.Question != "Ship it?" || len(snap.Options) != 2 || !snap.Open {
		t.Errorf("snapshot = %+v", snap)
	}
}

func TestCreatePollValidation(t *testing.T) {
	r, _, _, _, _ := modRoom(t)
	cases := []struct {
		name     string
		question string
		options  []string
	}{
		{"empty question", "   ", []string{"Yes", "No"}},
		{"question too long", strings.Repeat("x", MaxPollQuestionRunes+1), []string{"Yes", "No"}},
		{"one option", "Ship it?", []string{"Yes"}},
		{"seven options", "Ship it?", []string{"1", "2", "3", "4", "5", "6", "7"}},
		{"blank option", "Ship it?", []string{"Yes", "  "}},
		{"option too long", "Ship it?", []string{"Yes", strings.Repeat("x", MaxPollOptionRunes+1)}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if err := r.CreatePoll("p1", c.question, c.options); !errors.Is(err, ErrBadPoll) {
				t.Fatalf("err = %v, want ErrBadPoll", err)
			}
			if r.poll != nil {
				t.Fatal("an invalid poll was stored")
			}
		})
	}
}

func TestCreatePollTrimsText(t *testing.T) {
	r, _, _, _, _ := modRoom(t)
	if err := r.CreatePoll("p1", "  Ship it?  ", []string{" Yes ", " No "}); err != nil {
		t.Fatal(err)
	}
	if r.poll.Question != "Ship it?" || r.poll.Options[0] != "Yes" || r.poll.Options[1] != "No" {
		t.Fatalf("stored poll = %+v", r.poll)
	}
}

// A late joiner must receive the active poll in its Joined frame, or it sees nothing
// until the next vote happens to arrive.
func TestJoinedCarriesTheActivePoll(t *testing.T) {
	r, _, _, _, _ := modRoom(t)
	if err := r.CreatePoll("p1", "Ship it?", []string{"Yes", "No"}); err != nil {
		t.Fatal(err)
	}
	_, lc := joinWithRef(t, r, "p3", "late", "ref-late")

	joined, ok := lc.msgs[0].(signal.Joined)
	if !ok {
		t.Fatalf("late joiner msg[0] = %T, want signal.Joined", lc.msgs[0])
	}
	if joined.Poll == nil {
		t.Fatal("Joined carried no poll")
	}
	if joined.Poll.Question != "Ship it?" || !joined.Poll.Open {
		t.Fatalf("Joined poll = %+v", joined.Poll)
	}
	if joined.Poll.YourVote != nil {
		t.Errorf("a fresh joiner should have no vote, got %d", *joined.Poll.YourVote)
	}
}

// And no poll means no field, so nothing changes for a room that never had one.
func TestJoinedOmitsPollWhenThereIsNone(t *testing.T) {
	r, _, _, _, _ := modRoom(t)
	_, lc := joinWithRef(t, r, "p3", "late", "ref-late")
	joined, ok := lc.msgs[0].(signal.Joined)
	if !ok {
		t.Fatalf("msg[0] = %T, want signal.Joined", lc.msgs[0])
	}
	if joined.Poll != nil {
		t.Fatalf("Joined carried a poll in a room with none: %+v", joined.Poll)
	}
}
