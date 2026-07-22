package sfu

import (
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"

	"github.com/ryanwohara/webrtc-chat/internal/signal"
)

// keyFrameInterval is the RARE backstop for periodic keyframes. Keyframes are otherwise
// on-demand: new subscribers get a PLI burst (pliBurst), and mid-stream subscribers'
// own keyframe requests are forwarded to the publisher (forwardKeyframeRequests), so a
// publisher's encoder no longer has to emit a full I-frame every few seconds for
// everyone whether needed or not — a big cut in encode/decode CPU and bandwidth. This
// only catches the rare case of a subscriber's PLI itself being lost.
const keyFrameInterval = 10 * time.Second

// renegRetryDelay is how long signalPeerConnections waits before rescheduling
// itself after a renegotiation pass exhausts its in-pass retries without
// converging (a peer stuck in have-local-offer longer than the pass's ~500ms
// budget). Matches the sfu-ws reference pattern's 3s reschedule. A package var
// so tests can shrink it.
var renegRetryDelay = 3 * time.Second

type localTrack struct {
	publisherID string
	kind        string // mic|camera|screen
	track       *webrtc.TrackLocalStaticRTP
	ssrc        webrtc.SSRC // the publisher's remote SSRC, PLI's MediaSSRC
	publisher   *Peer       // the peer that published this track (PLI target)

	// pliMu/lastPLI debounce keyframe requests forwarded from subscribers: many
	// subscribers losing the same frame ask at once, but the publisher only needs one
	// keyframe. Coalesce to at most one PLI per pliDebounceWindow.
	pliMu   sync.Mutex
	lastPLI time.Time
}

type mroom struct {
	peers  map[string]*Peer
	tracks map[string]*localTrack // key = publisherID + ":" + kind

	// reneg is the set of peer IDs whose sender set has changed but whose
	// renegotiation offer has not yet been delivered. It persists ACROSS
	// signalPeerConnections invocations, guarded by SFU.mu: a peer that was
	// reconciled (a sender added/removed) but could not be offered — because its
	// PC was still in have-local-offer — stays in reneg until an offer succeeds.
	// Without this, a later pass would see the sender already present on the PC
	// (changed=false) and never offer it, permanently starving the subscriber.
	reneg map[string]bool

	// ticker fires keyFrameInterval to PLI every video publisher; its goroutine
	// exits when done is closed (in RemovePeer, once the room empties).
	ticker *time.Ticker
	done   chan struct{}
}

type SFU struct {
	engine *Engine
	log    *slog.Logger
	mu     sync.Mutex
	rooms  map[string]*mroom
}

func NewSFU(engine *Engine, log *slog.Logger) *SFU {
	return &SFU{engine: engine, log: log, rooms: map[string]*mroom{}}
}

func (s *SFU) roomLocked(slug string) *mroom {
	r := s.rooms[slug]
	if r == nil {
		r = &mroom{
			peers:  map[string]*Peer{},
			tracks: map[string]*localTrack{},
			reneg:  map[string]bool{},
			ticker: time.NewTicker(keyFrameInterval),
			done:   make(chan struct{}),
		}
		s.rooms[slug] = r
		go s.dispatchKeyFrameLoop(slug, r)
	}
	return r
}

func (s *SFU) AddPeer(slug, peerID string, sig Signaler) (*Peer, error) {
	pc, err := s.engine.NewPeerConnection()
	if err != nil {
		return nil, err
	}
	p := &Peer{id: peerID, slug: slug, sfu: s, sig: sig, pc: pc}

	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		raw, err := candidateJSON(c)
		if err != nil {
			return
		}
		sig.Send(candidateMsg(raw))
	})
	pc.OnConnectionStateChange(func(st webrtc.PeerConnectionState) {
		if st == webrtc.PeerConnectionStateFailed || st == webrtc.PeerConnectionStateClosed {
			s.RemovePeer(slug, peerID)
		}
	})
	p.wireOnTrack() // Task 3 fills this in; a no-op stub in Task 2

	s.mu.Lock()
	s.roomLocked(slug).peers[peerID] = p
	s.mu.Unlock()
	return p, nil
}

