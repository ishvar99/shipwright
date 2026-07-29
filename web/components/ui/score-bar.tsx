import { cn } from "@/lib/cn";

// RRF scores are 1/(60+rank); the absolute value leaks an implementation detail,
// so only magnitude relative to the top hit is shown.
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
      title={`${pct}% of the top result's score`}
    >
      <span className="sr-only">{`Relative score ${pct} percent of top result`}</span>
      <span
        aria-hidden
        className="block h-full rounded-full bg-accent"
        style={{ width: `${pct}%` }}
      />
    </span>
  );
}
