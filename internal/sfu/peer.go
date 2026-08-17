package sfu

import (
	"encoding/json"
	"sync"

	"github.com/pion/webrtc/v4"

	"github.com/SwiftIRC/coyote/internal/signal"
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

	// receiveVideo is this subscriber's inbound-video gate (default true). When a
	// client enables "low bandwidth" mode it sends set-receive-video{enabled:false};
	// SetReceiveVideo then drops every sender forwarding another peer's camera or
	// screen to this peer, and syncPeerSendersLocked stops adding new ones, so no
	// video RTP is downloaded here while audio (mic, screen-audio) still flows. It
	// gates only THIS peer's downlink — the peer's own published tracks are
	// unaffected and other subscribers are untouched. Guarded by sfu.mu (read in
	// syncPeerSendersLocked, written by SetReceiveVideo).
	receiveVideo bool

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
	// Re-send the label map now the negotiation has COMPLETED. Until this point the
	// map was only ever sent alongside an offer, computed while the client had not
	// yet answered — so any forward that was un-negotiated at that moment (see
	// peerTrackInfos) went unlabelled, and nothing corrected it until the NEXT
	// renegotiation. In a call that has settled there is no next one: the client
	// holds media for a mid it was never told how to render, and that participant's
	// tile stays black for the rest of the call.
	//
	// Here every mid is final and both sides agree on them, so this is the first
	// moment the map can be stated with certainty. It is idempotent — the client
	// rebuilds its mid->{participant,kind} map from each one and emits any pairing
	// this completes — so re-sending costs a small frame and closes the window.
	p.sig.Send(signal.Tracks{Tracks: peerTrackInfos(p)})
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

// SetReceiveVideo gates this subscriber's INBOUND video — the per-user "low
// bandwidth" switch. When enabled is false, every sender forwarding another
// peer's camera or screen to this peer is dropped with RemoveTrack (which marks
// the m-line inactive IN PLACE — the order-stable path syncPeerSendersLocked
// depends on, never a reused/reordered m-line), so no video RTP is sent to this
// peer; audio (mic, screen-audio) keeps flowing and the peer's own published
// tracks are untouched. When re-enabled, the reconcile re-appends the room's
// video tracks as fresh sendonly transceivers and bursts a keyframe to each so
// tiles repaint at once. Idempotent, and it changes only THIS peer's downlink —
// other subscribers are unaffected.
func (p *Peer) SetReceiveVideo(enabled bool) {
	s := p.sfu
	s.mu.Lock()
	r := s.rooms[p.slug]
	if r == nil {
		s.mu.Unlock()
		return
	}
	if p.receiveVideo == enabled {
		s.mu.Unlock()
		return // no change
	}
	p.receiveVideo = enabled
	if !enabled {
		// Drop the video currently forwarded to this peer. Audio senders (mic,
		// screen-audio) are left in place. senderKey is read while the track is still
		// bound, so it resolves before RemoveTrack clears it.
		for _, snd := range p.pc.GetSenders() {
			key, ok := senderKey(snd)
			if !ok {
				continue
			}
			lt := r.tracks[key]
			if lt == nil || (lt.kind != "camera" && lt.kind != "screen") {
				continue
			}
			_ = p.pc.RemoveTrack(snd)
		}
	}
	// Renegotiate this peer either way: on disable the offer carries the now-inactive
	// video m-lines; on enable syncPeerSendersLocked re-appends the room's video (and
	// reports it so signalPeerConnections PLIs each resumed publisher). Marking reneg
	// here guarantees the offer is sent even on disable, where syncPeerSendersLocked
	// itself reports no change (the removal happened above, outside it).
	r.reneg[p.id] = true
	s.mu.Unlock()

	s.signalPeerConnections(p.slug)
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
