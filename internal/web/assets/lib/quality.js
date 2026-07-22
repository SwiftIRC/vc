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
