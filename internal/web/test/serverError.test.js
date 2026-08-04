import { test } from "node:test";
import assert from "node:assert/strict";
import { serverErrorDisposition } from "../assets/lib/serverError.js";

// The invariant this file exists to pin: an error that arrives WHILE IN A CALL is
// never terminal. Treating one as terminal is what let a single refused moderation
// command stop the socket for good — permanently ending chat, the roster and all
// further moderation, with no message shown, while media kept flowing so the call
// still looked healthy.
test("an in-call error is never fatal, whatever its code", () => {
  for (const code of ["not-op", "no-such-peer", "error", "", undefined, "something-new"]) {
    const d = serverErrorDisposition({ code, message: "m", inCall: true });
    assert.equal(d.fatal, false, `code ${code} was treated as fatal in-call`);
  }
});

// Pre-join is the opposite: the server's reject() drains and closes the socket
// itself, so the connection is going away regardless and the lobby must say why.
test("a pre-join error is fatal", () => {
  for (const code of ["token-invalid", "token-expired", "banned", "bad-password", "not-provisioned"]) {
    const d = serverErrorDisposition({ code, message: "m", inCall: false });
    assert.equal(d.fatal, true, `code ${code} was not treated as fatal pre-join`);
  }
});

test("known in-call codes get their own wording", () => {
  const notOp = serverErrorDisposition({ code: "not-op", message: "room: not op", inCall: true });
  assert.match(notOp.text, /op/i);
  assert.notEqual(notOp.text, "room: not op", "the raw server string was shown verbatim");

  const gone = serverErrorDisposition({ code: "no-such-peer", message: "room: no such peer", inCall: true });
  assert.match(gone.text, /left/i);
});

test("an unknown in-call code falls back to the server's message, then to a default", () => {
  assert.equal(
    serverErrorDisposition({ code: "brand-new", message: "something specific", inCall: true }).text,
    "something specific",
  );
  const bare = serverErrorDisposition({ code: "brand-new", inCall: true });
  assert.ok(bare.text.length > 0, "an error with no message must still say something");
});

test("a pre-join error keeps the server's own message", () => {
  assert.equal(
    serverErrorDisposition({ code: "token-expired", message: "token expired; run !vc again", inCall: false }).text,
    "token expired; run !vc again",
  );
});

test("a call with no arguments does not throw", () => {
  const d = serverErrorDisposition();
  assert.equal(d.fatal, true); // absent inCall means we are not in a call
  assert.ok(d.text.length > 0);
});
