package room

import (
	"errors"
	"testing"

	"github.com/SwiftIRC/coyote/internal/signal"
)

// lastCountdown returns the most recent CountdownEvent a fakeConn received.
func lastCountdown(c *fakeConn) (signal.CountdownEvent, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for i := len(c.msgs) - 1; i >= 0; i-- {
		if m, ok := c.msgs[i].(signal.CountdownEvent); ok {
			return m, true
		}
	}
	return signal.CountdownEvent{}, false
}

// TestCountdownStartBroadcastsToAll: a start reaches every participant,
// including the starter, carrying the starter's display name.
func TestCountdownStartBroadcastsToAll(t *testing.T) {
	r, _, ac, _, bc := modRoom(t) // alice=p1, bob=p2
	if err := r.Countdown("p1", "start"); err != nil {
		t.Fatal(err)
	}
	for who, c := range map[string]*fakeConn{"alice": ac, "bob": bc} {
		ev, ok := lastCountdown(c)
		if !ok || ev.Action != "start" || ev.By != "alice" {
			t.Errorf("%s got %+v ok=%v, want {start alice}", who, ev, ok)
		}
	}
}

// TestCountdownRefusesSecondStart: while one is active, another participant's
// start is refused server-side (the client lock is only advisory).
func TestCountdownRefusesSecondStart(t *testing.T) {
	r, _, _, _, _ := modRoom(t)
	if err := r.Countdown("p1", "start"); err != nil {
		t.Fatal(err)
	}
	if err := r.Countdown("p2", "start"); !errors.Is(err, ErrCountdownActive) {
		t.Errorf("second start = %v, want ErrCountdownActive", err)
	}
}

// TestCountdownNonStarterCannotStop: only the starter may stop it.
func TestCountdownNonStarterCannotStop(t *testing.T) {
	r, _, _, _, _ := modRoom(t)
	if err := r.Countdown("p1", "start"); err != nil {
		t.Fatal(err)
	}
	if err := r.Countdown("p2", "stop"); !errors.Is(err, ErrCountdownNotOwner) {
		t.Errorf("non-starter stop = %v, want ErrCountdownNotOwner", err)
	}
}

// TestCountdownStarterStopClearsAndBroadcasts: the starter's stop clears the
// state (so anyone may start again) and broadcasts a stop to everyone.
func TestCountdownStarterStopClearsAndBroadcasts(t *testing.T) {
	r, _, ac, _, bc := modRoom(t)
	if err := r.Countdown("p1", "start"); err != nil {
		t.Fatal(err)
	}
	if err := r.Countdown("p1", "stop"); err != nil {
		t.Fatal(err)
	}
	for who, c := range map[string]*fakeConn{"alice": ac, "bob": bc} {
		ev, ok := lastCountdown(c)
		if !ok || ev.Action != "stop" {
			t.Errorf("%s last countdown = %+v ok=%v, want stop", who, ev, ok)
		}
	}
	// State cleared: a fresh start by a different participant is accepted.
	if err := r.Countdown("p2", "start"); err != nil {
		t.Errorf("start after stop = %v, want nil", err)
	}
}

// TestCountdownOwnerLeaveClears: if the starter leaves mid-countdown, the room
// clears the state and broadcasts a stop so the control unlocks for everyone.
func TestCountdownOwnerLeaveClears(t *testing.T) {
	r, _, _, _, bc := modRoom(t)
	if err := r.Countdown("p1", "start"); err != nil {
		t.Fatal(err)
	}
	r.Leave("p1")
	ev, ok := lastCountdown(bc)
	if !ok || ev.Action != "stop" {
		t.Errorf("bob last countdown after owner leave = %+v ok=%v, want stop", ev, ok)
	}
	// Cleared: bob can start now.
	if err := r.Countdown("p2", "start"); err != nil {
		t.Errorf("start after owner leave = %v, want nil", err)
	}
}

// TestCountdownStopWhenInactiveAndBadInputs: stopping with nothing running,
// an unknown actor, and a bad action are each refused without a broadcast.
func TestCountdownStopWhenInactiveAndBadInputs(t *testing.T) {
	r, _, _, _, bc := modRoom(t)
	if err := r.Countdown("p1", "stop"); !errors.Is(err, ErrCountdownInactive) {
		t.Errorf("stop when idle = %v, want ErrCountdownInactive", err)
	}
	if err := r.Countdown("ghost", "start"); !errors.Is(err, ErrNoSuchPeer) {
		t.Errorf("unknown actor = %v, want ErrNoSuchPeer", err)
	}
	if err := r.Countdown("p1", "sideways"); !errors.Is(err, ErrBadCountdown) {
		t.Errorf("bad action = %v, want ErrBadCountdown", err)
	}
	if _, ok := lastCountdown(bc); ok {
		t.Error("a refused countdown must not broadcast")
	}
}
