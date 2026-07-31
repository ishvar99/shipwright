import { cn } from "@/lib/cn";

// RRF scores are 1/(60+rank); the absolute value leaks an implementation detail, so only
// relative magnitude is shown. `top` must be max(score) over the set, NOT the first row's
// score: `score` is the RETRIEVAL score and the reranked first row is usually not the
// strongest one, so normalising to it clamps several bars to full and hides the override.
export function ScoreBar({
  score,
  top,
  className,
}: {
  score: number;
  top: number;
  className?: string;
}) {
  const ratio = top > 0 ? Math.max(0, Math.min(1, score / top)) : 0;
  const pct = Math.round(ratio * 100);
  return (
    <span
      className={cn("inline-block h-1.5 w-20 overflow-hidden rounded-full bg-hairline", className)}
      title={`${pct}% of the strongest retrieval score here`}
    >
      <span className="sr-only">{`Relative retrieval score ${pct} percent of the strongest here`}</span>
      <span
        aria-hidden
        className="block h-full rounded-full bg-accent"
        style={{ width: `${pct}%` }}
      />
    </span>
  );
}
