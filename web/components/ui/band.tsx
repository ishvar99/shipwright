import { bandPp, isWithinBand } from "@/lib/evals/band";
import { cn } from "@/lib/cn";

/** `n` is the PAIRWISE effective sample size for this point against the reference. */
export type BandPoint = { id: string; label: string; deltaPp: number; n?: number };

/** Plots deltas against a reference, shading the range the sample size cannot resolve. */
export function Band({
  points,
  n,
  scalePp = 20,
  className,
}: {
  points: BandPoint[];
  n: number;
  scalePp?: number;
  className?: string;
}) {
  const half = bandPp(n);
  const toPct = (pp: number) => 50 + (Math.max(-scalePp, Math.min(scalePp, pp)) / scalePp) * 50;
  const bandWidthPct = Math.min(50, (half / scalePp) * 50);

  return (
    <div className={cn("w-full", className)}>
      <div className="relative h-9 rounded-[var(--radius)] border border-hairline bg-soft">
        <div
          aria-hidden
          className="absolute inset-y-0 bg-accent-soft"
          style={{ left: `${50 - bandWidthPct}%`, width: `${bandWidthPct * 2}%` }}
        />
        <div aria-hidden className="absolute inset-y-0 left-1/2 w-px bg-hairline" />
        {points.map((p) => {
          // Judged on its own pairwise n, which is never finer than the shaded band, so a
          // hollow point always sits inside the shading.
          const inconclusive = isWithinBand(p.deltaPp, p.n ?? n);
          return (
            <span
              key={p.id}
              title={`${p.label}: ${p.deltaPp > 0 ? "+" : ""}${p.deltaPp.toFixed(1)}pp${
                inconclusive ? " — inside the resolution of this sample" : ""
              }`}
              className={cn(
                "absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border",
                inconclusive ? "border-subtle bg-transparent" : "border-transparent bg-accent",
              )}
              style={{ left: `${toPct(p.deltaPp)}%` }}
            />
          );
        })}
      </div>
      <p className="mt-1 font-mono text-[11px] tabular-nums text-subtle">
        {`shaded = what the reference (n=${n}) cannot resolve, ±${half.toFixed(1)}pp · scale ±${scalePp}pp · hollow points are inconclusive at their own comparison's sample size, which may be coarser`}
      </p>
    </div>
  );
}
