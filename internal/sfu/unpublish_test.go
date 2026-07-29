package sfu

import (
	"strings"
	"testing"
	"time"

	"github.com/ryanwohara/webrtc-chat/internal/signal"
)

// TestUnpublishScreenDropsForward pins the "stopping a screenshare leaves the pane
// open for everyone else" bug. The sharer's own tile is local UI, so it always
// disappears; what matters is that the SFU drops the track from the room table and
// renegotiates every subscriber so their forwarded sender (and thus their screen
// tile) goes away.
//
// p1 publishes camera + screen, p2 subscribes. p1 then renegotiates the screen away
// exactly as a browser does on "stop sharing" (RemoveTrack -> negotiationneeded ->
// client offer). Afterwards p1:screen must be gone from the room and p1:camera must
// remain.
func TestUnpublishScreenDropsForward(t *testing.T) {
	s := testSFU(t)

	p1 := newTestClient(t, s, "room", "p1")
	cam := p1.publish("camera")
	writeTestRTPLoop(t, cam)
	screen := p1.publish("screen")
	writeTestRTPLoop(t, screen)
	p1.waitConnected()
	waitFor(t, func() bool { return s.trackCount("room") == 2 })

	p2 := newTestClient(t, s, "room", "p2")
	mic := p2.publish("mic")
	writeTestRTPLoop(t, mic)
	p2.waitConnected()
	waitFor(t, func() bool { return s.trackCount("room") == 3 })

	// p2 is now subscribed to p1's screen; stop the share.
	if err := p1.pc.RemoveTrack(senderForTrack(t, p1.pc, screen)); err != nil {
		t.Fatalf("RemoveTrack(screen): %v", err)
	}

	waitFor(t, func() bool { return !s.hasTrack("room", "p1:screen") })
	if !s.hasTrack("room", "p1:camera") {
		t.Fatal("p1:camera was dropped along with the screen")
	}
}

