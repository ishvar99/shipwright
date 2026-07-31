/**
 * Not a confidence interval. `resolutionPp` is the smallest difference a sample of n
 * can express — one task. `bandPp` widens that to the run-to-run spread actually
 * observed for identical configurations (up to two tasks at n=30).
 */
export const OBSERVED_SPREAD_TASKS = 2;

export function resolutionPp(n: number): number {
  if (n <= 0) return Infinity;
  return 100 / n;
}

export function bandPp(n: number, tasks: number = OBSERVED_SPREAD_TASKS): number {
  return resolutionPp(n) * tasks;
}

export function isWithinBand(
  deltaPp: number,
  n: number,
  tasks: number = OBSERVED_SPREAD_TASKS,
): boolean {
  return Math.abs(deltaPp) <= bandPp(n, tasks);
}

/**
 * Comparing two runs is limited by the coarser of the two: a 353-task run cannot lend its
 * resolution to a 30-task one. Using the reference's n alone would understate the band on
 * every cross-size comparison, which is the direction that flatters a result.
 */
export function pairwiseN(a: number, b: number): number {
  return Math.min(a, b);
}
