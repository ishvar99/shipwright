"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ResultRow } from "@/components/workspace/result-row";
import type { Location } from "@/lib/contracts";
import { firstLine } from "@/lib/errors";
import { useSelection } from "@/lib/results/selection";
import { ordering, topScore } from "@/lib/results/rank";
import { redact } from "@/lib/stream/redact";

type Order = "reranked" | "retrieval";

// The tree is prerendered, so useLayoutEffect would warn on the server; useEffect alone would
// paint the new order once before inverting, i.e. jump then slide.
const useIsoLayout = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** FLIP: measure, re-render, invert, release. Transform-only, so it never triggers layout. */
function useFlip(deps: unknown[]) {
  const ref = useRef<HTMLUListElement>(null);
  const tops = useRef<Map<string, number> | null>(null);

  useIsoLayout(() => {
    const list = ref.current;
    if (!list) return;
    const rows = [...list.querySelectorAll<HTMLElement>("[data-symbol]")];
    const next = new Map(rows.map((r) => [r.dataset.symbol!, r.offsetTop]));
    const prev = tops.current;
    tops.current = next;
    if (!prev) return; // first paint: appear, do not slide

    for (const row of rows) {
      const from = prev.get(row.dataset.symbol!);
      if (from === undefined) continue;
      const delta = from - row.offsetTop;
      if (!delta) continue;
      // Add any transform still in flight, or flipping again mid-animation jumps first.
      const current = new DOMMatrixReadOnly(getComputedStyle(row).transform).m42;
      row.style.transition = "none";
      row.style.transform = `translateY(${delta + current}px)`;
      requestAnimationFrame(() => {
        row.style.transition = "transform 260ms var(--ease-out-quart)";
        row.style.transform = "";
      });
    }
  }, deps);

  const reset = () => {
    tops.current = null;
  };
  return { ref, reset };
}

export function ResultsList({
  locations,
  mode,
  jobError,
  queued,
  running,
}: {
  locations: readonly Location[];
  mode: string;
  jobError: string | null;
  queued: boolean;
  running: boolean;
}) {
  const [order, setOrder] = useState<Order>("reranked");
  const { symbol, select, requestFocus } = useSelection();
  const { basis, retrieval, reranked, basePosition, movedCount } = ordering(locations, mode);
  const rows = order === "reranked" ? reranked : retrieval;
  const top = topScore(locations);
  const { ref, reset } = useFlip([order, locations]);

  // A new job's rows must not slide in from the previous job's geometry.
  useEffect(reset, [locations, reset]);

  const active = symbol ?? rows[0]?.symbol ?? null;

  const move = (to: number) => {
    const next = rows[Math.max(0, Math.min(rows.length - 1, to))];
    if (!next) return;
    select(next);
    ref.current
      ?.querySelector<HTMLElement>(`[data-symbol="${CSS.escape(next.symbol)}"]`)
      ?.focus({ preventScroll: true });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    const i = rows.findIndex((l) => l.symbol === active);
    switch (e.key) {
      case "ArrowDown":
        move(i + 1);
        break;
      case "ArrowUp":
        move(i - 1);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(rows.length - 1);
        break;
      case "Enter":
        requestFocus();
        break;
      default:
        return; // leave screen-reader and browser shortcuts alone
    }
    // Clamped, not wrapping: wrapping would yank the code pane from the worst hit to the best
    // with no visible cause.
    e.preventDefault();
  };

  if (jobError) {
    return (
      <p className="p-gutter text-evidence-path" role="status">
        {firstLine(redact(jobError))}
      </p>
    );
  }
  if (queued) {
    return (
      <p className="p-gutter text-subtle" role="status">
        Waiting for a worker. Two jobs run at a time; queue position is not reported.
      </p>
    );
  }
  if (!locations.length) {
    return (
      <p className="p-gutter text-subtle" role="status">
        {running ? "Searching…" : "No locations found for this issue."}
      </p>
    );
  }

  return (
    <div className="sw-results">
      <header className="sw-results-head">
        <span className="text-subtle">
          {locations.length} location{locations.length === 1 ? "" : "s"}
        </span>

        {basis === "identity" ? (
          <span className="text-subtle">
            This run did not rerank — retrieval order is the result order.
          </span>
        ) : (
          <span role="group" aria-label="Result order" className="flex items-center gap-gutter">
            {(["reranked", "retrieval"] as const).map((o) => (
              <label key={o} className="flex items-center gap-1">
                <input
                  type="radio"
                  name="order"
                  checked={order === o}
                  onChange={() => setOrder(o)}
                />
                <span>{o === "reranked" ? "reranked order" : "retrieval order"}</span>
              </label>
            ))}
            <span className="text-subtle">{movedCount} of {locations.length} moved</span>
          </span>
        )}
      </header>

      {basis === "relative" && (
        // Stated once, visibly, not in a title: reconstructed movement is a lower bound on gains
        // and can invert on losses.
        <p className="sw-caveat">
          Movement is compared only within the ten shown. This run did not record retrieval
          positions, so gains may be understated.
        </p>
      )}

      <ul
        ref={ref}
        role="listbox"
        aria-label="Ranked locations"
        className="sw-rows"
        onKeyDown={onKeyDown}
      >
        {rows.map((l) => (
          <ResultRow
            key={l.symbol}
            location={l}
            basePosition={basePosition.get(l.symbol) ?? 0}
            basis={basis}
            top={top}
            selected={l.symbol === symbol}
            tabbable={l.symbol === active}
            onSelect={() => select(l)}
            onActivate={requestFocus}
          />
        ))}
      </ul>
    </div>
  );
}