// addLocalTrack captures a published remote track into a forwardable local
// track, registers it in the room under "publisherID:kind", and triggers
// renegotiation of the room's other peers. The publishing Peer is passed in so
// the track can remember its origin (its slug, id, remote SSRC, and PC) — the
// SSRC and PC are what a PLI keyframe request is written against.
func (s *SFU) addLocalTrack(pub *Peer, kind string, remote *webrtc.TrackRemote) (*webrtc.TrackLocalStaticRTP, error) {
	local, err := webrtc.NewTrackLocalStaticRTP(remote.Codec().RTPCodecCapability, kind, pub.id)
	if err != nil {
		return nil, err
	}
	key := pub.id + ":" + kind

	s.mu.Lock()
	// Don't resurrect a room the publisher has already been removed from — doing
	// so would start a second keyframe ticker with no peer to ever remove it.
	r := s.rooms[pub.slug]
	if r == nil {
		s.mu.Unlock()
		return nil, fmt.Errorf("room %q no longer present", pub.slug)
	}
	r.tracks[key] = &localTrack{
		publisherID: pub.id,
		kind:        kind,
		track:       local,
		ssrc:        remote.SSRC(),
		publisher:   pub,
	}
	s.mu.Unlock()

	s.signalPeerConnections(pub.slug)
	return local, nil
}

// removeLocalTrack drops a published local track from the room and triggers
// renegotiation of the room's other peers.
func (s *SFU) removeLocalTrack(slug, key string) {
	s.mu.Lock()
	if r := s.rooms[slug]; r != nil {
		delete(r.tracks, key)
	}
	s.mu.Unlock()
	s.signalPeerConnections(slug)
}

