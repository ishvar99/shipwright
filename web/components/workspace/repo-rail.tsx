"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-dot";
import type { Repo } from "@/lib/contracts";
import { cn } from "@/lib/cn";
import { firstLine } from "@/lib/errors";
import { redact } from "@/lib/stream/redact";
import type { ReposState } from "@/lib/client/use-repos";

const TONE = { ready: "good", importing: "active", failed: "bad" } as const;

function secs(ms: number) {
  return `${Math.round(ms / 1000)}s`;
}

export function RepoRail({
  repos,
  selectedId,
  onSelect,
  state,
  replay,
}: {
  repos: Repo[];
  selectedId: string | null;
  onSelect: (repo: Repo) => void;
  state: ReposState;
  replay: boolean;
}) {
  const [url, setUrl] = useState("");
  const [path, setPath] = useState("");
  const [advanced, setAdvanced] = useState(false);

  return (
    <div className="flex min-h-0 flex-col">
      {!replay && (
        <form
          className="shrink-0 border-b border-hairline p-gutter"
          onSubmit={(e) => {
            e.preventDefault();
            const input = advanced && path.trim() ? { path: path.trim() } : { url: url.trim() };
            void state.importRepo(input).then((r) => {
              if (r) {
                setUrl("");
                setPath("");
              }
            });
          }}
        >
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://github.com/owner/name"
            aria-label="GitHub repository URL"
            className="w-full rounded-[var(--radius)] border border-hairline bg-soft px-2 py-1 font-mono text-[length:var(--text-ui)]"
          />
          {advanced && (
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/absolute/local/path"
              aria-label="Local directory to index"
              className="mt-1 w-full rounded-[var(--radius)] border border-hairline bg-soft px-2 py-1 font-mono text-[length:var(--text-ui)]"
            />
          )}
          <div className="mt-2 flex items-center gap-2">
            <Button type="submit" aria-disabled={state.importing || undefined}>
              {state.importing ? "Importing…" : "Import"}
            </Button>
            <button
              type="button"
              onClick={() => setAdvanced((a) => !a)}
              className="text-subtle hover:text-fg"
            >
              {advanced ? "use a URL" : "use a local path"}
            </button>
          </div>
          {state.importError && (
            <p className="mt-1 text-evidence-path">{firstLine(redact(state.importError))}</p>
          )}
        </form>
      )}

      <ul className="min-h-0 flex-1 divide-y divide-hairline overflow-y-auto">
        {state.loading && <li className="p-gutter text-subtle">Loading repositories…</li>}
        {!state.loading && !repos.length && (
          <li className="p-gutter text-subtle">
            {replay ? "Recorded run — no live repositories." : "No repositories yet."}
          </li>
        )}
        {repos.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              onClick={() => onSelect(r)}
              aria-current={r.id === selectedId}
              className={cn(
                "block w-full px-gutter py-gutter text-left hover:bg-accent-soft",
                r.id === selectedId && "bg-accent-soft",
              )}
            >
              <span className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate font-mono text-[length:var(--text-ui)] text-fg">
                  {r.slug}
                </span>
                <StatusDot tone={TONE[r.status]} label={r.status} />
              </span>
              <span className="mt-0.5 block text-[11px] text-subtle">
                {r.status === "ready" && (
                  // Provenance, always: which commit these results describe is the useful fact.
                  <>
                    indexed at {r.ref || "unknown"} · {r.symbols.toLocaleString()} symbols
                  </>
                )}
                {r.status === "importing" && (
                  // No percentage: the backend reports no clone or index progress, and a fake
                  // one would be a lie in the most visible place.
                  <>indexing… {secs(state.elapsed[r.id] ?? 0)} elapsed</>
                )}
                {r.status === "failed" && (
                  <span className="text-evidence-path">{firstLine(redact(r.error))}</span>
                )}
              </span>
            </button>
            {r.status === "failed" && !replay && (
              <div className="px-gutter pb-gutter">
                {/* Only on failed rows: re-importing a ready repo returns the existing row
                    untouched and starts nothing, so the button would lie. */}
                <Button
                  onClick={() =>
                    void state.importRepo(
                      r.source === "github" ? { url: `https://github.com/${r.slug}` } : {},
                    )
                  }
                >
                  Retry import
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {state.error && <p className="shrink-0 p-gutter text-evidence-path">{state.error}</p>}
    </div>
  );
}
