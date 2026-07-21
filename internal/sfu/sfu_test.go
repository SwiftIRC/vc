package sfu

import (
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"

	"github.com/ryanwohara/webrtc-chat/internal/config"
	"github.com/ryanwohara/webrtc-chat/internal/signal"
)

func testSFU(t *testing.T) *SFU {
	t.Helper()
	e, err := NewEngine(config.Config{UDPPortMin: 0, UDPPortMax: 0}) // 0,0 => any ephemeral port
	if err != nil {
		t.Fatal(err)
	}
	return NewSFU(e, slog.New(slog.NewTextHandler(&strings.Builder{}, nil)))
}

func TestPeerConnectsAfterPublish(t *testing.T) {
	s := testSFU(t)
	c := newTestClient(t, s, "room", "p1")
	c.publish("camera")
	c.waitConnected()
}

func TestPublishStoresLocalTrack(t *testing.T) {
	s := testSFU(t)
	c := newTestClient(t, s, "room", "p1")
	track := c.publish("camera")
	c.waitConnected()
	// write a few RTP packets so OnTrack fires on the server
	writeTestRTP(t, track, 5)
	waitFor(t, func() bool { return s.trackCount("room") == 1 })
	if key := s.firstTrackKey("room"); key != "p1:camera" {
		t.Errorf("track key = %q, want p1:camera", key)
	}
}

// TestPublisherCameraAndScreenAreDistinctKinds verifies the SFU derives a
// published track's kind from the MSID stream id (mirroring a browser's
// streamIds:[kind]), NOT from the track id. One publisher sending BOTH a camera
// and a screen video track — both video, both with opaque, kind-free track ids —
// must be recorded as two distinct kinds (p1:camera and p1:screen), never
// collapsed. A server that read remote.ID() cannot tell them apart: it would fall
// back to "camera" for both and silently drop the screen share.
func TestPublisherCameraAndScreenAreDistinctKinds(t *testing.T) {
	s := testSFU(t)
	c := newTestClient(t, s, "room", "p1")
	cam := c.publish("camera")
	screen := c.publish("screen")
	c.waitConnected()
	writeTestRTPLoop(t, cam)    // drive RTP so OnTrack fires for the camera
	writeTestRTPLoop(t, screen) // and for the screen share

	// Both kinds must appear as distinct room tracks. Before the fix (kind from
	// remote.ID()) both video tracks collapse to "camera" and p1:screen never
	// appears, so this waits out its deadline and fails.
	waitFor(t, func() bool {
		return s.hasTrack("room", "p1:camera") && s.hasTrack("room", "p1:screen")
	})
}

