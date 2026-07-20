package sfu

import (
	"testing"

	"github.com/pion/webrtc/v4"

	"github.com/ryanwohara/webrtc-chat/internal/config"
)

func TestNewEngineBuildsPeerConnections(t *testing.T) {
	e, err := NewEngine(config.Config{UDPPortMin: 50000, UDPPortMax: 50050})
	if err != nil {
		t.Fatal(err)
	}
	pc, err := e.NewPeerConnection()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pc.Close() })
	if pc.ConnectionState() != webrtc.PeerConnectionStateNew {
		t.Errorf("new PC state = %v, want new", pc.ConnectionState())
	}
}

func TestEngineRejectsInvalidPortRange(t *testing.T) {
	// min > max must surface as an error from the setting engine.
	if _, err := NewEngine(config.Config{UDPPortMin: 60000, UDPPortMax: 50000}); err == nil {
		t.Fatal("want error for inverted UDP range")
	}
}
