package sfu

// Signaler delivers server→client signaling frames (offer/answer/candidate/
// tracks). *server.wsClient satisfies it via Send(v any) bool.
type Signaler interface {
	Send(v any) bool
	// Close tears down the signaling socket. The SFU calls it when a peer's media
	// transport dies, because the two planes fail independently: the ICE/DTLS
	// transport can be gone while the WebSocket is perfectly healthy, and a peer
	// left in that state keeps its place in the roster with no media in either
	// direction and no way back — an ICE restart aimed at a peer the server has
	// already removed cannot succeed either.
	//
	// Dropping the socket hands recovery to machinery that already works: the client
	// treats it as a normal disconnect, shows "Reconnecting…", and re-joins with
	// backoff, rebuilding the peer and its negotiation from scratch.
	//
	// Implementations must be idempotent — the state-change callback can be reached
	// more than once (failed, then closed) — and must not block.
	Close()
}

// SignalerFunc adapts a function to Signaler (used by tests and simple wiring).
type SignalerFunc func(v any) bool

func (f SignalerFunc) Send(v any) bool { return f(v) }

// Close is a no-op: a bare function has no socket to tear down. Tests that need to
// observe the close use their own Signaler type.
func (f SignalerFunc) Close() {}
