package sfu

import (
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

// TestThreeClientsFullMesh is the end-to-end media-plane test: three synthetic
// clients in one room, each publishing mic+camera and one (p1) also a screen,
// must every one receive the other two participants' tracks with live RTP.
//
// Expected inbound per client (the SFU never loops a peer's own track back):
//   - p1: p2{mic,camera} + p3{mic,camera}                 = 4
//   - p2: p1{mic,camera,screen} + p3{mic,camera}          = 5
//   - p3: p1{mic,camera,screen} + p2{mic,camera}          = 5
//
// Clients are introduced one at a time and their publishes are driven to the
// room's track table before the next joins; this mirrors the package's other
// convergence tests and keeps the (real, in-process) perfect-negotiation glare
// bounded. All PCs and RTP writers self-close via the harness's t.Cleanup.
func TestThreeClientsFullMesh(t *testing.T) {
	s := testSFU(t)

	// publisher plan: track kinds each client publishes.
	plan := map[string][]string{
		"p1": {"mic", "camera", "screen"},
		"p2": {"mic", "camera"},
		"p3": {"mic", "camera"},
	}

	// bring up a client, publish its planned tracks with live RTP, wait until the
	// server has captured every one of them, and return it.
	bringUp := func(id string, roomTracksAfter int) *testClient {
		c := newTestClient(t, s, "room", id)
		for _, kind := range plan[id] {
			track := c.publish(kind)
			writeTestRTPLoop(t, track)
		}
		c.waitConnected()
		// Every planned track for this client must reach the room table (OnTrack ->
		// addLocalTrack) before the next client joins, so renegotiations stay bounded.
		waitForRoomTracks(t, s, "room", roomTracksAfter, c)
		return c
	}

	p1 := bringUp("p1", 3)
	p2 := bringUp("p2", 5)
	p3 := bringUp("p3", 7)

	// For each client, the set of {publisherID:kind} it must receive.
	want := func(self string) map[string]bool {
		m := map[string]bool{}
		for id, kinds := range plan {
			if id == self {
				continue
			}
			for _, k := range kinds {
				m[id+":"+k] = false
			}
		}
		return m
	}

	assertReceivesAll(t, p1, want("p1"))
	assertReceivesAll(t, p2, want("p2"))
	assertReceivesAll(t, p3, want("p3"))
}

// assertReceivesAll drains tc.gotTrack until every expected {streamID:trackID}
// has arrived, then reads one RTP packet from each to prove the fan-out is
// forwarding live media (not just negotiating transceivers).
func assertReceivesAll(t *testing.T, tc *testClient, want map[string]bool) {
	t.Helper()
	tracks := map[string]*webrtc.TrackRemote{}
	deadline := time.After(30 * time.Second)
	remaining := len(want)
	for remaining > 0 {
		select {
		case tr := <-tc.gotTrack:
			key := tr.StreamID() + ":" + tr.ID()
			if seen, expected := want[key]; expected && !seen {
				want[key] = true
				tracks[key] = tr
				remaining--
			}
		case <-deadline:
			var missing []string
			for k, seen := range want {
				if !seen {
					missing = append(missing, k)
				}
			}
			t.Fatalf("%s did not receive all expected tracks; missing %v", tc.id, missing)
		}
	}

	for key, tr := range tracks {
		buf := make([]byte, 1500)
		if err := tr.SetReadDeadline(time.Now().Add(10 * time.Second)); err != nil {
			t.Fatalf("%s set read deadline on %s: %v", tc.id, key, err)
		}
		if _, _, err := tr.Read(buf); err != nil {
			t.Fatalf("%s: no RTP forwarded on %s: %v", tc.id, key, err)
		}
	}
}

// waitForRoomTracks polls until the room's track table holds want entries. On
// timeout it reports the whole negotiation state rather than a bare deadline: the
// room's keys, both peers' signaling states, whether the client still owes an offer,
// the m-line directions of the negotiated SDP on each side, and the client's
// transceiver layout.
//
// That distinguishes the three ways this can stall, which a bare "condition not met"
// cannot. Still negotiating: a non-stable state or offerPending. Never offered: the
// track is missing from the client's own localDesc. Offered but swallowed: both
// descriptions declare the m-line yet no track reached the room — which is what a
// publish recycled onto a server-created forward m-line looks like (see publish).
func waitForRoomTracks(t *testing.T, s *SFU, slug string, want int, c *testClient) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if s.trackCount(slug) == want {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	c.server.mu.Lock()
	pending, srvState := c.offerPending, c.server.pc.SignalingState().String()
	c.server.mu.Unlock()
	sdpOf := func(d *webrtc.SessionDescription) string {
		if d == nil {
			return "(none)"
		}
		return mlineDirections(d.SDP)
	}
	t.Fatalf("after %s joined: room has %v, want %d tracks; client=%s server=%s offerPending=%v"+
		"\n  client localDesc:  %s\n  server remoteDesc: %s\n  client transceivers: %s",
		c.id, s.trackKeys(slug), want, c.pc.SignalingState(), srvState, pending,
		sdpOf(c.pc.CurrentLocalDescription()), sdpOf(c.server.pc.CurrentRemoteDescription()),
		transceiverLayout(c.pc))
}