// signalPeerConnections reconciles every peer's outbound senders with the
// room's published track set and renegotiates any peer whose sender set changed
// with a server-initiated offer. Adapted from pion/example sfu-ws.
//
// Sender mutation (Add/RemoveTrack) happens under s.mu to keep each peer's view
// of the track set consistent; offer creation and delivery happen after the
// lock is released — s.mu is never held across CreateOffer or sig.Send. If a
// CreateOffer/SetLocalDescription fails because a renegotiation is still in
// flight (signaling state not stable), the whole pass is retried up to
// maxSignalAttempts times with a short backoff, matching sfu-ws's resilience.
func (s *SFU) signalPeerConnections(slug string) {
	const (
		maxSignalAttempts = 25
		signalBackoff     = 20 * time.Millisecond
	)

	for attempt := 0; attempt < maxSignalAttempts; attempt++ {
		s.mu.Lock()
		r := s.rooms[slug]
		if r == nil {
			s.mu.Unlock()
			return
		}
		// Drop reneg entries for peers that have left the room.
		for id := range r.reneg {
			if _, ok := r.peers[id]; !ok {
				delete(r.reneg, id)
			}
		}
		// Reconcile every peer's senders; mark changed peers into the room's
		// persistent reneg set and collect the video tracks freshly forwarded to a
		// new subscriber so their publishers can be PLI'd (outside s.mu) once the
		// offers are sent. reneg persists across invocations, so a peer whose
		// senders were reconciled but could not be offered (its PC was still in
		// have-local-offer) stays pending here even after a later sync pass finds
		// those senders already present (changed=false) — that is exactly the
		// starvation this recovers from.
		var newVideo []*localTrack
		for id, p := range r.peers {
			changed, added := syncPeerSendersLocked(p, r.tracks)
			if changed {
				r.reneg[id] = true
			}
			newVideo = append(newVideo, added...)
		}
		// Snapshot the peers still awaiting an offer so renegotiation runs without
		// holding s.mu. The drop above guarantees every reneg id is a live peer.
		todo := make([]*Peer, 0, len(r.reneg))
		for id := range r.reneg {
			todo = append(todo, r.peers[id])
		}
		s.mu.Unlock()

		if len(todo) == 0 {
			return
		}

		retry := false
		for _, p := range todo {
			// Perfect negotiation (server = impolite): mark makingOffer while this
			// server-initiated offer is created and applied, so a client offer that
			// glares with it (HandleOffer) is detected and ignored. p.mu is held
			// across CreateOffer/SetLocalDescription so HandleOffer sees a consistent
			// makingOffer + SignalingState view; it is released before sig.Send (never
			// hold a peer lock across signaling delivery) so an in-process polite
			// client's own coordination can acquire p.mu while the offer is delivered.
			p.mu.Lock()
			p.makingOffer = true
			offer, err := p.pc.CreateOffer(nil)
			if err != nil {
				// A renegotiation is mid-flight (signaling state not stable); leave p
				// in reneg and retry the whole pass shortly.
				p.makingOffer = false
				p.mu.Unlock()
				retry = true
				continue
			}
			if err := p.pc.SetLocalDescription(offer); err != nil {
				p.makingOffer = false
				p.mu.Unlock()
				retry = true
				continue
			}
			p.makingOffer = false
			p.mu.Unlock()
			if !p.sig.Send(signal.Offer{SDP: stripDemuxExtensions(offer.SDP)}) {
				s.log.Debug("media offer dropped (send overflow/closing)", "peer", p.id)
			}
			// After SetLocalDescription the transceiver mids are assigned, so p can
			// be told which mid carries which {participantID, kind} it now receives.
			p.sig.Send(signal.Tracks{Tracks: peerTrackInfos(p)})
			// Offer delivered: p no longer needs renegotiation.
			s.mu.Lock()
			delete(r.reneg, p.id)
			s.mu.Unlock()
		}
		// Ask each newly-subscribed video's publisher for a keyframe so the new
		// subscriber can start decoding without waiting for the room ticker.
		for _, lt := range newVideo {
			s.pliBurst(lt)
		}
		if !retry {
			return
		}
		time.Sleep(signalBackoff)
	}

	// The in-pass retries were exhausted while a peer was still un-offerable
	// (e.g. stuck in have-local-offer beyond the ~500ms budget). Unlike a fresh
	// pass — which would find the peer's senders already reconciled
	// (changed=false) and never offer — reschedule the whole reconcile after a
	// delay, matching the sfu-ws reference pattern, so the peer is retried once
	// its earlier offer has had time to be answered. A reschedule that lands
	// after the room is torn down is a safe no-op: signalPeerConnections looks
	// the room up under s.mu and returns early when it is gone.
	s.log.Warn("renegotiation did not converge; rescheduling", "slug", slug)
	go func() {
		time.Sleep(renegRetryDelay)
		s.signalPeerConnections(slug)
	}()
}

