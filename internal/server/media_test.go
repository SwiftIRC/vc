package server

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/pion/interceptor"
	"github.com/pion/webrtc/v4"
)

// clientAPI builds a browser-like client WebRTC API (default codecs +
// interceptors), independent of the server's constrained MediaEngine.
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

// wsMediaClient is a synthetic browser peer that drives WebRTC signaling through
// the Hub's REAL WebSocket (offer/answer/candidate frames), exercising the full
// Hub<->SFU wiring rather than calling sfu.Peer methods directly.
type wsMediaClient struct {
	t    *testing.T
	conn *websocket.Conn
	pc   *webrtc.PeerConnection
	wmu  sync.Mutex // serializes writes to conn (coder/websocket wants one writer)
}

func (mc *wsMediaClient) writeJSON(v any) {
	mc.wmu.Lock()
	defer mc.wmu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := wsjson.Write(ctx, mc.conn, v); err != nil {
		mc.t.Logf("writeJSON: %v", err)
	}
}

// readLoop routes every server->client frame to the client PeerConnection until
// ctx is cancelled or the socket closes. The client publishes non-trickle (its
// candidates ride in the offer SDP), so it only ingests the server's answer and
// trickled candidates here; the offer case is handled defensively in case the
// server renegotiates.
func (mc *wsMediaClient) readLoop(ctx context.Context) {
	for {
		typ, data, err := mc.conn.Read(ctx)
		if err != nil {
			return
		}
		if typ != websocket.MessageText {
			continue
		}
		var env struct {
			Type      string          `json:"type"`
			SDP       string          `json:"sdp"`
			Candidate json.RawMessage `json:"candidate"`
		}
		if json.Unmarshal(data, &env) != nil {
			continue
		}
		switch env.Type {
		case "answer":
			if err := mc.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: env.SDP}); err != nil {
				mc.t.Logf("set remote answer: %v", err)
			}
		case "offer":
			if err := mc.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: env.SDP}); err != nil {
				continue
			}
			ans, err := mc.pc.CreateAnswer(nil)
			if err != nil {
				continue
			}
			if err := mc.pc.SetLocalDescription(ans); err != nil {
				continue
			}
			mc.writeJSON(map[string]any{"type": "answer", "sdp": ans.SDP})
		case "candidate":
			var init webrtc.ICECandidateInit
			if json.Unmarshal(env.Candidate, &init) == nil {
				_ = mc.pc.AddICECandidate(init)
			}
		}
	}
}

// TestHubSFUConnectsOverWebSocket proves the Hub<->SFU wiring end to end over the
// real signaling path: a client joins a room via WebSocket, publishes a track,
// and drives offer/answer/candidate THROUGH the socket until its PeerConnection
// reaches Connected. This can only happen if serve() routed the offer to
// sfu.Peer.HandleOffer, streamed the SFU's answer + ICE candidates back over the
// socket, and fed the client's candidates into HandleCandidate.
func TestHubSFUConnectsOverWebSocket(t *testing.T) {
	_, srv := newTestHub(t, "", true)

	conn := dialRoom(t, srv, "media")
	send(t, conn, map[string]any{"type": "join", "name": "publisher"})
	recv(t, conn, "joined") // drain the join ack before the async read loop starts

	pc, err := clientAPI(t).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pc.Close() })

	mc := &wsMediaClient{t: t, conn: conn, pc: pc}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go mc.readLoop(ctx)

	// Publish a camera track. Browser contract: kind travels in the MSID stream id
	// (the 3rd arg), mirroring pc.addTransceiver(track, {streamIds:[kind]}); the
	// track id is opaque and ignored by the SFU (MediaStreamTrack.id is read-only).
	track, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8}, "track", "camera")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pc.AddTrack(track); err != nil {
		t.Fatal(err)
	}

	// Create the offer and gather fully (non-trickle) so the client's candidates
	// travel inside the offer SDP; then send a single offer frame over the socket.
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gatherComplete := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	select {
	case <-gatherComplete:
	case <-time.After(5 * time.Second):
		t.Fatal("client ICE gathering did not complete")
	}
	mc.writeJSON(map[string]any{"type": "offer", "sdp": pc.LocalDescription().SDP})

	// The wiring is proven once the client PC reaches Connected: the SFU answered
	// and both sides exchanged ICE through the Hub's WebSocket.
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if pc.ConnectionState() == webrtc.PeerConnectionStateConnected {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("client PC never reached Connected (state %v)", pc.ConnectionState())
}
