// Ask the browser to treat this page's audio as a two-way call ("play and record")
// rather than media playback, so on mobile the CALL volume — not the media/ringer
// volume — controls it. Only Safari/iOS 16.4+ implements navigator.audioSession;
// everywhere else this is a no-op, so desktop Chrome/Firefox are unaffected.
// Idempotent and cheap; safe to call on every join.
export function useCommunicationAudio() {
  try {
    if (navigator.audioSession) navigator.audioSession.type = "play-and-record";
  } catch {
    /* unsupported or blocked — leave the default session */
  }
}