func TestFanOutDeliversTrackToOtherPeer(t *testing.T) {
	s := testSFU(t)
	p1 := newTestClient(t, s, "room", "p1")
	p2 := newTestClient(t, s, "room", "p2")
	p2.publish("mic") // p2 must offer too so it has a live PC to receive on
	p2.waitConnected()
	track := p1.publish("camera")
	p1.waitConnected()
	writeTestRTPLoop(t, track) // background writer until test ends
	select {
	case tr := <-p2.gotTrack:
		if tr.StreamID() != "p1" {
			t.Errorf("received track stream = %q, want p1", tr.StreamID())
		}
		// read at least one RTP packet through the fan-out
		buf := make([]byte, 1500)
		tr.SetReadDeadline(time.Now().Add(5 * time.Second))
		if _, _, err := tr.Read(buf); err != nil {
			t.Fatalf("no RTP forwarded: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("p2 never received p1's track")
	}
}

func TestRenegotiationEmitsTracksMetadata(t *testing.T) {
	s := testSFU(t)
	p1 := newTestClient(t, s, "room", "p1")
	p2 := newTestClient(t, s, "room", "p2")
	p2.publish("mic") // p2 must offer too so it has a live PC to receive on
	p2.waitConnected()
	track := p1.publish("camera")
	p1.waitConnected()
	writeTestRTPLoop(t, track) // background writer until OnTrack fires on the server

	select {
	case tks := <-p2.gotTracks:
		found := false
		for _, ti := range tks.Tracks {
			if ti.ParticipantID == "p1" && ti.Kind == "camera" && ti.Mid != "" {
				found = true
			}
		}
		if !found {
			t.Errorf("tracks msg missing p1/camera: %+v", tks)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no tracks metadata")
	}
}

// countSenderPLI reads inbound RTCP on a client RTPSender in the background and
// returns a thread-safe accessor for how many PictureLossIndication packets it
// has observed. The reader stops when the test ends (its stop is closed before
// the client's PC is closed, so the goroutine exits without leaking).
func countSenderPLI(t *testing.T, sender *webrtc.RTPSender) func() int {
	t.Helper()
	var mu sync.Mutex
	count := 0
	stop := make(chan struct{})
	t.Cleanup(func() { close(stop) })
	go func() {
		for {
			select {
			case <-stop:
				return
			default:
			}
			_ = sender.SetReadDeadline(time.Now().Add(250 * time.Millisecond))
			pkts, _, err := sender.ReadRTCP()
			if err != nil {
				select {
				case <-stop:
					return
				default:
					continue // read deadline (or transient); keep polling
				}
			}
			for _, p := range pkts {
				if _, ok := p.(*rtcp.PictureLossIndication); ok {
					mu.Lock()
					count++
					mu.Unlock()
				}
			}
		}
	}()
	return func() int {
		mu.Lock()
		defer mu.Unlock()
		return count
	}
}

// senderForTrack returns the client PC's RTPSender carrying the given local
// track, matched by identity. The client publishes each track under a random MSID
// stream id (as a browser must — see publish), so the sender cannot be found by a
// kind-tagged stream id; the test holds the track object publish returned.
func senderForTrack(t *testing.T, pc *webrtc.PeerConnection, track webrtc.TrackLocal) *webrtc.RTPSender {
	t.Helper()
	for _, snd := range pc.GetSenders() {
		if snd.Track() == track {
			return snd
		}
	}
	t.Fatalf("no sender for track %s on client PC", track.ID())
	return nil
}

// TestPLISentToVideoPublisher verifies the SFU asks a video publisher for a
// keyframe: p2 subscribes to p1's camera (new-subscriber trigger) and the
// per-room 3s ticker also fires, so p1's camera RTPSender must observe an RTCP
// PictureLossIndication within a few seconds.
func TestPLISentToVideoPublisher(t *testing.T) {
	s := testSFU(t)

	// p2 joins first so it is present when p1 publishes and gets subscribed.
	p2 := newTestClient(t, s, "room", "p2")
	p2.publish("mic")
	p2.waitConnected()

	p1 := newTestClient(t, s, "room", "p1")
	track := p1.publish("camera")
	p1.waitConnected()

	pliCount := countSenderPLI(t, senderForTrack(t, p1.pc, track))

	// Drive RTP so the server's OnTrack fires, captures the SSRC, and subscribes
	// p2 to p1's camera (triggering a PLI to p1). The ticker backstops it.
	writeTestRTPLoop(t, track)

	waitFor(t, func() bool { return pliCount() >= 1 })
}

// TestAudioPublisherGetsNoPLI verifies mic publishers are never asked for a
// keyframe: p2's mic sender must observe zero PLI while p1's camera does get one.
func TestAudioPublisherGetsNoPLI(t *testing.T) {
	s := testSFU(t)

	p2 := newTestClient(t, s, "room", "p2")
	mic := p2.publish("mic")
	p2.waitConnected()
	micPLI := countSenderPLI(t, senderForTrack(t, p2.pc, mic))
	writeTestRTPLoop(t, mic)
	// Let the server capture the mic before a second peer joins, so the mic is a
	// live room track (eligible for the ticker) yet no server offer races p1's
	// own publish offer (the test client is a naive polite peer without rollback).
	waitFor(t, func() bool { return s.trackCount("room") == 1 })

	p1 := newTestClient(t, s, "room", "p1")
	cam := p1.publish("camera")
	p1.waitConnected()
	camPLI := countSenderPLI(t, senderForTrack(t, p1.pc, cam))
	writeTestRTPLoop(t, cam)

	// The camera publisher must receive PLI; confirms the room is actively
	// dispatching keyframe requests during the window we assert over.
	waitFor(t, func() bool { return camPLI() >= 1 })
	if got := micPLI(); got != 0 {
		t.Errorf("mic publisher received %d PLI, want 0", got)
	}
}

// TestRoomTickerStopsOnRemove verifies the per-room keyframe ticker's goroutine
// is signalled to exit when the room's last peer leaves (no goroutine leak).
func TestRoomTickerStopsOnRemove(t *testing.T) {
	s := testSFU(t)
	if _, err := s.AddPeer("solo", "p1", SignalerFunc(func(any) bool { return true })); err != nil {
		t.Fatal(err)
	}

	s.mu.Lock()
	r := s.rooms["solo"]
	s.mu.Unlock()
	if r == nil {
		t.Fatal("room not created")
	}
	done := r.done

	s.RemovePeer("solo", "p1")

	select {
	case <-done: // closed by RemovePeer -> ticker goroutine returns
	case <-time.After(2 * time.Second):
		t.Fatal("room ticker done channel not closed after last peer removed")
	}

	s.mu.Lock()
	_, exists := s.rooms["solo"]
	s.mu.Unlock()
	if exists {
		t.Fatal("room not deleted after last peer removed")
	}
}

// TestRemovePeerDeletesOnlyDepartedTracks isolates RemovePeer's track cleanup
// from the publisher read-loop (Task 3, which removes a track when its OnTrack
// read loop ends on PC close). Tracks are registered directly here, with no read
// loop attached, so RemovePeer itself is the only thing that can delete them: it
// must drop exactly the departing peer's tracks and leave every other peer's.
func TestRemovePeerDeletesOnlyDepartedTracks(t *testing.T) {
	s := testSFU(t)
	sink := SignalerFunc(func(any) bool { return true })
	p1, err := s.AddPeer("room", "p1", sink)
	if err != nil {
		t.Fatal(err)
	}
	p2, err := s.AddPeer("room", "p2", sink)
	if err != nil {
		t.Fatal(err)
	}

	// Register tracks directly in the room; no OnTrack read loop backs these, so
	// nothing but RemovePeer will ever delete them.
	inject := func(pub *Peer, kind string) {
		local, err := webrtc.NewTrackLocalStaticRTP(
			webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8}, kind, pub.id)
		if err != nil {
			t.Fatal(err)
		}
		s.mu.Lock()
		s.rooms["room"].tracks[pub.id+":"+kind] = &localTrack{
			publisherID: pub.id, kind: kind, track: local, publisher: pub,
		}
		s.mu.Unlock()
	}
	inject(p1, "camera")
	inject(p1, "screen")
	inject(p2, "mic")

	s.RemovePeer("room", "p1")

	if s.hasTrack("room", "p1:camera") {
		t.Error("p1:camera still present after RemovePeer removed p1")
	}
	if s.hasTrack("room", "p1:screen") {
		t.Error("p1:screen still present after RemovePeer removed p1")
	}
	if !s.hasTrack("room", "p2:mic") {
		t.Error("p2:mic (a surviving peer's track) was wrongly deleted")
	}
}

// TestRemovePeerDropsTracksAndRenegotiates verifies that when a publisher leaves,
// RemovePeer deletes the tracks it published and renegotiates the remaining
// subscribers so they drop the departed sender. p2 subscribes to p1's camera,
// then p1 is removed: p1:camera must be gone from the room the instant RemovePeer
// returns, p2's own mic must remain, and p2 must receive a renegotiation whose
// Tracks metadata no longer advertises p1/camera.
func TestRemovePeerDropsTracksAndRenegotiates(t *testing.T) {
	s := testSFU(t)

	// p2 joins first (present when p1 publishes) and publishes mic so it has a
	// live, connected PC on which to receive p1's forwarded camera. RTP flows on
	// the mic so the server registers p2:mic — a track that must survive p1's
	// departure (RemovePeer drops only the departed peer's tracks).
	p2 := newTestClient(t, s, "room", "p2")
	mic := p2.publish("mic")
	p2.waitConnected()
	writeTestRTPLoop(t, mic)
	waitFor(t, func() bool { return s.hasTrack("room", "p2:mic") })

	p1 := newTestClient(t, s, "room", "p1")
	cam := p1.publish("camera")
	p1.waitConnected()
	writeTestRTPLoop(t, cam) // drive RTP so the server's OnTrack captures p1's camera

	// p2 must actually be subscribed to p1's camera before p1 departs, so the
	// removal has a real sender to renegotiate away.
	select {
	case tr := <-p2.gotTrack:
		if tr.StreamID() != "p1" {
			t.Fatalf("received track stream = %q, want p1", tr.StreamID())
		}
	case <-time.After(10 * time.Second):
		t.Fatal("p2 never received p1's camera")
	}
	waitFor(t, func() bool { return s.hasTrack("room", "p1:camera") })

	s.RemovePeer("room", "p1")

	// RemovePeer drops the departed publisher's tracks synchronously under s.mu,
	// so p1:camera is gone the moment it returns — it must not depend on the
	// publisher read-loop's asynchronous cleanup winning a race.
	if s.hasTrack("room", "p1:camera") {
		t.Error("p1:camera still present immediately after RemovePeer")
	}
	if !s.hasTrack("room", "p2:mic") {
		t.Error("p2:mic should still be present after p1 leaves")
	}

	// p2 receives a renegotiation offer whose Tracks no longer list p1/camera.
	waitForTracksWithout(t, p2.gotTracks, "p1", "camera")
}

// TestGlareScreenshareConverges exercises perfect-negotiation glare handling for a
// client-initiated (screenshare) renegotiation. p1 publishes camera and connects;
// p2 then joins and publishes, and driving p2's RTP makes the server capture p2's
// track and renegotiate p1 (a server -> p1 offer). At nearly the same moment p1
// publishes a screenshare — a client offer that collides with the server's
// in-flight offer to p1. The impolite server ignores the glaring offer; the polite
// client rolls its own offer back, answers the server, then re-offers the
// screenshare once the connection settles. The session must CONVERGE: p1 stays
// Connected and p2 eventually receives BOTH of p1's tracks (camera + screen).
func TestGlareScreenshareConverges(t *testing.T) {
	s := testSFU(t)

	p1 := newTestClient(t, s, "room", "p1")
	cam := p1.publish("camera")
	p1.waitConnected()
	writeTestRTPLoop(t, cam) // server captures p1:camera
	waitFor(t, func() bool { return s.hasTrack("room", "p1:camera") })

	// p2 joins and publishes; its RTP makes the server capture p2:mic and
	// renegotiate p1 (adding p2:mic as a sender) — the server-initiated offer.
	p2 := newTestClient(t, s, "room", "p2")
	mic := p2.publish("mic")
	p2.waitConnected()
	writeTestRTPLoop(t, mic)

	// Glare: publish the screenshare immediately, so p1's client offer races the
	// server's renegotiation offer to p1.
	screen := p1.publish("screen")
	writeTestRTPLoop(t, screen) // drive RTP so the server captures p1:screen once negotiated

	// Convergence: p1 must remain Connected and p2 must receive both p1 tracks.
	p1.waitConnected()

	got := map[string]bool{"camera": false, "screen": false}
	deadline := time.After(20 * time.Second)
	for !(got["camera"] && got["screen"]) {
		select {
		case tr := <-p2.gotTrack:
			if tr.StreamID() == "p1" {
				if _, ok := got[tr.ID()]; ok {
					got[tr.ID()] = true
				}
			}
		case <-deadline:
			t.Fatalf("p2 did not receive both p1 tracks (camera+screen); got %+v", got)
		}
	}

	if st := p1.pc.ConnectionState(); st != webrtc.PeerConnectionStateConnected {
		t.Fatalf("p1 did not end Connected: %v", st)
	}
}

// TestClientOfferDefersUntilServerSettles deterministically exercises the polite
// client's glare handling (the natural race in TestGlareScreenshareConverges is
// timing-sensitive and only rarely collides in-process). It pins the server as
// "mid-offer", publishes a screenshare, and asserts the client DEFERS its offer —
// staying stable rather than stranding itself in have-local-offer, which Pion
// cannot roll back out of — then, once a real server renegotiation settles the
// peer, the deferred screenshare offer is flushed and reaches the server.
func TestClientOfferDefersUntilServerSettles(t *testing.T) {
	s := testSFU(t)
	p1 := newTestClient(t, s, "room", "p1")
	p1.publish("camera")
	p1.waitConnected()

	// Pretend a server-initiated renegotiation of p1 is in flight.
	p1.server.mu.Lock()
	p1.server.makingOffer = true
	p1.server.mu.Unlock()

	screen := p1.publish("screen") // onNegotiationNeeded -> tryOfferLocked -> defers

	// The offer must be deferred (pending), not applied: the client stays stable.
	waitFor(t, func() bool {
		p1.server.mu.Lock()
		defer p1.server.mu.Unlock()
		return p1.offerPending
	})
	if st := p1.pc.SignalingState(); st != webrtc.SignalingStateStable {
		t.Fatalf("deferred client must stay stable (Pion has no rollback), got %v", st)
	}
	if s.hasTrack("room", "p1:screen") {
		t.Fatal("screen offer reached the server while it should have been deferred")
	}

	// Server renegotiation settles; a real server offer to p1 (from p2 publishing)
	// then flushes the deferred screenshare offer.
	p1.server.mu.Lock()
	p1.server.makingOffer = false
	p1.server.mu.Unlock()

	p2 := newTestClient(t, s, "room", "p2")
	mic := p2.publish("mic")
	p2.waitConnected()
	writeTestRTPLoop(t, mic)    // capture p2:mic -> server renegotiates p1 -> flush
	writeTestRTPLoop(t, screen) // once flushed & negotiated, RTP lets the server capture it

	waitFor(t, func() bool { return s.hasTrack("room", "p1:screen") })
	if st := p1.pc.ConnectionState(); st != webrtc.PeerConnectionStateConnected {
		t.Fatalf("p1 not Connected after the deferred offer converged: %v", st)
	}
}

// clientOfferSDP builds a well-formed client offer (one video track) for feeding
// to a server Peer's HandleOffer, without wiring up a full testClient.
func clientOfferSDP(t *testing.T, streamID string) string {
	t.Helper()
	pc, err := clientAPI(t).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pc.Close() })
	tr, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8}, "screen", streamID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pc.AddTrack(tr); err != nil {
		t.Fatal(err)
	}
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	return offer.SDP
}

