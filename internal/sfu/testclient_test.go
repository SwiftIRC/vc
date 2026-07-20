package sfu

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/webrtc/v4"

	"github.com/ryanwohara/webrtc-chat/internal/signal"
)

// clientAPI builds a browser-like client API (same codecs, default interceptors).
func clientAPI(t *testing.T) *webrtc.API {
	t.Helper()
	m := &webrtc.MediaEngine{}
	if err := m.RegisterDefaultCodecs(); err != nil {
		t.Fatal(err)
	}
	i := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(m, i); err != nil {
		t.Fatal(err)
	}
	return webrtc.NewAPI(webrtc.WithMediaEngine(m), webrtc.WithInterceptorRegistry(i))
}

// testClient is a synthetic in-process peer: a client-side PeerConnection whose
// signaling is looped back into an SFU Peer. It plays the browser's role
// (polite peer): answers server offers, sends its own offer when it publishes.
type testClient struct {
	t         *testing.T
	id        string
	server    *Peer
	pc        *webrtc.PeerConnection
	gotTrack  chan *webrtc.TrackRemote
	gotTracks chan signal.Tracks
}

func newTestClient(t *testing.T, s *SFU, slug, id string) *testClient {
	t.Helper()
	pc, err := clientAPI(t).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	tc := &testClient{t: t, id: id, pc: pc,
		gotTrack: make(chan *webrtc.TrackRemote, 16), gotTracks: make(chan signal.Tracks, 16)}
	t.Cleanup(func() { pc.Close() })

	server, err := s.AddPeer(slug, id, SignalerFunc(func(v any) bool { tc.fromServer(v); return true }))
	if err != nil {
		t.Fatal(err)
	}
	tc.server = server

	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		raw, _ := json.Marshal(c.ToJSON())
		_ = tc.server.HandleCandidate(raw)
	})
	pc.OnTrack(func(tr *webrtc.TrackRemote, _ *webrtc.RTPReceiver) { tc.gotTrack <- tr })
	return tc
}

// fromServer handles a signaling frame the SFU sent to this client.
func (tc *testClient) fromServer(v any) {
	switch m := v.(type) {
	case signal.Offer:
		if err := tc.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: m.SDP}); err != nil {
			return
		}
		ans, err := tc.pc.CreateAnswer(nil)
		if err != nil {
			return
		}
		if err := tc.pc.SetLocalDescription(ans); err != nil {
			return
		}
		_ = tc.server.HandleAnswer(ans.SDP)
	case signal.Answer:
		_ = tc.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: m.SDP})
	case signal.Candidate:
		var init webrtc.ICECandidateInit
		if json.Unmarshal(m.Candidate, &init) == nil {
			_ = tc.pc.AddICECandidate(init)
		}
	case signal.Tracks:
		tc.gotTracks <- m
	}
}

// publish adds a track (kind = "mic"|"camera"|"screen") and drives a client offer.
func (tc *testClient) publish(kind string) *webrtc.TrackLocalStaticRTP {
	tc.t.Helper()
	mime := webrtc.MimeTypeVP8
	if kind == "mic" {
		mime = webrtc.MimeTypeOpus
	}
	track, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: mime}, kind /*track ID = kind*/, tc.id /*stream ID*/)
	if err != nil {
		tc.t.Fatal(err)
	}
	if _, err := tc.pc.AddTrack(track); err != nil {
		tc.t.Fatal(err)
	}
	offer, err := tc.pc.CreateOffer(nil)
	if err != nil {
		tc.t.Fatal(err)
	}
	if err := tc.pc.SetLocalDescription(offer); err != nil {
		tc.t.Fatal(err)
	}
	if err := tc.server.HandleOffer(offer.SDP); err != nil {
		tc.t.Fatal(err)
	}
	return track
}

// waitConnected fails if the client PC does not reach Connected in time.
func (tc *testClient) waitConnected() {
	tc.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if tc.pc.ConnectionState() == webrtc.PeerConnectionStateConnected {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	tc.t.Fatalf("client %s never connected (state %v)", tc.id, tc.pc.ConnectionState())
}