// syncPeerSendersLocked reconciles peer p's outbound RTP senders with the room's
// published track set: it removes senders whose track is gone and adds tracks
// published by other peers that p is not yet sending (never looping a peer's own
// track back to it). It reports whether p's sender set changed and returns the
// video tracks newly added to p (whose publishers should be PLI'd). Caller holds
// s.mu.
//
// New forwards are APPENDED as fresh sendonly transceivers, never AddTrack. AddTrack
// reuses a recycled (inactive) transceiver left behind by an earlier RemoveTrack, and
// that reuse can produce an offer whose m-line order no longer matches the client's
// last answer — Chrome then rejects it with "The order of m-lines ... doesn't match
// ...", never answers, and the peer's PC wedges in have-local-offer, which is the
// "renegotiation did not converge" reschedule loop. RemoveTrack still marks a departed
// forward's m-line inactive IN PLACE, so the m-line list only ever grows or goes
// inactive at a fixed index — every offer stays a prefix of the client's last answer
// plus appended m-lines, which Chrome always accepts. (Recycled slots are not reused,
// so a very churny call accumulates inactive m-lines; that is the accepted cost of
// guaranteed order-stability, and is bounded by how many distinct tracks p ever saw.)
func syncPeerSendersLocked(p *Peer, tracks map[string]*localTrack) (changed bool, addedVideo []*localTrack) {
	existing := map[string]bool{}

	for _, snd := range p.pc.GetSenders() {
		key, ok := senderKey(snd)
		if !ok {
			continue
		}
		existing[key] = true
		if _, live := tracks[key]; !live {
			if err := p.pc.RemoveTrack(snd); err == nil {
				changed = true
			}
		}
	}

	for key, lt := range tracks {
		if lt.publisherID == p.id || existing[key] {
			continue
		}
		if tr, err := p.pc.AddTransceiverFromTrack(lt.track, webrtc.RTPTransceiverInit{
			Direction: webrtc.RTPTransceiverDirectionSendonly,
		}); err == nil {
			changed = true
			if lt.kind != "mic" {
				addedVideo = append(addedVideo, lt)
			}
			// Forward this subscriber's keyframe requests to the publisher (video only).
			if lt.kind == "camera" || lt.kind == "screen" {
				go p.sfu.forwardKeyframeRequests(tr.Sender(), lt)
			}
		}
	}
	return changed, addedVideo
}

// peerTrackInfos describes the forwarded tracks peer p now receives: one
// TrackInfo per transceiver whose sender carries another peer's track, mapping
// the transceiver's mid to the source {participantID, kind} (StreamID/ID of the
// forwarded local track). It reads only p.pc state — transceivers, senders, and
// track IDs — which does not require s.mu, and must be called after
// SetLocalDescription so the mids are assigned. The SFU never adds a peer's own
// track back to it, so every sender-carrying transceiver here forwards another
// peer's track.
func peerTrackInfos(p *Peer) []signal.TrackInfo {
	var infos []signal.TrackInfo
	for _, tr := range p.pc.GetTransceivers() {
		snd := tr.Sender()
		if snd == nil {
			continue
		}
		t := snd.Track()
		if t == nil {
			continue
		}
		infos = append(infos, signal.TrackInfo{
			Mid:           tr.Mid(),
			ParticipantID: t.StreamID(),
			Kind:          t.ID(),
		})
	}
	return infos
}

// senderKey derives a sender's track key ("streamID:trackID", i.e.
// "publisherID:kind"), matching the room's track-map keys. Returns false for a
// sender with no track.
func senderKey(snd *webrtc.RTPSender) (string, bool) {
	t := snd.Track()
	if t == nil {
		return "", false
	}
	return t.StreamID() + ":" + t.ID(), true
}

// stripDemuxExtensions removes the header extensions that make Chrome set up
// per-m-line demux criteria the SFU can't satisfy: the RTP-stream-id extensions
// (sdes:rtp-stream-id, sdes:repaired-rtp-stream-id) AND the MID extension
// (sdes:mid). Pion advertises all three on every VIDEO m-line, but this SFU never
// sends simulcast and forwards each track under its own SSRC. With two videos in one
// PeerConnection (e.g. your camera plus a peer's, or a peer's camera plus their
// screen), Chrome tries to demux the m-lines by RID or MID and the second video's
// criteria collide with the first — its setLocalDescription(answer) fails with
// "Failed to apply demuxer criteria for 'N'". Dropping these extensions makes Chrome
// demux every m-line by SSRC, exactly as it already does for the audio m-lines (which
// Pion never decorates with any of them) — which is why audio kept working while a
// second video broke. The MID extension in particular had to go: stripping only the
// RID pair still left sdes:mid, so Chrome kept attempting MID-based demux and still
// collided. Applied only to the server's offers — the one place the SFU emits these —
// so a client answers without them and never arms the bad demux. Pion still demuxes
// each client's uploads by the SSRCs their answer declares, the same way it already
// does for audio.
func stripDemuxExtensions(sdp string) string {
	lines := strings.Split(sdp, "\n")
	kept := lines[:0]
	for _, line := range lines {
		// sdes:mid matches only the MID *header extension* line
		// (urn:...:sdes:mid); it never matches an "a=mid:N" attribute line, which is
		// essential and must survive.
		if strings.Contains(line, "sdes:rtp-stream-id") || strings.Contains(line, "sdes:repaired-rtp-stream-id") || strings.Contains(line, "sdes:mid") {
			continue
		}
		kept = append(kept, line)
	}
	return strings.Join(kept, "\n")
}

