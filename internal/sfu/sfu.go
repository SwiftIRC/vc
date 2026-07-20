package sfu

import (
	"log/slog"
	"sync"

	"github.com/pion/webrtc/v4"
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
