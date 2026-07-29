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
