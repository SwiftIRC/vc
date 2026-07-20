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
