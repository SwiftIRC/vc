package sfu

import (
	"errors"
	"log/slog"
	"sync"

	"github.com/pion/webrtc/v4"
)

// errNoRoom is returned when a published track arrives for a peer that is no
// longer present in any room (e.g. it was removed mid-negotiation).
var errNoRoom = errors.New("sfu: no room for publisher")

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
// track, registers it in the publisher's room under "publisherID:kind", and
// triggers renegotiation of the room's other peers. The room (and its slug) is
// resolved by locating the peer that owns publisherID.
func (s *SFU) addLocalTrack(publisherID, kind string, remote *webrtc.TrackRemote) (*webrtc.TrackLocalStaticRTP, error) {
	local, err := webrtc.NewTrackLocalStaticRTP(remote.Codec().RTPCodecCapability, kind, publisherID)
	if err != nil {
		return nil, err
	}
	key := publisherID + ":" + kind

	s.mu.Lock()
	slug, r := s.roomForPeerLocked(publisherID)
	if r == nil {
		s.mu.Unlock()
		return nil, errNoRoom
	}
	r.tracks[key] = &localTrack{publisherID: publisherID, kind: kind, track: local}
	s.mu.Unlock()

	s.signalPeerConnections(slug)
	return local, nil
}

// roomForPeerLocked returns the slug and room of the peer that owns peerID.
// Caller must hold s.mu. Returns "", nil if the peer is not in any room.
func (s *SFU) roomForPeerLocked(peerID string) (string, *mroom) {
	for slug, r := range s.rooms {
		if _, ok := r.peers[peerID]; ok {
			return slug, r
		}
	}
	return "", nil
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

// signalPeerConnections renegotiates every peer in the room so subscribers pick
// up added/removed tracks. Filled in by Task 4; a no-op stub for now.
func (s *SFU) signalPeerConnections(slug string) {}

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
