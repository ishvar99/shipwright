import { cn } from "@/lib/cn";
import { rankDelta } from "@/lib/results/rank";

const GLYPH = { up: "▲", down: "▼", none: "—", unknown: "·" } as const;

/**
 * Positions are 1-based ranks. The hue does not encode direction — the glyph does — because
 * this sits 30px from the EvidenceStrip, whose four colours mean retrieval channels; reusing
 * those hues for movement would make one palette mean two things in the same row.
 */
export function RankDelta({
  basePosition,
  finalPosition,
  className,
}: {
  basePosition: number;
  finalPosition: number;
  className?: string;
}) {
  const { direction, magnitude } = rankDelta(basePosition, finalPosition);
  // Stated as a comparison between two orders, not as a claim that something moved: nothing
  // is animated here, and "moved" would over-claim when the basis is reconstructed.
  const label =
    direction === "none"
      ? "same position in retrieval order"
      : direction === "unknown"
        ? "retrieval position not recorded"
        : `${magnitude} place${magnitude === 1 ? "" : "s"} ${direction === "up" ? "higher" : "lower"} than in retrieval order`;

  return (
    <span
      className={cn(
        "inline-flex w-9 items-center gap-0.5 font-mono text-[11px] tabular-nums",
        direction === "up" || direction === "down" ? "text-muted" : "text-subtle",
        className,
      )}
      title={label}
    >
      <span className="sr-only">{label}</span>
      <span aria-hidden>{GLYPH[direction]}</span>
      <span aria-hidden>{magnitude > 0 ? magnitude : ""}</span>
    </span>
  );
}
