// Persisted media join preferences — mic / camera / noise-suppression on-off — so the
// next visit's lobby (and the call) default to however the user last left them. Values
// are booleans; an ABSENT key means "no saved preference", i.e. use the app default
// (consumers test `=== false` / `!== false`, never truthiness of a maybe-undefined key).
// All localStorage access is guarded: it throws in private mode or when storage is off.
const KEY = "swiftirc-vc-media";

export function loadMediaPrefs() {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// Merge a partial update ({ mic?, camera?, ns? }) into the stored preferences, so a
// caller that only knows about the mic doesn't clobber the saved camera/ns choice.
export function saveMediaPrefs(update) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...loadMediaPrefs(), ...update }));
  } catch {
    /* storage unavailable — ignore */
  }
}
