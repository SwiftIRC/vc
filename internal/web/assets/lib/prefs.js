// Persisted media join preferences so the next visit's lobby (and the call) default to
// however the user last left them:
//   - mic / camera / ns  booleans — the mic/camera/noise-suppression on-off state.
//   - micId / cameraId   deviceId strings — the last input device explicitly selected.
//   - speakerId          deviceId string — the last audio-OUTPUT device explicitly selected.
// An ABSENT key means "no saved preference", i.e. use the app default (boolean consumers
// test `=== false` / `!== false`, never truthiness of a maybe-undefined key; a saved
// deviceId is applied as an `ideal` constraint so a since-removed device still falls back
// to the default). All localStorage access is guarded: it throws in private mode or when
// storage is off.
const KEY = "swiftirc-vc-media";

export function loadMediaPrefs() {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// Merge a partial update ({ mic?, camera?, ns?, micId?, cameraId? }) into the stored
// preferences, so a caller that only knows about one field doesn't clobber the others.
export function saveMediaPrefs(update) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...loadMediaPrefs(), ...update }));
  } catch {
    /* storage unavailable — ignore */
  }
}

// View/layout preferences (e.g. { columns: 2|3|4|null }), stored separately from the
// media prefs so the two never clobber each other. Same guarded-JSON contract.
const LAYOUT_KEY = "swiftirc-vc-layout";

export function loadLayoutPrefs() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function saveLayoutPrefs(update) {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ ...loadLayoutPrefs(), ...update }));
  } catch {
    /* storage unavailable — ignore */
  }
}

// The typed display name, persisted across visits (shared by the lobby and the in-call
// rename). localStorage can throw (private mode / storage off), so guard it.
const NAME_KEY = "swiftirc-vc-name";
export function loadName() {
  try {
    return localStorage.getItem(NAME_KEY) || "";
  } catch {
    return "";
  }
}
export function saveName(name) {
  try {
    if (name) localStorage.setItem(NAME_KEY, name);
  } catch {
    /* storage unavailable — ignore */
  }
}