// TestUnpublishScreenOfferGoesInactive is the SUBSCRIBER-side half: dropping the
// track from the room table is useless unless the renegotiation actually reaches
// the subscriber as an m-line it can act on. A browser only removes a remote tile
// when the forwarded m-line stops receiving (direction inactive/recvonly), which is
// what fires removetrack on the stream. This asserts the offer p2 receives after
// p1 stops sharing carries BOTH screen m-lines (video and audio) as inactive.
func TestUnpublishScreenOfferGoesInactive(t *testing.T) {
	s := testSFU(t)

	p1 := newTestClient(t, s, "room", "p1")
	cam := p1.publish("camera")
	writeTestRTPLoop(t, cam)
	screen := p1.publish("screen")
	writeTestRTPLoop(t, screen)
	screenAudio := p1.publish("screen-audio")
	writeTestRTPLoop(t, screenAudio)
	p1.waitConnected()
	waitFor(t, func() bool { return s.trackCount("room") == 3 })

	p2 := newTestClient(t, s, "room", "p2")
	mic := p2.publish("mic")
	writeTestRTPLoop(t, mic)
	p2.waitConnected()
	waitFor(t, func() bool { return s.trackCount("room") == 4 })
	waitForTracks(t, p2.gotTracks, func(tks signal.Tracks) bool {
		return listsTrack(tks, "p1", "screen") && listsTrack(tks, "p1", "screen-audio")
	}, "advertising p1 screen + screen-audio")

	if err := p1.pc.RemoveTrack(senderForTrack(t, p1.pc, screen)); err != nil {
		t.Fatalf("RemoveTrack(screen): %v", err)
	}
	if err := p1.pc.RemoveTrack(senderForTrack(t, p1.pc, screenAudio)); err != nil {
		t.Fatalf("RemoveTrack(screen-audio): %v", err)
	}
	waitFor(t, func() bool {
		return !s.hasTrack("room", "p1:screen") && !s.hasTrack("room", "p1:screen-audio")
	})

	// The last offer p2 received must show both forwarded screen m-lines inactive.
	var last string
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		offers := p2.serverOffers()
		if len(offers) > 0 {
			last = mlineDirections(offers[len(offers)-1])
			if strings.Count(last, "inactive") >= 2 {
				return
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("both screen forwards must reach p2 inactive; last offer m-lines: %s (%d offers); p2 live forwards: %v",
		last, len(p2.serverOffers()), liveForwards(s, "room", "p2"))
}

// TestMidCallScreenshareStartStopCycles reproduces the real-world sequence: the
// subscriber is ALREADY in the room and the sharer starts, then stops, a share
// mid-call — repeatedly. Each stop must leave the room table with no p1:screen and
// must leave p2 with no live (non-inactive) screen forward. A stop that leaves the
// forward in place — or a later reconcile that re-appends a fresh screen
// transceiver — is the "receivers keep an extra sharing pane open" bug.
func TestMidCallScreenshareStartStopCycles(t *testing.T) {
	s := testSFU(t)

	p1 := newTestClient(t, s, "room", "p1")
	cam1 := p1.publish("camera")
	writeTestRTPLoop(t, cam1)
	p1.waitConnected()
	waitFor(t, func() bool { return s.trackCount("room") == 1 })

	p2 := newTestClient(t, s, "room", "p2")
	cam2 := p2.publish("camera")
	writeTestRTPLoop(t, cam2)
	p2.waitConnected()
	waitFor(t, func() bool { return s.trackCount("room") == 2 })

	for cycle := 1; cycle <= 3; cycle++ {
		screen := p1.publish("screen")
		writeTestRTPLoop(t, screen)
		waitFor(t, func() bool { return s.hasTrack("room", "p1:screen") })
		waitForTracks(t, p2.gotTracks, func(tks signal.Tracks) bool {
			return listsTrack(tks, "p1", "screen")
		}, "advertising p1 screen")

		if err := p1.pc.RemoveTrack(senderForTrack(t, p1.pc, screen)); err != nil {
			t.Fatalf("cycle %d RemoveTrack(screen): %v", cycle, err)
		}
		waitFor(t, func() bool { return !s.hasTrack("room", "p1:screen") })

		// The SFU must settle with p2 holding no live screen forward.
		waitFor(t, func() bool { return liveForwards(s, "room", "p2")["p1:screen"] == 0 })
		if n := liveForwards(s, "room", "p2")["p1:screen"]; n != 0 {
			t.Fatalf("cycle %d: p2 still has %d live p1:screen forward(s)", cycle, n)
		}
		if liveForwards(s, "room", "p2")["p1:camera"] != 1 {
			t.Fatalf("cycle %d: p2 lost p1:camera", cycle)
		}
	}
}

// liveForwards counts, per "publisherID:kind" key, how many senders with a live
// (non-nil) track the named peer currently holds — i.e. what the SFU is still
// forwarding to it. RemoveTrack clears a sender's track, so a dropped forward
// contributes 0.
func liveForwards(s *SFU, slug, peerID string) map[string]int {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := map[string]int{}
	r := s.rooms[slug]
	if r == nil {
		return out
	}
	p := r.peers[peerID]
	if p == nil {
		return out
	}
	for _, snd := range p.pc.GetSenders() {
		if key, ok := senderKey(snd); ok {
			out[key]++
		}
	}
	return out
}

// mlineDirections renders one "media/direction" token per m-section of an SDP, so a
// test failure shows which forward went inactive and which did not.
func mlineDirections(sdp string) string {
	var out []string
	media := ""
	dir := "?"
	flush := func() {
		if media != "" {
			out = append(out, media+"/"+dir)
		}
	}
	for _, line := range strings.Split(sdp, "\n") {
		line = strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, "m="):
			flush()
			media = strings.SplitN(strings.TrimPrefix(line, "m="), " ", 2)[0]
			dir = "?"
		case line == "a=sendonly", line == "a=recvonly", line == "a=sendrecv", line == "a=inactive":
			dir = strings.TrimPrefix(line, "a=")
		}
	}
	flush()
	return strings.Join(out, " ")
}
