package sfu

import (
	"encoding/json"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/webrtc/v4"

	"github.com/ryanwohara/webrtc-chat/internal/signal"
)

// trackSeq mints a unique, opaque track id per published track. A real browser's
// MediaStreamTrack.id is a read-only UUID the SFU must ignore; the kind travels in
// the MSID *stream id* instead (see publish). Making the track id unique and
// kind-free proves the server never derives kind from it.
var trackSeq atomic.Uint64

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
// signaling is looped back into an SFU Peer. It plays the browser's role, a
// *polite* perfect-negotiation peer: it answers server offers and drives its own
// offers from OnNegotiationNeeded.
//
// Real browsers resolve a glare (a client offer racing a server offer) by rolling
// their own offer back and re-offering. Pion v4.2.17 has NO SDP rollback of any
// kind (no local rollback, no implicit rollback via SetRemoteDescription), so a
// Pion polite peer cannot recover once it is stuck in have-local-offer. This
// harness therefore emulates politeness the only way two rollback-less Pion peers
// can converge: it never *creates* a colliding local offer. Its own offer is
// created and applied to the server atomically under the server Peer's mutex; if
// the server is mid-renegotiation, the offer is deferred and retried once the
// server settles. The server's impolite ignore-on-collision (HandleOffer) is the
// real product code and is exercised directly by TestHandleOfferIgnoresGlare; it
// is correct for the Plan-3 browser client, which can roll back.
type testClient struct {
	t         *testing.T
	id        string
	server    *Peer
	pc        *webrtc.PeerConnection
	gotTrack  chan *webrtc.TrackRemote
	gotTracks chan signal.Tracks

	// offerPending records that a locally-added track needs an offer but the server
	// was mid-renegotiation (glare); it is retried once the server settles. Guarded
	// by server.mu so the "is the server making an offer?" check and the offer's
	// creation/application are atomic against signalPeerConnections.
	offerPending bool

	// offers records every server-initiated offer SDP delivered to this client, so a
	// test can assert on the m-line directions a real browser would see (a forward
	// the SFU dropped must reach the subscriber as an inactive m-line).
	offersMu sync.Mutex
	offers   []string
}

// serverOffers returns a copy of the server-initiated offer SDPs this client has
// received, oldest first.
func (tc *testClient) serverOffers() []string {
	tc.offersMu.Lock()
	defer tc.offersMu.Unlock()
	return append([]string(nil), tc.offers...)
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
	// Drive the client's own offers from OnNegotiationNeeded, the browser's
	// perfect-negotiation entry point.
	pc.OnNegotiationNeeded(tc.onNegotiationNeeded)
	return tc
}

// onNegotiationNeeded fires when a locally-added track needs an offer. The polite
// client records the intent and tries to send it, coordinating with the server's
// own renegotiations via server.mu.
func (tc *testClient) onNegotiationNeeded() {
	p := tc.server
	p.mu.Lock()
	defer p.mu.Unlock()
	tc.offerPending = true
	tc.tryOfferLocked()
}

// tryOfferLocked sends the client's pending offer iff the server is stable. If the
// server is mid-offer (glare) the offer stays pending and is retried when the
// server's offer settles (see fromServer's signal.Offer case). The caller holds
// server.mu, and handleOfferLocked runs under that same lock, so the client's
// offer is created and applied to the server atomically: no server offer can slip
// in between and strand the client in have-local-offer — a state Pion cannot roll
// back out of. This is the Pion-compatible stand-in for a browser's rollback.
func (tc *testClient) tryOfferLocked() {
	p := tc.server
	if !tc.offerPending {
		return
	}
	if p.makingOffer || p.pc.SignalingState() != webrtc.SignalingStateStable {
		return // server busy: stay pending, retry after its offer settles
	}
	offer, err := tc.pc.CreateOffer(nil)
	if err != nil {
		return
	}
	if err := tc.pc.SetLocalDescription(offer); err != nil {
		return
	}
	tc.offerPending = false
	_ = p.handleOfferLocked(offer.SDP)
}

// fromServer handles a signaling frame the SFU sent to this client.
func (tc *testClient) fromServer(v any) {
	switch m := v.(type) {
	case signal.Offer:
		// Answer a server-initiated offer. Hold server.mu across the whole
		// transaction so it serializes with the client's own tryOfferLocked (both
		// mutate the client and server PeerConnections). After answering, flush any
		// offer that a glare had deferred — the server is stable again now, so the
		// deferred screenshare offer goes through here.
		tc.offersMu.Lock()
		tc.offers = append(tc.offers, m.SDP)
		tc.offersMu.Unlock()
		p := tc.server
		p.mu.Lock()
		defer p.mu.Unlock()
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
		tc.tryOfferLocked()
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

// publish adds a track (kind = "mic"|"camera"|"screen"). Adding the track makes
// Pion fire OnNegotiationNeeded, which drives the client's offer via
// onNegotiationNeeded — so publishing a screenshare mid-call goes through the same
// polite path and is transparently deferred/retried if it glares with a
// concurrent server renegotiation.
//
// The kind is declared OUT-OF-BAND, exactly as a browser must: a real browser
// cannot set the MSID stream id to the kind (MediaStream.id is read-only and
// random), so it publishes under a fresh random stream id and sends a
// {stream id -> kind} map in its offer (signal.Offer.Kinds). We mirror that here —
// a random per-track stream id plus recordKinds — rather than the (impossible in a
// browser) stream id == kind. The server derives kind from that map joined to
// remote.StreamID(), and the publisherID from the Peer; the track id is ignored.
//
// The track goes on a FRESH sendonly transceiver (AddTransceiverFromTrack), which is
// what net/peer.js's _addLocal does — addTransceiver never recycles. AddTrack must
// NOT be used: per spec it RECYCLES a compatible recvonly transceiver, and on this
// client every recvonly m-line is one the SERVER created to forward another peer's
// track. The SFU builds those with Direction: Sendonly, and Pion's
// newTransceiverFromTrack leaves Receiver() nil for a sendonly transceiver — so a
// publish landing in a recycled forward slot arrives on an m-line the server has no
// receiver for, OnTrack never fires, and the track is swallowed for the rest of the
// call with both sides reporting a fully negotiated, stable connection. That is a
// real (if browser-unreachable) SFU limitation; recycling here made the three-client
// mesh test flaky under load rather than testing the product's actual client.
func (tc *testClient) publish(kind string) *webrtc.TrackLocalStaticRTP {
	tc.t.Helper()
	mime := webrtc.MimeTypeVP8
	if kind == "mic" || kind == "screen-audio" {
		mime = webrtc.MimeTypeOpus
	}
	streamID := fmt.Sprintf("stream-%d", trackSeq.Add(1)) // random MSID stream id (browser: new MediaStream())
	track, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: mime},
		fmt.Sprintf("track-%d", trackSeq.Add(1)), /*opaque track id (ignored by the server)*/
		streamID,
	)
	if err != nil {
		tc.t.Fatal(err)
	}
	tc.server.recordKinds(map[string]string{streamID: kind}) // browser: offer's `kinds` map
	if _, err := tc.pc.AddTransceiverFromTrack(track, webrtc.RTPTransceiverInit{
		Direction: webrtc.RTPTransceiverDirectionSendonly,
	}); err != nil {
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
