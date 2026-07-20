package sfu

import (
	"log/slog"
	"strings"
	"testing"

	"github.com/ryanwohara/webrtc-chat/internal/config"
)

func testSFU(t *testing.T) *SFU {
	t.Helper()
	e, err := NewEngine(config.Config{UDPPortMin: 0, UDPPortMax: 0}) // 0,0 => any ephemeral port
	if err != nil {
		t.Fatal(err)
	}
	return NewSFU(e, slog.New(slog.NewTextHandler(&strings.Builder{}, nil)))
}

func TestPeerConnectsAfterPublish(t *testing.T) {
	s := testSFU(t)
	c := newTestClient(t, s, "room", "p1")
	c.publish("camera")
	c.waitConnected()
}
