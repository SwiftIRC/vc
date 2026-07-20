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

// senderForKind returns the client PC's RTPSender carrying the given track kind.
func senderForKind(t *testing.T, pc *webrtc.PeerConnection, kind string) *webrtc.RTPSender {
	t.Helper()
	for _, snd := range pc.GetSenders() {
		if tr := snd.Track(); tr != nil && tr.ID() == kind {
			return snd
		}
	}
	t.Fatalf("no %s sender on client PC", kind)
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

	pliCount := countSenderPLI(t, senderForKind(t, p1.pc, "camera"))

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
	micPLI := countSenderPLI(t, senderForKind(t, p2.pc, "mic"))
	writeTestRTPLoop(t, mic)
	// Let the server capture the mic before a second peer joins, so the mic is a
	// live room track (eligible for the ticker) yet no server offer races p1's
	// own publish offer (the test client is a naive polite peer without rollback).
	waitFor(t, func() bool { return s.trackCount("room") == 1 })

	p1 := newTestClient(t, s, "room", "p1")
	cam := p1.publish("camera")
	p1.waitConnected()
	camPLI := countSenderPLI(t, senderForKind(t, p1.pc, "camera"))
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
