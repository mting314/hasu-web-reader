/** "m:ss.s" for a time in seconds ("--:--.-" for null). Rounds to tenths first, so 59.96 s is "1:00.0". */
export function fmt(t: number | null): string {
  if (t === null || !Number.isFinite(t)) return "--:--.-";
  const tenths = Math.round(Math.max(0, t) * 10);
  const m = Math.floor(tenths / 600);
  return `${m}:${((tenths - m * 600) / 10).toFixed(1).padStart(4, "0")}`;
}
