package sfu

import (
	"log/slog"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/ryanwohara/webrtc-chat/internal/signal"
)

type localTrack struct {
	publisherID string
	kind        string // mic|camera|screen
	track       *webrtc.TrackLocalStaticRTP
}

type mroom struct {
	peers  map[string]*Peer
	tracks map[string]*localTrack // key = publisherID + ":" + kind
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
		r = &mroom{peers: map[string]*Peer{}, tracks: map[string]*localTrack{}}
		s.rooms[slug] = r
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
// renegotiation of the room's other peers. The publisher's Peer already knows
// its slug, so it is passed in explicitly.
func (s *SFU) addLocalTrack(slug, publisherID, kind string, remote *webrtc.TrackRemote) (*webrtc.TrackLocalStaticRTP, error) {
	local, err := webrtc.NewTrackLocalStaticRTP(remote.Codec().RTPCodecCapability, kind, publisherID)
	if err != nil {
		return nil, err
	}
	key := publisherID + ":" + kind

	s.mu.Lock()
	s.roomLocked(slug).tracks[key] = &localTrack{publisherID: publisherID, kind: kind, track: local}
	s.mu.Unlock()

	s.signalPeerConnections(slug)
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
		// Reconcile every peer's senders; mark changed peers for renegotiation.
		for id, p := range r.peers {
			if syncPeerSendersLocked(p, r.tracks) {
				pending[id] = p
			}
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
			delete(pending, p.id)
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
// track back to it). It reports whether p's sender set changed. Caller holds
// s.mu.
func syncPeerSendersLocked(p *Peer, tracks map[string]*localTrack) bool {
	changed := false
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
		}
	}
	return changed
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

func (s *SFU) RemovePeer(slug, peerID string) {
	s.mu.Lock()
	r := s.rooms[slug]
	if r == nil {
		s.mu.Unlock()
		return
	}
	p := r.peers[peerID]
	delete(r.peers, peerID)
	// Task 7 also deletes this peer's published tracks here and renegotiates others.
	empty := len(r.peers) == 0
	if empty {
		delete(s.rooms, slug)
	}
	s.mu.Unlock()
	if p != nil {
		p.pc.Close()
	}
}
