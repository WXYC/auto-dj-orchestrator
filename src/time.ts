/** Time helpers. Isolated so callers inject `now` and the pure core never reads the clock. */

const MS_PER_HOUR = 3_600_000;

/** Epoch-hour index used for breakpoint scheduling (top-of-hour buckets). */
export function epochHour(nowMs: number): number {
  return Math.floor(nowMs / MS_PER_HOUR);
}
