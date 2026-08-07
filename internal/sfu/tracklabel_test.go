package sfu

import (
	"testing"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/ryanwohara/webrtc-chat/internal/signal"
)

// A label keyed by an empty mid can never match an ontrack mid on the client, so a
// forward announced that way is media the client holds and is never told how to
// render — a permanently black tile.
//
// It is reachable because signalPeerConnections evaluates peerTrackInfos after
// releasing p.mu, while syncPeerSendersLocked adds transceivers under s.mu: a
// concurrent pass can append one to the same PeerConnection between our
// SetLocalDescription and the Tracks send. This pins the guard directly rather than
// trying to reproduce that interleaving.
func TestPeerTrackInfosSkipsUnnegotiatedTransceivers(t *testing.T) {
	s := testSFU(t)
	p, err := s.AddPeer("room", "p1", SignalerFunc(func(any) bool { return true }))
	if err != nil {
		t.Fatal(err)
	}
	track, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8}, "camera", "publisher")
	if err != nil {
		t.Fatal(err)
	}
	// Added but never negotiated: exactly the state a concurrent reconcile leaves
	// behind for the window this guards.
	if _, err := p.pc.AddTransceiverFromTrack(track, webrtc.RTPTransceiverInit{
		Direction: webrtc.RTPTransceiverDirectionSendonly,
	}); err != nil {
		t.Fatal(err)
	}
	if mid := p.pc.GetTransceivers()[0].Mid(); mid != "" {
		t.Fatalf("precondition failed: expected an un-negotiated transceiver, got mid %q", mid)
	}
	if infos := peerTrackInfos(p); len(infos) != 0 {
		t.Fatalf("peerTrackInfos announced an un-negotiated forward: %+v", infos)
	}
}

// The invariant a client depends on: every label it is ever handed names a real
// mid. An entry with an empty mid is worse than a missing one — the list looks
// complete while carrying a pairing that cannot happen.
func TestEveryTracksFrameNamesRealMids(t *testing.T) {
	s := testSFU(t)

	p1 := newTestClient(t, s, "room", "p1")
	writeTestRTPLoop(t, p1.publish("camera"))
	writeTestRTPLoop(t, p1.publish("mic"))
	p1.waitConnected()
	waitFor(t, func() bool { return s.trackCount("room") == 2 })

	p2 := newTestClient(t, s, "room", "p2")
	writeTestRTPLoop(t, p2.publish("camera"))
	p2.waitConnected()
	waitFor(t, func() bool { return s.trackCount("room") == 3 })

	// Let the renegotiations settle so every frame either side produced is in hand.
	time.Sleep(500 * time.Millisecond)

	for _, c := range []*testClient{p1, p2} {
		for {
			select {
			case tks := <-c.gotTracks:
				for _, ti := range tks.Tracks {
					if ti.Mid == "" {
						t.Errorf("%s got a label with an empty mid: %+v", c.id, ti)
					}
					if ti.ParticipantID == "" || ti.Kind == "" {
						t.Errorf("%s got an incomplete label: %+v", c.id, ti)
					}
				}
				continue
			default:
			}
			break
		}
	}
}

// The repair path. A label map is now sent when a negotiation COMPLETES, not only
// when one is proposed — so a forward that could not be named at offer time gets
// named as soon as the client answers, without waiting for a future renegotiation
// that a settled call will never produce.
func TestAnswerReSendsTheLabelMap(t *testing.T) {
	s := testSFU(t)

	p1 := newTestClient(t, s, "room", "p1")
	writeTestRTPLoop(t, p1.publish("camera"))
	p1.waitConnected()
	waitFor(t, func() bool { return s.trackCount("room") == 1 })

	p2 := newTestClient(t, s, "room", "p2")
	writeTestRTPLoop(t, p2.publish("camera"))
	p2.waitConnected()
	waitFor(t, func() bool { return s.trackCount("room") == 2 })

	// p2 must learn p1's camera. Drain until a frame names it; the point is that a
	// correct label arrives at all, whichever send carried it.
	waitForTracks(t, p2.gotTracks, func(tks signal.Tracks) bool {
		return listsTrack(tks, "p1", "camera")
	}, "naming p1's camera to p2")

	// The discriminator. The map used to be sent in exactly one place — beside each
	// server-initiated offer — so a peer saw one Tracks frame per offer and no more.
	// It is now also sent when the answer lands, so the count must EXCEED the offer
	// count. Equality is the old behaviour, and the state in which a forward that
	// could not be named at offer time stays unnamed.
	time.Sleep(500 * time.Millisecond) // let every renegotiation settle
	offers := len(p1.serverOffers())
	tracks := count(p1.gotTracks)
	if offers == 0 {
		t.Fatal("p1 received no server offers; nothing to assert about")
	}
	if tracks <= offers {
		t.Fatalf("p1 got %d label maps for %d offers — the answer is not re-sending one", tracks, offers)
	}
}

func count(ch <-chan signal.Tracks) int {
	n := 0
	for {
		select {
		case <-ch:
			n++
		default:
			return n
		}
	}
}
