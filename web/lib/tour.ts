/**
 * The guided replay: onboarding is the product demoing itself. Steps are earned by the
 * stream, not timed — each names the section that just filled in. The order follows what a
 * replayed session actually shows: the issue is there from the start, the fix streams in
 * mid-run, and the ranked locations land when the run completes.
 */

export type TourFacts = { fixStarted: boolean; terminal: boolean };

export type TourStep = {
  /** Which section the narrator is talking about; null for the closing card. */
  target: "issue" | "fix" | "results" | null;
  title: string;
  body: string;
};

export const TOUR_STEPS: readonly TourStep[] = [
  {
    target: "issue",
    title: "A bug, in plain words",
    body: "No file paths, no stack trace — the kind of report a teammate actually files. Shipwright is tracing it through the code right now.",
  },
  {
    target: "fix",
    title: "A fix, drafted from the code it found",
    body: "It writes the change the moment it knows where — and then proves it against the tests.",
  },
  {
    target: "results",
    title: "The evidence",
    body: "Every place the bug leads to, ranked, with the reason each one made the list.",
  },
  {
    target: null,
    title: "Now point it at your code",
    body: "Import a repository — a GitHub URL or a .zip. It stays in your browser.",
  },
];

/** The furthest step the replay has earned. Facts only move forward, so this never
 * regresses; the component walks toward it one dwell at a time. */
export function tourStep(f: TourFacts): number {
  if (f.terminal) return 3;
  if (f.fixStarted) return 1;
  return 0;
}
