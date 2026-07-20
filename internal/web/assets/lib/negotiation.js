// Polite perfect-negotiation decisions (pure). The client is always polite:
// on an offer collision it rolls back its own offer, then answers the peer's.
// The server is impolite and keeps its offer, so this convergence is required.
export const POLITE = true;

export function handleRemoteOffer(state) {
  const collision = state.makingOffer || state.signalingState !== "stable";
  if (collision) return { action: "rollback-then-answer" };
  return { action: "answer" };
}