// pli asks a video track's publisher for a keyframe by writing an RTCP Picture
// Loss Indication to the publisher's PeerConnection for the track's SSRC. Audio
// (mic) tracks have no keyframes, so they are skipped. Called without s.mu.
func (s *SFU) pli(lt *localTrack) {
	if lt == nil || lt.kind == "mic" || lt.publisher == nil {
		return
	}
	_ = lt.publisher.pc.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: uint32(lt.ssrc)}})
}

// pliDebounceWindow coalesces a burst of subscriber keyframe requests into one PLI.
const pliDebounceWindow = 500 * time.Millisecond

// pliDebounced forwards a subscriber's keyframe request to the publisher, but at most
// once per pliDebounceWindow across all subscribers of that track.
func (s *SFU) pliDebounced(lt *localTrack) {
	if lt == nil {
		return
	}
	lt.pliMu.Lock()
	now := time.Now()
	if !lt.lastPLI.IsZero() && now.Sub(lt.lastPLI) < pliDebounceWindow {
		lt.pliMu.Unlock()
		return
	}
	lt.lastPLI = now
	lt.pliMu.Unlock()
	s.pli(lt)
}

// forwardKeyframeRequests drains RTCP a subscriber sends back on a forwarded VIDEO
// track and, on a keyframe request (PLI/FIR), asks the publisher for one — so keyframes
// flow on demand instead of on a fixed timer. Returns when the sender is closed/removed
// (sender.Read errors), which happens when the subscriber leaves or unsubscribes.
func (s *SFU) forwardKeyframeRequests(sender *webrtc.RTPSender, lt *localTrack) {
	if sender == nil {
		return
	}
	buf := make([]byte, 1500)
	for {
		n, _, err := sender.Read(buf)
		if err != nil {
			return
		}
		pkts, err := rtcp.Unmarshal(buf[:n])
		if err != nil {
			continue
		}
		for _, pkt := range pkts {
			switch pkt.(type) {
			case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
				s.pliDebounced(lt)
			}
		}
	}
}

// pliBurstDelays schedules extra keyframe requests shortly after a new subscription; see pliBurst.
var pliBurstDelays = []time.Duration{250 * time.Millisecond, 750 * time.Millisecond}

// pliBurst asks a freshly-subscribed video's publisher for a keyframe immediately, then
// again a couple of times over the next ~second. A lone PLI at subscribe time races the
// new subscriber's receiver coming up — its offer is still being answered — so the
// keyframe that PLI triggers can arrive before the subscriber can decode it, leaving the
// tile black until the next periodic keyframe (up to keyFrameInterval later). The short
// burst makes at least one keyframe land after the receiver is ready. The retries are
// safe on a since-departed publisher: pli no-ops once its PeerConnection is closed.
func (s *SFU) pliBurst(lt *localTrack) {
	s.pli(lt)
	for _, d := range pliBurstDelays {
		time.AfterFunc(d, func() { s.pli(lt) })
	}
}

