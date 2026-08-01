"use client";

import { useState } from "react";
import { EvidenceStrip, type Channel } from "@/components/ui/evidence-strip";
import { Icon } from "@/components/ui/icon";
import type { Location } from "@/lib/contracts";
import { cn } from "@/lib/cn";
import { matchTier, qualifiedName, rankDelta, type Basis } from "@/lib/results/rank";

/**
 * A result as a card: the answer first (symbol name), the evidence one disclosure away.
 * Movement is narrated only when it was measured — never reconstructed claims.
 */
export function ResultCard({
  location,
  index,
  total,
  basePosition,
  basis,
  top,
  selected,
  tabbable,
  onSelect,
  onActivate,
}: {
  location: Location;
  index: number;
  total: number;
  basePosition: number;
  basis: Basis;
  top: number;
  selected: boolean;
  tabbable: boolean;
  onSelect: () => void;
  onActivate: () => void;
}) {
  const [open, setOpen] = useState(false);
  const tier = matchTier(location.rank);
  const name = qualifiedName(location);
  const delta = rankDelta(basePosition, location.rank);
  const movement =
    basis === "measured" && delta.direction !== "none" && delta.direction !== "unknown"
      ? `Search ranked this #${basePosition}; analysis moved it to #${location.rank}.`
      : null;

  return (
    <li
      role="option"
      aria-selected={selected}
      tabIndex={tabbable ? 0 : -1}
      data-symbol={location.symbol}
      aria-label={`Match ${index + 1} of ${total}. ${name} in ${location.path}${
        location.start_line > 0 ? `, line ${location.start_line}` : ""
      }. ${tier.label}.`}
      className={cn("sw-result", selected && "sw-result-selected")}
      onClick={onSelect}
      onDoubleClick={onActivate}
    >
      <div aria-hidden className="flex items-start gap-3">
        <span className="pt-0.5 text-xs tabular-nums text-subtle">{index + 1}</span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <span className="min-w-0 break-words font-semibold text-fg">{name}</span>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-xs font-medium",
                tier.tier === "strong" ? "bg-ok-soft text-ok" : "bg-soft text-muted",
              )}
            >
              {tier.label}
            </span>
          </div>
          <div className="mt-0.5 flex min-w-0 items-baseline gap-2 font-mono text-xs text-subtle">
            <span className="truncate">{location.path}</span>
            {location.start_line > 0 && (
              <span className="shrink-0 rounded-full bg-soft px-1.5">line {location.start_line}</span>
            )}
          </div>
          {open && (
            <div className="mt-2 grid gap-1.5">
              <EvidenceStrip channels={location.channels as Channel[]} />
              {movement && <p className="text-xs text-subtle">{movement}</p>}
            </div>
          )}
        </div>
        <button
          type="button"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
          className="rounded p-1 text-subtle transition-colors hover:bg-soft hover:text-fg"
          title={open ? "Hide why" : "Why here?"}
        >
          <Icon name="chevron" size={14} className={cn("transition-transform", open && "rotate-90")} />
        </button>
      </div>
    </li>
  );
}
