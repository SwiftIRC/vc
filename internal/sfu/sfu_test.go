package sfu

import (
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"

	"github.com/ryanwohara/webrtc-chat/internal/config"
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

// --- Shared test helpers (built in Task 3; reused by Tasks 3–9) ---

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
