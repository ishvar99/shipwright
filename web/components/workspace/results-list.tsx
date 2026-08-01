"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { ResultCard } from "@/components/workspace/result-row";
import type { Location } from "@/lib/contracts";
import { useSelection } from "@/lib/results/selection";
import { ordering } from "@/lib/results/rank";

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

/** Always relevance order. The measured movement story lives inside each card's disclosure,
 * not in a toggle a customer has to decode. */
export function ResultsList({ locations, mode }: { locations: readonly Location[]; mode: string }) {
  const { symbol, select, requestFocus } = useSelection();
  const { basis, reranked, basePosition } = ordering(locations, mode);
  const { ref, reset } = useFlip([locations]);

  useEffect(reset, [locations, reset]);

  if (!locations.length) return null;
  const active = symbol ?? reranked[0]?.symbol ?? null;

  const move = (to: number) => {
    const next = reranked[Math.max(0, Math.min(reranked.length - 1, to))];
    if (!next) return;
    select(next);
    ref.current
      ?.querySelector<HTMLElement>(`[data-symbol="${CSS.escape(next.symbol)}"]`)
      ?.focus({ preventScroll: true });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    const i = reranked.findIndex((l) => l.symbol === active);
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
        move(reranked.length - 1);
        break;
      case "Enter":
        requestFocus();
        break;
      default:
        return; // leave screen-reader and browser shortcuts alone
    }
    e.preventDefault(); // clamped, not wrapping
  };

  return (
    <section className="grid gap-2">
      <h2 className="text-fg">
        Where to look
        <span className="text-subtle"> · {locations.length} places, most likely first</span>
      </h2>
      <ul
        ref={ref}
        role="listbox"
        aria-label="Places to look"
        className="sw-rows"
        onKeyDown={onKeyDown}
      >
        {reranked.map((l, i) => (
          <ResultCard
            key={l.symbol}
            location={l}
            index={i}
            total={reranked.length}
            basePosition={basePosition.get(l.symbol) ?? 0}
            basis={basis}
            selected={l.symbol === symbol}
            tabbable={l.symbol === active}
            onSelect={() => select(l)}
            onActivate={requestFocus}
          />
        ))}
      </ul>
    </section>
  );
}