// TestHandleOfferIgnoresGlare directly exercises the server's *impolite* side of
// perfect negotiation: a client offer that arrives while the server is mid
// renegotiation (or has a server offer in flight) must be IGNORED — HandleOffer
// returns nil without applying the remote offer or sending an answer — so it does
// not clobber the server's own in-flight offer. (The polite client re-offers once
// the server settles; the convergence test covers that end to end.)
func TestHandleOfferIgnoresGlare(t *testing.T) {
	t.Run("not stable (server offer in flight)", func(t *testing.T) {
		s := testSFU(t)
		var mu sync.Mutex
		answers := 0
		p, err := s.AddPeer("room", "p1", SignalerFunc(func(v any) bool {
			if _, ok := v.(signal.Answer); ok {
				mu.Lock()
				answers++
				mu.Unlock()
			}
			return true
		}))
		if err != nil {
			t.Fatal(err)
		}

		// Put the server PC into have-local-offer, as if mid server renegotiation.
		tr, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8}, "camera", "p1")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := p.pc.AddTrack(tr); err != nil {
			t.Fatal(err)
		}
		offer, err := p.pc.CreateOffer(nil)
		if err != nil {
			t.Fatal(err)
		}
		if err := p.pc.SetLocalDescription(offer); err != nil {
			t.Fatal(err)
		}
		if p.pc.SignalingState() != webrtc.SignalingStateHaveLocalOffer {
			t.Fatalf("precondition: want have-local-offer, got %v", p.pc.SignalingState())
		}

		if err := p.HandleOffer(clientOfferSDP(t, "c"), nil); err != nil {
			t.Fatalf("HandleOffer on glare returned error: %v", err)
		}
		if st := p.pc.SignalingState(); st != webrtc.SignalingStateHaveLocalOffer {
			t.Errorf("glare offer changed signaling state to %v; want it left at have-local-offer", st)
		}
		if p.pc.CurrentRemoteDescription() != nil || p.pc.PendingRemoteDescription() != nil {
			t.Error("glare offer was applied as a remote description; want it ignored")
		}
		mu.Lock()
		got := answers
		mu.Unlock()
		if got != 0 {
			t.Errorf("server sent %d answers on glare; want 0 (impolite ignore)", got)
		}
	})

	t.Run("makingOffer flag set", func(t *testing.T) {
		s := testSFU(t)
		p, err := s.AddPeer("room", "p1", SignalerFunc(func(any) bool { return true }))
		if err != nil {
			t.Fatal(err)
		}
		// Stable signaling state, but a server offer is being created (makingOffer).
		p.mu.Lock()
		p.makingOffer = true
		p.mu.Unlock()

		if err := p.HandleOffer(clientOfferSDP(t, "c"), nil); err != nil {
			t.Fatalf("HandleOffer returned error: %v", err)
		}
		if st := p.pc.SignalingState(); st != webrtc.SignalingStateStable {
			t.Errorf("glare offer moved signaling state to %v; want stable (ignored)", st)
		}
		if p.pc.CurrentRemoteDescription() != nil || p.pc.PendingRemoteDescription() != nil {
			t.Error("glare offer was applied while makingOffer; want it ignored")
		}
	})
}

