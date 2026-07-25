// Format an elapsed-seconds count as a clock: "M:SS" normally, "H:MM:SS" once it
// reaches an hour. Negatives clamp to 0 and fractions floor, so it's safe to pass a
// raw (age + elapsed) value straight in.
export function formatDuration(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
