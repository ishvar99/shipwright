import { cn } from "@/lib/cn";
import { rankDelta } from "@/lib/results/rank";

const GLYPH = { up: "▲", down: "▼", none: "—", new: "+" } as const;

export function RankDelta({
  retrievalIndex,
  finalIndex,
  className,
}: {
  retrievalIndex: number;
  finalIndex: number;
  className?: string;
}) {
  const { direction, magnitude } = rankDelta(retrievalIndex, finalIndex);
  const label =
    direction === "none"
      ? "unchanged by reranking"
      : direction === "new"
        ? "added by reranking"
        : `moved ${direction} ${magnitude} place${magnitude === 1 ? "" : "s"}`;

  return (
    <span
      className={cn(
        "inline-flex w-9 items-center gap-0.5 font-mono text-[11px] tabular-nums",
        direction === "up" && "text-evidence-dense",
        direction === "down" && "text-evidence-path",
        (direction === "none" || direction === "new") && "text-subtle",
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
