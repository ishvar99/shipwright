"use client";

import { useMemo, useRef, useState } from "react";
import { fuzzyRank } from "@/lib/repo-fuzzy";
import { cn } from "@/lib/cn";

/** Cmd+P. Empty query lists what you had open, the way every editor does. */
export function QuickOpen({
  paths,
  recent,
  onPick,
  onClose,
}: {
  paths: string[];
  recent: string[];
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // Focus goes back where it came from when the dialog closes.
  const opener = useRef<Element | null>(typeof document === "undefined" ? null : document.activeElement);
  const dismiss = () => {
    onClose();
    (opener.current as HTMLElement | null)?.focus?.();
  };

  const results = useMemo(
    () => (query.trim() ? fuzzyRank(query, paths, 40) : recent.slice(0, 40).map((p) => ({ path: p, score: 0, hits: [] }))),
    [query, paths, recent],
  );

  // Reset the highlight when the query changes — adjusted during render rather than in an
  // effect, which would render the stale selection first.
  const [lastQuery, setLastQuery] = useState(query);
  if (query !== lastQuery) {
    setLastQuery(query);
    setIndex(0);
  }

  return (
    <div className="sw-quickopen-backdrop" onClick={dismiss}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Go to file"
        className="sw-quickopen"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // Escape must work wherever focus is inside the dialog, and Tab must not escape it:
          // there is one focusable child, so keeping focus there is the whole trap.
          if (e.key === "Escape") {
            e.preventDefault();
            dismiss();
          }
          if (e.key === "Tab") {
            e.preventDefault();
            inputRef.current?.focus();
          }
        }}
      >
        <input
          ref={inputRef}
          autoFocus
          role="combobox"
          aria-expanded
          aria-controls="sw-quickopen-list"
          aria-autocomplete="list"
          aria-activedescendant={results[index] ? `qo-${index}` : undefined}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => Math.min(i + 1, results.length - 1));
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => Math.max(i - 1, 0));
            }
            if (e.key === "Enter" && results[index]) onPick(results[index].path);
          }}
          placeholder="Go to file…"
          aria-label="Go to file"
          className="sw-quickopen-input"
        />
        <ul id="sw-quickopen-list" role="listbox" aria-label="Files" className="sw-quickopen-list">
          {!results.length && <li className="px-3 py-2 text-subtle">No matching file.</li>}
          {results.map((r, i) => {
            const cut = r.path.lastIndexOf("/");
            return (
              <li
                key={r.path}
                id={`qo-${i}`}
                role="option"
                aria-selected={i === index}
                ref={i === index ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
                onMouseEnter={() => setIndex(i)}
                onClick={() => onPick(r.path)}
                className={cn("sw-quickopen-item", i === index && "sw-quickopen-item-active")}
              >
                <span className="font-medium text-fg">{r.path.slice(cut + 1)}</span>
                {cut > 0 && <span className="truncate text-xs text-subtle">{r.path.slice(0, cut)}</span>}
              </li>
            );
          })}
        </ul>
        {!query && <p className="sw-quickopen-hint">Recently opened</p>}
      </div>
    </div>
  );
}
