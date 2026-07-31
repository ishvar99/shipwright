"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-dot";
import { firstLine } from "@/lib/errors";
import { redact } from "@/lib/stream/redact";
import type { ReposState } from "@/lib/client/use-repos";

function secs(ms: number) {
  return `${Math.round(ms / 1000)}s`;
}

/** Repository management, out of the main flow: add, watch the import, retry failures. */
export function RepositoriesView({ state }: { state: ReposState }) {
  const [url, setUrl] = useState("");
  const [path, setPath] = useState("");
  const [local, setLocal] = useState(false);

  return (
    <div className="grid gap-4">
      <h1 className="text-lg font-semibold text-fg">Repositories</h1>

      <form
        className="sw-card grid gap-3 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          const input = local && path.trim() ? { path: path.trim() } : { url: url.trim() };
          void state.importRepo(input).then((r) => {
            if (r) {
              setUrl("");
              setPath("");
            }
          });
        }}
      >
        {!local ? (
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://github.com/owner/name"
            aria-label="GitHub repository URL"
            className="sw-input"
          />
        ) : (
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/absolute/local/path"
            aria-label="Local folder to index"
            className="sw-input"
          />
        )}
        <div className="flex items-center gap-3">
          <Button variant="primary" type="submit" aria-disabled={state.importing || undefined}>
            {state.importing ? "Adding…" : "Add repository"}
          </Button>
          <Button variant="ghost" type="button" onClick={() => setLocal((v) => !v)}>
            {local ? "Use a GitHub URL instead" : "Use a local folder instead"}
          </Button>
        </div>
        {state.importError && <p className="text-danger">{firstLine(redact(state.importError))}</p>}
      </form>

      <ul className="grid gap-2">
        {!state.repos.length && !state.loading && (
          <li className="text-subtle">Add a repository to get started.</li>
        )}
        {state.repos.map((r) => (
          <li key={r.id} className="sw-card flex items-center gap-3 p-4">
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium text-fg">
                {r.slug.replace(/^local:/, "").split("__").pop()}
              </p>
              <p className="text-xs text-subtle" title={r.ref ? `indexed at ${r.ref}` : undefined}>
                {r.status === "ready" && `${r.symbols.toLocaleString()} functions`}
                {/* No fake percentage: the backend reports no import progress. */}
                {r.status === "importing" && `Importing… ${secs(state.elapsed[r.id] ?? 0)}`}
                {r.status === "failed" && (
                  <span className="text-danger">Import couldn&rsquo;t complete</span>
                )}
              </p>
              {r.status === "failed" && r.error && (
                <details className="mt-1 text-xs text-subtle">
                  <summary className="cursor-pointer">Show details</summary>
                  <p className="mt-1 font-mono">{firstLine(redact(r.error))}</p>
                </details>
              )}
            </div>
            {r.status !== "ready" && (
              <StatusDot tone={r.status === "failed" ? "bad" : "active"} />
            )}
            {r.status === "failed" && (
              <Button
                onClick={() =>
                  void state.importRepo(
                    r.source === "github" ? { url: `https://github.com/${r.slug}` } : {},
                  )
                }
              >
                Retry
              </Button>
            )}
          </li>
        ))}
      </ul>
      {state.error && <p className="text-danger">{state.error}</p>}
    </div>
  );
}
