package sfu

import (
	"encoding/json"

	"github.com/pion/webrtc/v4"

	"github.com/ryanwohara/webrtc-chat/internal/signal"
)

type Peer struct {
	id   string
	slug string
	sfu  *SFU
	sig  Signaler
	pc   *webrtc.PeerConnection
}

func (p *Peer) HandleOffer(sdp string) error {
	if err := p.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: sdp}); err != nil {
		return err
	}
	answer, err := p.pc.CreateAnswer(nil)
	if err != nil {
		return err
	}
	if err := p.pc.SetLocalDescription(answer); err != nil {
		return err
	}
	p.sig.Send(signal.Answer{SDP: answer.SDP})
	return nil
}

func (p *Peer) HandleAnswer(sdp string) error {
	return p.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: sdp})
}

func (p *Peer) HandleCandidate(raw json.RawMessage) error {
	var init webrtc.ICECandidateInit
	if err := json.Unmarshal(raw, &init); err != nil {
		return err
	}
	return p.pc.AddICECandidate(init)
}

// wireOnTrack is filled in by Task 3 (publisher capture + fan-out). Stub now.
func (p *Peer) wireOnTrack() {}

// --- signaling helpers (kept here so sfu.go stays Pion-focused) ---

func candidateJSON(c *webrtc.ICECandidate) (json.RawMessage, error) {
	return json.Marshal(c.ToJSON())
}
func candidateMsg(raw json.RawMessage) signal.Candidate {
	return signal.Candidate{Candidate: raw}
}
