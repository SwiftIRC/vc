import { test } from "node:test";
import assert from "node:assert/strict";
import { deviceErrorText } from "../assets/lib/mediaErrors.js";

// The distinctions that matter are the ones a user can act on. "Your camera didn't
// work" is useless; "another app is using it" tells them to close Zoom, and
// "permission is blocked" tells them to look at the address bar. getUserMedia
// already separates these by DOMException name — the failure was throwing that
// name away, not lacking it.
test("each getUserMedia failure maps to something the user can act on", () => {
  const inUse = deviceErrorText("camera", "NotReadableError");
  assert.match(inUse, /another app|in use/i, `got: ${inUse}`);

  const denied = deviceErrorText("camera", "NotAllowedError");
  assert.match(denied, /permission|blocked|allow/i, `got: ${denied}`);

  const missing = deviceErrorText("camera", "NotFoundError");
  assert.match(missing, /no camera|not found|couldn't find/i, `got: ${missing}`);
});

// The saved deviceId is applied as `ideal`, so this should be rare — but a browser
// that treats it as exact, or a constraint set the device cannot satisfy, lands
// here and the fix is to pick a different device.
test("an unsatisfiable constraint points at the device picker", () => {
  assert.match(deviceErrorText("camera", "OverconstrainedError"), /another|different|picker|select/i);
});

// The kind is named in the text, because a user reading it in the lobby is looking
// at two devices and needs to know which one failed.
test("the text names the device that failed", () => {
  assert.match(deviceErrorText("camera", "NotReadableError"), /camera/i);
  assert.match(deviceErrorText("microphone", "NotReadableError"), /microphone/i);
});

// An unknown or absent name must still produce a usable sentence rather than
// "undefined" or an empty string — a blank error label reads as "nothing is wrong".
test("an unrecognised failure still says something", () => {
  for (const name of ["SomeFutureError", "", null, undefined]) {
    const text = deviceErrorText("camera", name);
    assert.ok(text && text.length > 0, `empty text for ${JSON.stringify(name)}`);
    assert.ok(!/undefined|null/.test(text), `leaked a placeholder: ${text}`);
    assert.match(text, /camera/i);
  }
});

// Every message has to stand on its own in the lobby, with no console open.
test("no message is a bare error code", () => {
  for (const name of ["NotReadableError", "NotAllowedError", "NotFoundError", "OverconstrainedError", "Whatever"]) {
    const text = deviceErrorText("camera", name);
    assert.ok(!text.includes("Error"), `surfaced a raw DOMException name: ${text}`);
    assert.ok(text.length > 15, `too terse to act on: ${text}`);
  }
});
