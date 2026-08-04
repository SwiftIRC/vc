// How the client must treat an inbound `error` frame.
//
// The server sends `error` in two situations that could hardly be less alike, and
// conflating them is what let one refused moderation command end a whole call:
//
//   PRE-JOIN — bad or expired token, a used invite, a ban, a wrong room password,
//     an unprovisioned room. The server's reject() drains and closes the socket
//     itself, so the connection is going away no matter what the client does; the
//     lobby is where the reason belongs.
//
//   IN-CALL — a refused moderation command, and nothing else. A kick or a ban
//     reaches its target as its own `kicked` frame, never as an `error`, so there
//     is no such thing as a terminal in-call error.
//
// The disposition therefore turns on WHERE we are, not on which code arrived. That
// is deliberate: a code-whitelist would make every future error fatal-by-default
// until someone remembered to add it, which is exactly the failure being fixed
// here. Being in a call is the thing that makes an error survivable.
//
// The failure this replaced: in-call, the client stopped the socket (suppressing
// reconnect for good) and then rendered the message on the lobby screen, which no
// longer exists once joined. So a refusal as ordinary as muting someone who had
// just left silently ended chat, the roster and all further moderation for the rest
// of the call — while media kept flowing on its own PeerConnection, so nothing
// looked wrong.

// Wording for the in-call refusals worth explaining. Anything absent falls back to
// the server's own message, which is written for a developer, not a participant —
// hence the overrides for the two a user can actually hit.
const IN_CALL_TEXT = Object.freeze({
  "not-op": "That needs op, and the server says you don't have it. Reloading will pick it back up.",
  "no-such-peer": "They already left the call.",
});

// { code, message, inCall } -> { fatal, text }.
// fatal=true means: stop the socket and show text on the lobby screen.
// fatal=false means: keep the socket, show text in the call.
export function serverErrorDisposition({ code, message, inCall } = {}) {
  if (!inCall) return { fatal: true, text: message || "Something went wrong." };
  return { fatal: false, text: IN_CALL_TEXT[code] || message || "That action was refused." };
}
