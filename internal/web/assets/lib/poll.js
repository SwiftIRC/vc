// Poll tally maths, kept pure (no DOM) so it can be unit-tested under node --test,
// like lib/presence.js and lib/duration.js.

// Total votes cast. Non-numeric entries count as zero rather than poisoning the sum
// with NaN — the tallies come off the wire.
export function totalVotes(tallies) {
  let n = 0;
  for (const t of tallies || []) n += Number(t) || 0;
  return n;
}

// Whole-number percentages that sum to EXACTLY 100 whenever any vote exists, by
// largest remainder: floor every share, then hand the leftover points to the options
// with the largest fractional parts (ties broken by order, so the result is stable
// across renders). Rounding each share independently drifts to 99 or 101, which shows
// up as a row of bars that doesn't fill — or overflows — the card.
export function tallyPercents(tallies) {
  const counts = (tallies || []).map((t) => Number(t) || 0);
  const total = counts.reduce((a, b) => a + b, 0);
  if (total <= 0) return counts.map(() => 0);

  const exact = counts.map((c) => (c * 100) / total);
  const out = exact.map((v) => Math.floor(v));
  let spare = 100 - out.reduce((a, b) => a + b, 0);
  const byRemainder = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < byRemainder.length && spare > 0; k++, spare--) out[byRemainder[k].i]++;
  return out;
}
