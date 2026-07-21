// Pure reconnect backoff: geometric growth capped at max. No jitter here (the
// caller adds jitter) so this is deterministic and testable.
export function backoffDelay(attempt, { base = 500, max = 10000, factor = 2 } = {}) {
  const d = base * Math.pow(factor, attempt);
  return Math.min(d, max);
}