// pliPeerSubscriptions bursts a keyframe request to every video track peer p
// RECEIVES (every room camera/screen not published by p). A client only re-offers to
// add or remove a screenshare, and Chrome pauses p's OTHER inbound video decoders
// across that offer/answer — without a fresh keyframe they stay frozen until the next
// periodic keyframe (up to keyFrameInterval, ~3s). Bursting a PLI to each subscribed
// publisher recovers those tiles immediately. Mic/screen-audio have no keyframes and
// are skipped; a peer never receives its own tracks. Called without s.mu.
func (s *SFU) pliPeerSubscriptions(p *Peer) {
	for _, lt := range s.peerVideoSubscriptions(p) {
		s.pliBurst(lt)
	}
}

// peerVideoSubscriptions returns the room's camera/screen tracks peer p receives
// (published by others). Split out from pliPeerSubscriptions so the selection —
// exclude p's own tracks, keep only keyframe-bearing video — is unit-testable without
// RTCP. Returns nil if the room is gone. Takes s.mu.
func (s *SFU) peerVideoSubscriptions(p *Peer) []*localTrack {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.rooms[p.slug]
	if r == nil {
		return nil
	}
	var subs []*localTrack
	for _, lt := range r.tracks {
		if lt.publisherID != p.id && (lt.kind == "camera" || lt.kind == "screen") {
			subs = append(subs, lt)
		}
	}
	return subs
}

// dispatchKeyFrame PLIs every video publisher in the room, so subscribers that
// joined mid-stream keep getting keyframes. Tracks are snapshotted under s.mu
// and the RTCP writes happen after the lock is released.
func (s *SFU) dispatchKeyFrame(slug string) {
	s.mu.Lock()
	r := s.rooms[slug]
	if r == nil {
		s.mu.Unlock()
		return
	}
	tracks := make([]*localTrack, 0, len(r.tracks))
	for _, lt := range r.tracks {
		tracks = append(tracks, lt)
	}
	s.mu.Unlock()

	for _, lt := range tracks {
		s.pli(lt)
	}
}

// dispatchKeyFrameLoop drives a room's periodic keyframe requests until the room
// is removed. It owns no lock: it reads only r.ticker/r.done (set once at room
// creation) and delegates to dispatchKeyFrame. Closing r.done (in RemovePeer)
// makes it return, so it never outlives its room.
func (s *SFU) dispatchKeyFrameLoop(slug string, r *mroom) {
	for {
		select {
		case <-r.done:
			return
		case <-r.ticker.C:
			s.dispatchKeyFrame(slug)
		}
	}
}

func (s *SFU) RemovePeer(slug, peerID string) {
	s.mu.Lock()
	r := s.rooms[slug]
	if r == nil {
		s.mu.Unlock()
		return
	}
	p := r.peers[peerID]
	delete(r.peers, peerID)
	// Drop every track this peer published so remaining subscribers stop
	// forwarding it. The publisher's OnTrack read loop also deletes these (via
	// removeLocalTrack) when its PC closes, so deleting a key here that is already
	// gone — or gone later — is a safe no-op; whichever runs first wins.
	for key, lt := range r.tracks {
		if lt.publisherID == peerID {
			delete(r.tracks, key)
		}
	}
	empty := len(r.peers) == 0
	if empty {
		delete(s.rooms, slug)
		// Stop the keyframe ticker and signal its goroutine to exit.
		r.ticker.Stop()
		close(r.done)
	}
	s.mu.Unlock()

	// Renegotiate the survivors so each drops the departed peer's sender. Done
	// after releasing s.mu (signalPeerConnections locks internally and runs
	// CreateOffer/Send lock-free) and only while peers remain — if the room was
	// deleted, there is nobody left to signal. A concurrent read-loop pass is
	// idempotent, so both running is harmless.
	if !empty {
		s.signalPeerConnections(slug)
	}
	// Close the departed peer's PC after releasing s.mu so its read-loop's own
	// removeLocalTrack can acquire s.mu without deadlocking.
	if p != nil {
		p.pc.Close()
	}
}
