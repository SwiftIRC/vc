package sfu

import (
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"

	"github.com/ryanwohara/webrtc-chat/internal/signal"
)

// keyFrameInterval is how often each room asks its video publishers for a
// keyframe (PLI), so subscribers that joined mid-stream can start decoding.
const keyFrameInterval = 3 * time.Second

type localTrack struct {
	publisherID string
	kind        string // mic|camera|screen
	track       *webrtc.TrackLocalStaticRTP
	ssrc        webrtc.SSRC // the publisher's remote SSRC, PLI's MediaSSRC
	publisher   *Peer       // the peer that published this track (PLI target)
}

type mroom struct {
	peers  map[string]*Peer
	tracks map[string]*localTrack // key = publisherID + ":" + kind

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

	// pending accumulates peers awaiting a successful renegotiation offer across
	// retry attempts: a peer stays pending until its offer is sent (or it leaves
	// the room), so a CreateOffer that failed mid-flight is retried even though a
	// later sync pass finds its senders already reconciled.
	pending := map[string]*Peer{}

	for attempt := 0; attempt < maxSignalAttempts; attempt++ {
		s.mu.Lock()
		r := s.rooms[slug]
		if r == nil {
			s.mu.Unlock()
			return
		}
		// Drop pending peers that have left the room.
		for id := range pending {
			if _, ok := r.peers[id]; !ok {
				delete(pending, id)
			}
		}
		// Reconcile every peer's senders; mark changed peers for renegotiation and
		// collect the video tracks freshly forwarded to a new subscriber so their
		// publishers can be PLI'd (outside s.mu) once the offers are sent.
		var newVideo []*localTrack
		for id, p := range r.peers {
			changed, added := syncPeerSendersLocked(p, r.tracks)
			if changed {
				pending[id] = p
			}
			newVideo = append(newVideo, added...)
		}
		// Snapshot pending peers so renegotiation runs without holding s.mu.
		todo := make([]*Peer, 0, len(pending))
		for _, p := range pending {
			todo = append(todo, p)
		}
		s.mu.Unlock()

		if len(todo) == 0 {
			return
		}

		retry := false
		for _, p := range todo {
			offer, err := p.pc.CreateOffer(nil)
			if err != nil {
				// A renegotiation is mid-flight (signaling state not stable);
				// keep p pending and retry the whole pass shortly.
				retry = true
				continue
			}
			if err := p.pc.SetLocalDescription(offer); err != nil {
				retry = true
				continue
			}
			p.sig.Send(signal.Offer{SDP: offer.SDP})
			// After SetLocalDescription the transceiver mids are assigned, so p can
			// be told which mid carries which {participantID, kind} it now receives.
			p.sig.Send(signal.Tracks{Tracks: peerTrackInfos(p)})
			delete(pending, p.id)
		}
		// Ask each newly-subscribed video's publisher for a keyframe so the new
		// subscriber can start decoding without waiting for the room ticker.
		for _, lt := range newVideo {
			s.pli(lt)
		}
		if !retry {
			return
		}
		time.Sleep(signalBackoff)
	}
}

// syncPeerSendersLocked reconciles peer p's outbound RTP senders with the room's
// published track set: it removes senders whose track is gone and adds tracks
// published by other peers that p is not yet sending (never looping a peer's own
// track back to it). It reports whether p's sender set changed and returns the
// video tracks newly added to p (whose publishers should be PLI'd). Caller holds
// s.mu.
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
		if _, err := p.pc.AddTrack(lt.track); err == nil {
			changed = true
			if lt.kind != "mic" {
				addedVideo = append(addedVideo, lt)
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

// pli asks a video track's publisher for a keyframe by writing an RTCP Picture
// Loss Indication to the publisher's PeerConnection for the track's SSRC. Audio
// (mic) tracks have no keyframes, so they are skipped. Called without s.mu.
func (s *SFU) pli(lt *localTrack) {
	if lt == nil || lt.kind == "mic" || lt.publisher == nil {
		return
	}
	_ = lt.publisher.pc.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: uint32(lt.ssrc)}})
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
