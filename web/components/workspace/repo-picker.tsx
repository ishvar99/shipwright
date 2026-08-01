"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { StatusDot } from "@/components/ui/status-dot";
import { cn } from "@/lib/cn";
import type { Repo } from "@/lib/contracts";
import { repoDisplayName } from "@/lib/repo-name";

const STATUS: Record<string, string> = { importing: "importing", failed: "import failed" };

/** Above a handful of repositories a chip row becomes a wall of pills in API order. This is the
 * same interaction grammar as quick-open — type to filter, arrows, Enter, Escape — over repos. */
export function RepoPicker({
  repos,
  repo,
  onPick,
  block = false,
}: {
  repos: Repo[];
  repo: Repo | null;
  onPick: (repo: Repo) => void;
  /** Fills its container instead of hugging its label — the sidebar switcher spans the rail. */
  block?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  // Ready first: a repo you cannot run against should not sit at the top of the list.
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return repos
      .filter((r) => !q || r.slug.toLowerCase().includes(q))
      .sort((a, b) => Number(b.status === "ready") - Number(a.status === "ready"));
  }, [repos, query]);

  const [lastQuery, setLastQuery] = useState(query);
  if (query !== lastQuery) {
    setLastQuery(query);
    setIndex(0);
  }

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const choose = (r: Repo) => {
    onPick(r);
    setOpen(false);
    setQuery("");
  };

  return (
    <div ref={box} className={cn("relative", block ? "w-full" : "justify-self-start")}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className={cn("sw-repo-trigger", block && "w-full")}
      >
        {repo && repo.status !== "ready" && (
          <StatusDot tone={repo.status === "failed" ? "bad" : "active"} />
        )}
        <span className="sw-truncate">
          {repo ? repoDisplayName(repo.slug) : "Choose a repository"}
        </span>
        <Icon
          name="chevron"
          size={12}
          className={cn("shrink-0 text-subtle", block && "ml-auto", open && "rotate-90")}
        />
      </button>

      {open && (
        <div className="sw-repo-popover">
          <input
            autoFocus
            role="combobox"
            aria-expanded
            aria-controls="sw-repo-list"
            aria-autocomplete="list"
            aria-activedescendant={matches[index] ? `sw-repo-opt-${index}` : undefined}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setOpen(false);
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIndex((i) => Math.min(i + 1, matches.length - 1));
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setIndex((i) => Math.max(i - 1, 0));
              }
              // Always swallowed: this input sits inside the composer's form, so a fall-through
              // Enter submitted it and started a session.
              if (e.key === "Enter") {
                e.preventDefault();
                if (matches[index]) choose(matches[index]);
              }
            }}
            placeholder="Filter repositories"
            aria-label="Filter repositories"
            className="sw-repo-filter"
          />
          <ul id="sw-repo-list" role="listbox" aria-label="Repositories" className="sw-repo-list">
            {!matches.length && <li className="px-3 py-2 text-subtle">No repository matches.</li>}
            {matches.map((r, i) => (
              <li
                key={r.id}
                id={`sw-repo-opt-${i}`}
                role="option"
                aria-selected={i === index}
                onMouseEnter={() => setIndex(i)}
                onClick={() => choose(r)}
                className={cn("sw-repo-option", i === index && "sw-repo-option-active")}
              >
                {r.id === repo?.id ? (
                  <Icon name="check" size={12} className="shrink-0 text-accent" />
                ) : (
                  <span aria-hidden className="w-3 shrink-0" />
                )}
                <span className="sw-truncate text-fg">{repoDisplayName(r.slug)}</span>
                {/* A word, not only a coloured dot: importing and failed differ in kind. */}
                {STATUS[r.status] && (
                  <span className="ml-auto shrink-0 text-xs text-subtle">{STATUS[r.status]}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
