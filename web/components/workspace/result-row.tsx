"use client";

import { EvidenceStrip, type Channel } from "@/components/ui/evidence-strip";
import { RankDelta } from "@/components/ui/rank-delta";
import { ScoreBar } from "@/components/ui/score-bar";
import type { Location } from "@/lib/contracts";
import { cn } from "@/lib/cn";
import { qualifiedName, rankDelta, type Basis } from "@/lib/results/rank";

/** Authored, not read from the contents. Left to itself the row announces five clauses with the
 * identifying field fourth, repeated on every arrow press. */
function label(loc: Location, basePosition: number, basis: Basis, pct: number): string {
  const { direction, magnitude } = rankDelta(basePosition, loc.rank);
  const movement =
    basis === "identity" || direction === "none"
      ? "same position in retrieval order"
      : direction === "unknown"
        ? "retrieval position not recorded"
        : `${magnitude} place${magnitude === 1 ? "" : "s"} ${direction === "up" ? "higher" : "lower"} than in retrieval order`;
  const line = loc.start_line > 0 ? `Line ${loc.start_line}. ` : "";
  return `${qualifiedName(loc)}, ${loc.path}. ${line}${movement}. Score ${pct} percent of the strongest here.`;
}

export function ResultRow({
  location,
  basePosition,
  basis,
  top,
  selected,
  tabbable,
  onSelect,
  onActivate,
}: {
  location: Location;
  basePosition: number;
  basis: Basis;
  top: number;
  selected: boolean;
  tabbable: boolean;
  onSelect: () => void;
  onActivate: () => void;
}) {
  const pct = top > 0 ? Math.round((location.score / top) * 100) : 0;
  const symbol = qualifiedName(location);
  const dir = location.path.includes("/") ? location.path.slice(0, location.path.lastIndexOf("/") + 1) : "";
  const file = location.path.slice(dir.length);

  return (
    <li
      role="option"
      aria-selected={selected}
      tabIndex={tabbable ? 0 : -1}
      data-symbol={location.symbol}
      aria-label={label(location, basePosition, basis, pct)}
      className={cn("sw-row", selected && "sw-row-selected")}
      onClick={onSelect}
      onDoubleClick={onActivate}
    >
      {/* One aria-hidden wrapper: the name above is the row's whole announcement, but DOM order
          still matches visual order, so there is no reading-order mismatch. */}
      <span aria-hidden className="contents">
        {basis !== "identity" && (
          <RankDelta basePosition={basePosition} finalPosition={location.rank} />
        )}
        <EvidenceStrip channels={location.channels as Channel[]} />
        {/* Leading ellipsis on the directory: the identifying part of a path is its tail. */}
        <span className="sw-path">
          <span className="sw-dir">{dir}</span>
          <span className="sw-file">{file}</span>
          <span className="sw-sym">{symbol}</span>
        </span>
        <ScoreBar score={location.score} top={top} className="sw-bar" />
        <span className="sw-line">{location.start_line > 0 ? `L${location.start_line}` : "—"}</span>
      </span>
    </li>
  );
}
