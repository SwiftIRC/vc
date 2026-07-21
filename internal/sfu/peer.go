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

	// kinds maps each published track's MSID stream id -> kind (mic|camera|screen),
	// as declared by the client alongside its offer (signal.Offer.Kinds). A browser
	// cannot set an arbitrary MSID stream id — MediaStream.id is read-only and
	// random — so the kind is conveyed here rather than read from remote.StreamID()
	// directly (which cannot tell a screen track from a camera track: both VP8).
	// Guarded by kindsMu: wireOnTrack's OnTrack callback (a Pion goroutine) reads it
	// while HandleOffer (the signaling goroutine) writes it.
	kindsMu sync.Mutex
	kinds   map[string]string
}

// HandleOffer applies a client-initiated offer (initial publish or a mid-call
// screenshare renegotiation) and answers it. It implements the *impolite* side
// of WebRTC perfect negotiation: if this peer is already making its own offer or
// its signaling state is not stable, the client's offer has glared with a
// concurrent server-initiated renegotiation, so it is IGNORED (return nil without
// touching remote/local descriptions). A polite client rolls its own offer back
// and re-offers once the server's offer settles, so the screenshare track still
// arrives on the retry.
func (p *Peer) HandleOffer(sdp string, kinds map[string]string) error {
	p.recordKinds(kinds)
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.handleOfferLocked(sdp)
}

// recordKinds merges the client-declared {MSID stream id -> kind} map from an
// offer into the peer's set. Merged, never replaced: a later renegotiation (e.g.
// an ICE restart, or removing one track) may resend a subset, and forgetting an
// already-published track's kind would drop it back to the media-type fallback.
func (p *Peer) recordKinds(kinds map[string]string) {
	if len(kinds) == 0 {
		return
	}
	p.kindsMu.Lock()
	defer p.kindsMu.Unlock()
	if p.kinds == nil {
		p.kinds = make(map[string]string, len(kinds))
	}
	for streamID, kind := range kinds {
		p.kinds[streamID] = kind
	}
}

// kindForStream returns the client-declared kind for a published track's MSID
// stream id, and whether one was declared.
func (p *Peer) kindForStream(streamID string) (string, bool) {
	p.kindsMu.Lock()
	defer p.kindsMu.Unlock()
	k, ok := p.kinds[streamID]
	return k, ok
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
	// A client re-offers only to add/remove a screenshare; that renegotiation stalls
	// the client's OTHER inbound video decoders until a keyframe, so refresh them now
	// instead of leaving those tiles frozen until the periodic keyframe. On a goroutine:
	// pliPeerSubscriptions takes s.mu and writes RTCP, neither of which should run while
	// the caller holds p.mu.
	go p.sfu.pliPeerSubscriptions(p)
	return nil
}

func (p *Peer) HandleAnswer(sdp string) error {
	if err := p.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: sdp}); err != nil {
		return err
	}
	// This peer just returned to stable, so reconcile in case senders were added
	// while it was in have-local-offer and could not be offered then (they persist
	// in the room's reneg set). Run it on a goroutine, not inline: signaling
	// delivery is asynchronous in production (offers are enqueued to a write pump),
	// but the in-process test harness delivers a server offer by a direct call
	// chain (sig.Send -> client answers -> HandleAnswer) while holding this peer's
	// lock, so an inline reconcile would re-enter signalPeerConnections and
	// self-deadlock on p.mu. A goroutine matches the real async delivery and is
	// harmless either way. It is idempotent: a reconcile with nothing pending in
	// reneg sends no offer, so it converges and cannot loop.
	go p.sfu.signalPeerConnections(p.slug)
	return nil
}

func (p *Peer) HandleCandidate(raw json.RawMessage) error {
	var init webrtc.ICECandidateInit
	if err := json.Unmarshal(raw, &init); err != nil {
		return err
	}
	return p.pc.AddICECandidate(init)
}

// wireOnTrack sets pc.OnTrack so that each published remote track is captured
// into a forwardable local track. The track's kind (mic|camera|screen) comes from
// the client's out-of-band declaration (recordKinds), keyed by the track's MSID
// stream id (remote.StreamID()) — a browser cannot set that stream id to the kind
// itself, so it sends a {stream id -> kind} map with each offer. When nothing was
// declared for the stream id, it defaults by RTP media type, which distinguishes
// mic from video but NOT camera from screen. RTP is copied remote.Read ->
// local.Write until EOF; on exit the local track is removed and the room
// renegotiated.
// isKnownKind reports whether a client-declared track kind is one the SFU forwards
// as-is; anything else falls back to the RTP media type (mic|camera).
func isKnownKind(k string) bool {
	switch k {
	case "mic", "camera", "screen", "screen-audio":
		return true
	}
	return false
}

func (p *Peer) wireOnTrack() {
	p.pc.OnTrack(func(remote *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		kind, ok := p.kindForStream(remote.StreamID())
		if !ok || !isKnownKind(kind) {
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
