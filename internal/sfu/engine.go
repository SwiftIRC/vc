// Package sfu is the selective-forwarding media plane: one PeerConnection per
// participant, forwarding each published RTP track to every other participant
// in the room. It reaches clients only through a Signaler; it never imports
// internal/room.
package sfu

import (
	"fmt"

	"github.com/pion/interceptor"
	"github.com/pion/webrtc/v4"

	"github.com/ryanwohara/webrtc-chat/internal/config"
)

// Engine holds the shared, immutable WebRTC API used to build every peer's
// PeerConnection with the project's codecs, interceptors, and ICE settings.
type Engine struct {
	api *webrtc.API
}

func NewEngine(cfg config.Config) (*Engine, error) {
	m := &webrtc.MediaEngine{}
	if err := m.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000},
		PayloadType:        96,
	}, webrtc.RTPCodecTypeVideo); err != nil {
		return nil, fmt.Errorf("register vp8: %w", err)
	}
	if err := m.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2},
		PayloadType:        111,
	}, webrtc.RTPCodecTypeAudio); err != nil {
		return nil, fmt.Errorf("register opus: %w", err)
	}

	i := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(m, i); err != nil {
		return nil, fmt.Errorf("interceptors: %w", err)
	}

	s := webrtc.SettingEngine{}
	if cfg.UDPPortMin > cfg.UDPPortMax {
		return nil, fmt.Errorf("udp range %d>%d", cfg.UDPPortMin, cfg.UDPPortMax)
	}
	if err := s.SetEphemeralUDPPortRange(uint16(cfg.UDPPortMin), uint16(cfg.UDPPortMax)); err != nil {
		return nil, fmt.Errorf("udp port range: %w", err)
	}
	if cfg.PublicIP != "" {
		s.SetNAT1To1IPs([]string{cfg.PublicIP}, webrtc.ICECandidateTypeHost)
	}

	api := webrtc.NewAPI(
		webrtc.WithMediaEngine(m),
		webrtc.WithInterceptorRegistry(i),
		webrtc.WithSettingEngine(s),
	)
	return &Engine{api: api}, nil
}

// NewPeerConnection builds one PeerConnection. No ICE servers: the SFU is
// reachable at its public address, so host candidates suffice.
func (e *Engine) NewPeerConnection() (*webrtc.PeerConnection, error) {
	return e.api.NewPeerConnection(webrtc.Configuration{})
}