// TestRecoversStrandedRenegotiation reproduces the abandoned-renegotiation bug
// and asserts the subscriber recovers. A subscriber (p2) is offered one track
// (O1) and left in have-local-offer; a SECOND track (screen) is then reconciled
// onto its PC but cannot be offered while O1 is unanswered, so
// signalPeerConnections' in-pass retries exhaust with the screen sender
// added-but-unsignaled. Before the fix, once O1 is finally answered the next
// reconcile sees the sender already present (changed=false) and never offers it,
// so p2 is permanently starved. The fix persists the "needs offer" state
// (mroom.reneg) and, when the peer returns to stable, re-reconciles
// (HandleAnswer) and reschedules on exhaustion — so p2 is eventually offered the
// screen track. This is a deterministic RED->GREEN: without the reneg
// persistence + re-reconcile p2 is never offered screen (a fresh pass finds
// nothing changed); with it, it is.
//
// Recovery is asserted via the prompt HandleAnswer re-reconcile (1b), which does
// not depend on the reschedule delay. The exhaustion reschedule (1a) drains the
// same reneg set on a timer; the test does NOT shrink renegRetryDelay because
// that package var is read lock-free by background reschedule goroutines, so a
// test-side write to it would data-race under -race (no happens-before edge).
func TestRecoversStrandedRenegotiation(t *testing.T) {
	s := testSFU(t)

	var mu sync.Mutex
	var p2offers []string
	p2, err := s.AddPeer("room", "p2", SignalerFunc(func(v any) bool {
		if o, ok := v.(signal.Offer); ok {
			mu.Lock()
			p2offers = append(p2offers, o.SDP)
			mu.Unlock()
		}
		return true
	}))
	if err != nil {
		t.Fatal(err)
	}
	p1, err := s.AddPeer("room", "p1", SignalerFunc(func(any) bool { return true }))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.RemovePeer("room", "p1"); s.RemovePeer("room", "p2") })

	// A client PC to answer p2's first server offer on our schedule, so we control
	// exactly when p2 leaves have-local-offer.
	cli, err := clientAPI(t).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cli.Close() })

	inject := func(kind string) {
		t.Helper()
		local, err := webrtc.NewTrackLocalStaticRTP(
			webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8}, kind, p1.id)
		if err != nil {
			t.Fatal(err)
		}
		s.mu.Lock()
		s.rooms["room"].tracks[p1.id+":"+kind] = &localTrack{
			publisherID: p1.id, kind: kind, track: local, publisher: p1,
		}
		s.mu.Unlock()
	}
	lastOffer := func() string {
		mu.Lock()
		defer mu.Unlock()
		if len(p2offers) == 0 {
			return ""
		}
		return p2offers[len(p2offers)-1]
	}
	offeredScreen := func() bool {
		mu.Lock()
		defer mu.Unlock()
		for _, sdp := range p2offers {
			if strings.Contains(sdp, "screen") {
				return true
			}
		}
		return false
	}

	// 1) p1 publishes camera -> p2 is offered O1 (camera) and enters have-local-offer.
	inject("camera")
	s.signalPeerConnections("room")
	o1 := lastOffer()
	if o1 == "" || strings.Contains(o1, "screen") {
		t.Fatalf("precondition: want a camera-only first offer; empty=%v hasScreen=%v", o1 == "", strings.Contains(o1, "screen"))
	}
	if st := p2.pc.SignalingState(); st != webrtc.SignalingStateHaveLocalOffer {
		t.Fatalf("precondition: p2 want have-local-offer, got %v", st)
	}

	// 2) p1 publishes screen while O1 is unanswered: the screen sender is reconciled
	// onto p2 but cannot be offered (p2 is in have-local-offer), so this pass
	// exhausts its retries with the screen sender added-but-unsignaled.
	inject("screen")
	s.signalPeerConnections("room")
	if offeredScreen() {
		t.Fatal("screen was offered while p2 was still in have-local-offer; cannot observe recovery")
	}

	// 3) Answer O1 so p2 returns to stable. Recovery must re-offer the stranded
	// screen sender (HandleAnswer re-reconcile, with the reschedule as backstop).
	if err := cli.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: o1}); err != nil {
		t.Fatalf("client SetRemoteDescription(O1): %v", err)
	}
	ans, err := cli.CreateAnswer(nil)
	if err != nil {
		t.Fatalf("client CreateAnswer: %v", err)
	}
	if err := cli.SetLocalDescription(ans); err != nil {
		t.Fatalf("client SetLocalDescription: %v", err)
	}
	if err := p2.HandleAnswer(ans.SDP); err != nil {
		t.Fatalf("HandleAnswer(O1): %v", err)
	}

	// The previously-stranded screen sender must now be offered to p2.
	waitFor(t, offeredScreen)
}

