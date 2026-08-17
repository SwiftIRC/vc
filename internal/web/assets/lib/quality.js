// Session video-quality tiers, set by an op and applied by every client to its own
// camera / screenshare senders (scaleResolutionDownBy + maxFramerate). height 0 / fps 0
// means "no cap" (Auto). The id is what travels on the wire; the numbers stay client-side.
export const QUALITY_TIERS = [
  { id: "auto", label: "Auto", height: 0, fps: 0 },
  { id: "ultra", label: "Ultra — 1080p·30", height: 1080, fps: 30 },
  { id: "fast", label: "Fast — 720p·60", height: 720, fps: 60 },
  { id: "high", label: "High — 720p·30", height: 720, fps: 30 },
  { id: "medium", label: "Medium — 480p·24", height: 480, fps: 24 },
  { id: "low", label: "Low — 360p·15", height: 360, fps: 15 },
];

// Look up a tier by id; an unknown/empty id (including the server's default "") is Auto.
export function qualityTier(id) {
  return QUALITY_TIERS.find((t) => t.id === id) || QUALITY_TIERS[0];
}

// The RTCRtpEncodingParameters a tier implies for a source of `sourceHeight`
// pixels: {scaleResolutionDownBy, maxFramerate}. maxFramerate is undefined when the
// tier imposes no limit, because the caller must DELETE the key rather than set 0 —
// a maxFramerate of 0 is a request for no frames at all.
//
// scaleResolutionDownBy is a divisor applied to the source, not a target height, so
// it can only be computed from what the camera is actually producing. Two rules
// follow, and both are load-bearing:
//
//   Never below 1. Browsers reject or ignore an upscale, and a 480p camera asked
//   for 1080p has nothing to give — the divisor is 1 and the picture stays 480p.
//
//   An unknown source height caps the FRAMERATE anyway. The published camera track
//   is a canvas capture whenever a background effect runs, and a canvas track need
//   not report dimensions; abandoning both caps because one input is missing is
//   what makes a tier change look like it did nothing at all.
export function encodingCaps(tier, sourceHeight) {
  const h = Number(sourceHeight);
  const caps = { scaleResolutionDownBy: 1 };
  if (tier && tier.height > 0 && Number.isFinite(h) && h > 0) {
    caps.scaleResolutionDownBy = Math.max(1, h / tier.height);
  }
  if (tier && tier.fps > 0) caps.maxFramerate = tier.fps;
  return caps;
}
