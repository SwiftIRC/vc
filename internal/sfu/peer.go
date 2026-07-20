package sfu

import (
	"encoding/json"
	"sync"

	"github.com/pion/webrtc/v4"

	"github.com/ryanwohara/webrtc-chat/internal/signal"
)

type Peer struct {
	id   string
	slug string
	sfu  *SFU
	sig  Signaler
	pc   *webrtc.PeerConnection

	// mu guards makingOffer and serializes this peer's perfect-negotiation state
	// checks (makingOffer + SignalingState). signalPeerConnections sets makingOffer
	// around its own server-initiated offer; HandleOffer reads it under mu to detect
	// a glaring client offer. A polite in-process client (the test harness) also
	// takes mu to coordinate its own offers with the server's renegotiations.
	mu          sync.Mutex
	makingOffer bool
}

// HandleOffer applies a client-initiated offer (initial publish or a mid-call
// screenshare renegotiation) and answers it. It implements the *impolite* side
// of WebRTC perfect negotiation: if this peer is already making its own offer or
// its signaling state is not stable, the client's offer has glared with a
// concurrent server-initiated renegotiation, so it is IGNORED (return nil without
// touching remote/local descriptions). A polite client rolls its own offer back
// and re-offers once the server's offer settles, so the screenshare track still
// arrives on the retry.
func (p *Peer) HandleOffer(sdp string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.handleOfferLocked(sdp)
}

// handleOfferLocked is HandleOffer's body; the caller must hold p.mu. It is split
// out so an in-process polite client can create its own offer and hand it to the
// server atomically under p.mu (Pion has no SDP rollback, so a polite Pion peer
// must avoid ever creating a colliding local offer rather than roll one back).
func (p *Peer) handleOfferLocked(sdp string) error {
	if p.makingOffer || p.pc.SignalingState() != webrtc.SignalingStateStable {
		return nil // glare: impolite peer ignores the incoming offer
	}
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

// wireOnTrack sets pc.OnTrack so that each published remote track is captured
// into a forwardable local track. The track's kind is taken from remote.ID()
// (mic|camera|screen), defaulting by RTP media type when empty/unknown. RTP is
// copied remote.Read -> local.Write until EOF; on exit the local track is
// removed and the room renegotiated.
func (p *Peer) wireOnTrack() {
	p.pc.OnTrack(func(remote *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		kind := remote.ID()
		if kind != "mic" && kind != "camera" && kind != "screen" {
			if remote.Kind() == webrtc.RTPCodecTypeAudio {
				kind = "mic"
			} else {
				kind = "camera"
			}
		}
		local, err := p.sfu.addLocalTrack(p, kind, remote)
		if err != nil {
			return
		}
		defer p.sfu.removeLocalTrack(p.slug, p.id+":"+kind)

		buf := make([]byte, 1500)
		for {
			n, _, err := remote.Read(buf)
			if err != nil {
				return
			}
			if _, err := local.Write(buf[:n]); err != nil {
				return
			}
		}
	})
}

// --- signaling helpers (kept here so sfu.go stays Pion-focused) ---

func candidateJSON(c *webrtc.ICECandidate) (json.RawMessage, error) {
	return json.Marshal(c.ToJSON())
}
func candidateMsg(raw json.RawMessage) signal.Candidate {
	return signal.Candidate{Candidate: raw}
}