// --- Shared test helpers (built in Task 3; reused by Tasks 3–9) ---

// waitForTracksWithout waits until a Tracks signaling frame arrives that no longer
// advertises the given participant/kind — evidence the peer was renegotiated to
// drop that forwarded track. Earlier frames that still list it are skipped.
func waitForTracksWithout(t *testing.T, ch <-chan signal.Tracks, participant, kind string) {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case tks := <-ch:
			dropped := true
			for _, ti := range tks.Tracks {
				if ti.ParticipantID == participant && ti.Kind == kind {
					dropped = false
				}
			}
			if dropped {
				return
			}
		case <-deadline:
			t.Fatalf("no renegotiation dropping %s/%s", participant, kind)
		}
	}
}

// waitFor polls pred until true or a 5s deadline (fatal on timeout).
func waitFor(t *testing.T, pred func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if pred() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("condition not met before deadline")
}

// writeTestRTP writes n minimal RTP packets to a local track (enough to make the
// server's OnTrack fire and the read loop run).
func writeTestRTP(t *testing.T, track *webrtc.TrackLocalStaticRTP, n int) {
	t.Helper()
	for i := 0; i < n; i++ {
		pkt := &rtp.Packet{
			Header:  rtp.Header{Version: 2, SequenceNumber: uint16(i), Timestamp: uint32(i * 3000), SSRC: 0x1234},
			Payload: []byte{0x90, 0x00, 0x00, 0x00, 0x00},
		}
		if err := track.WriteRTP(pkt); err != nil {
			t.Fatalf("WriteRTP: %v", err)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// writeTestRTPLoop writes RTP in the background until the test ends.
func writeTestRTPLoop(t *testing.T, track *webrtc.TrackLocalStaticRTP) {
	t.Helper()
	stop := make(chan struct{})
	t.Cleanup(func() { close(stop) })
	go func() {
		seq := 0
		for {
			select {
			case <-stop:
				return
			default:
			}
			track.WriteRTP(&rtp.Packet{
				Header:  rtp.Header{Version: 2, SequenceNumber: uint16(seq), Timestamp: uint32(seq * 3000), SSRC: 0x1234},
				Payload: []byte{0x90, 0x00, 0x00, 0x00, 0x00},
			})
			seq++
			time.Sleep(20 * time.Millisecond)
		}
	}()
}

// test-only accessors on *SFU (guarded by s.mu):
func (s *SFU) trackCount(slug string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r := s.rooms[slug]; r != nil {
		return len(r.tracks)
	}
	return 0
}

func (s *SFU) hasTrack(slug, key string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r := s.rooms[slug]; r != nil {
		_, ok := r.tracks[key]
		return ok
	}
	return false
}

func (s *SFU) firstTrackKey(slug string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r := s.rooms[slug]; r != nil {
		for k := range r.tracks {
			return k
		}
	}
	return ""
}
