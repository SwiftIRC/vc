package sfu

// Signaler delivers server→client signaling frames (offer/answer/candidate/
// tracks). *server.wsClient satisfies it via Send(v any) bool.
type Signaler interface {
	Send(v any) bool
}

// SignalerFunc adapts a function to Signaler (used by tests and simple wiring).
type SignalerFunc func(v any) bool

func (f SignalerFunc) Send(v any) bool { return f(v) }
