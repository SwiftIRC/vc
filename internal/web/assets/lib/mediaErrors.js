// Turning a getUserMedia failure into something the person in front of the browser
// can act on.
//
// getUserMedia already distinguishes the cases that matter — the device is busy,
// permission is blocked, there is no such device — by DOMException name. The
// problem was never a lack of information: media.js caught these and returned null,
// so a camera that would not start produced no message, no console line, and no
// clue. This exists so that name reaches the user as a sentence.
//
// "Your camera didn't work" is useless. "Another app is using it" tells someone to
// close Zoom; "permission is blocked" tells them to look at the address bar. That
// difference is the whole point of the mapping.

// DOMException name -> how to phrase it. `%s` is the device name, so one table
// serves the camera and the microphone.
const BY_NAME = Object.freeze({
  // The device exists and is permitted, but something else holds it. Overwhelmingly
  // the most common real-world failure, and the most actionable.
  NotReadableError: "Your %s is in use by another app. Close anything else using it (Zoom, Teams, OBS) and try again.",
  TrackStartError: "Your %s is in use by another app. Close anything else using it (Zoom, Teams, OBS) and try again.",
  // Blocked, either just now or remembered from a previous visit.
  NotAllowedError: "Permission to use your %s is blocked. Allow it from the icon in the address bar, then reload.",
  PermissionDeniedError: "Permission to use your %s is blocked. Allow it from the icon in the address bar, then reload.",
  // Nothing to open.
  NotFoundError: "No %s was found on this device.",
  DevicesNotFoundError: "No %s was found on this device.",
  // The saved device is applied as an `ideal` constraint, so this should be rare;
  // when it happens the fix is to pick a different one.
  OverconstrainedError: "Your saved %s is unavailable. Pick a different one from the dropdown.",
  ConstraintNotSatisfiedError: "Your saved %s is unavailable. Pick a different one from the dropdown.",
  // The page is not in a state where capture is allowed at all (rare: a detached
  // document, or an insecure context that got this far).
  AbortError: "Your %s could not be started. Reloading the page usually clears this.",
  SecurityError: "Your %s is blocked by the browser's security settings on this page.",
});

const FALLBACK = "Your %s could not be started.";

// deviceErrorText(kind, errName) -> a sentence naming the device and what to do.
// kind is the human word ("camera", "microphone"). An unknown or missing name still
// produces a usable sentence: a blank error label reads as "nothing is wrong",
// which is the opposite of the truth whenever this is called.
export function deviceErrorText(kind, errName) {
  const device = kind || "device";
  const template = (errName && BY_NAME[errName]) || FALLBACK;
  return template.replaceAll("%s", device);
}
