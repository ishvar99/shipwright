"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { StatusDot } from "@/components/ui/status-dot";
import { firstLine } from "@/lib/errors";
import { redact } from "@/lib/stream/redact";
import { repoDisplayName } from "@/lib/repo-name";
import type { Repo } from "@/lib/contracts";
import type { ReposState } from "@/lib/client/use-repos";

function secs(ms: number) {
  return `${Math.round(ms / 1000)}s`;
}

/** Repository management, out of the main flow: add, watch the import, open, retry. */
export function RepositoriesView({
  state,
  demo = false,
  onOpenRepo,
}: {
  state: ReposState;
  demo?: boolean;
  onOpenRepo?: (repo: Repo) => void;
}) {
  const [url, setUrl] = useState("");
  const [path, setPath] = useState("");
  const [local, setLocal] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  // dragenter/leave fire per child element; a counter is what keeps the overlay stable.
  const dragDepth = useRef(0);

  const drop = (file: File | undefined) => {
    dragDepth.current = 0;
    setDragging(false);
    if (file && !state.importing) void state.uploadRepo(file);
  };

  return (
    <div
      className="relative grid gap-4"
      onDragEnter={(e) => {
        if (demo || !e.dataTransfer.types.includes("Files")) return;
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if (dragging) e.preventDefault();
      }}
      onDragEnd={() => {
        dragDepth.current = 0;
        setDragging(false);
      }}
      onDragLeave={(e) => {
        // Mirror the enter guard: a non-file drag (selecting text) fires leave without ever
        // having incremented, and a negative counter leaves dragging false — which means
        // onDragOver never preventDefaults and the browser opens the dropped file instead.
        if (demo || !e.dataTransfer.types.includes("Files")) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDragging(false);
      }}
      onDrop={(e) => {
        if (demo) return;
        e.preventDefault();
        drop(e.dataTransfer.files[0]);
      }}
    >
      {dragging && (
        <div aria-hidden className="sw-drop-overlay">
          <p>Drop .zip to import</p>
        </div>
      )}

      <h1 className="text-lg font-semibold text-fg">Repositories</h1>

      {demo ? (
        <p className="sw-card p-5 text-subtle">
          Run Shipwright locally to import your own repositories.
        </p>
      ) : (
        <>
          <form
            className="sw-card grid gap-3 p-5"
            onSubmit={(e) => {
              e.preventDefault();
              if (state.importing) return;
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
          </form>

          <div className="sw-dropzone">
            <input
              ref={fileInput}
              type="file"
              accept=".zip,application/zip"
              aria-label="Zip archive to import"
              disabled={state.importing}
              className="sr-only"
              onChange={(e) => {
                drop(e.target.files?.[0]);
                e.target.value = ""; // re-selecting the same file must fire change again
              }}
            />
            {state.uploadProgress !== null ? (
              <>
                <p className="text-fg">Uploading… {Math.round(state.uploadProgress * 100)}%</p>
                <div
                  className="sw-progress"
                  role="progressbar"
                  aria-label="Upload progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(state.uploadProgress * 100)}
                >
                  <span style={{ width: `${state.uploadProgress * 100}%` }} />
                </div>
              </>
            ) : state.uploading ? (
              // Determinate only while bytes move; the server-side stage reports no progress.
              <p className="text-fg">Processing the archive…</p>
            ) : (
              <>
                <Icon name="folder" size={20} className="text-subtle" />
                <p className="text-fg">
                  Drop a .zip here, or{" "}
                  <button
                    type="button"
                    className="underline underline-offset-4 hover:text-accent"
                    onClick={() => fileInput.current?.click()}
                  >
                    choose a file
                  </button>
                </p>
                <p className="text-xs text-subtle">Up to 150 MB · 10,000 files</p>
              </>
            )}
          </div>
        </>
      )}

      {state.importError && (
        <p role="alert" className="text-danger">
          {firstLine(redact(state.importError))}
        </p>
      )}

      <ul className="grid gap-2">
        {!state.repos.length && !state.loading && (
          <li className="text-subtle">Add a repository to get started.</li>
        )}
        {state.repos.map((r) => {
          const openable = r.status === "ready" && Boolean(onOpenRepo);
          return (
            <li key={r.id} className="sw-card flex items-center gap-3 p-4">
              <div className="min-w-0 flex-1">
                {openable ? (
                  <button
                    type="button"
                    onClick={() => onOpenRepo?.(r)}
                    className="block max-w-full truncate text-left font-medium text-fg hover:text-accent"
                  >
                    {repoDisplayName(r.slug)}
                  </button>
                ) : (
                  <p className="truncate font-medium text-fg">{repoDisplayName(r.slug)}</p>
                )}
                <p className="text-xs text-subtle" title={r.ref ? `indexed at ${r.ref}` : undefined}>
                  {/* Say it at import time: otherwise the user only learns Python-only after
                      writing an issue and pressing Find the code. */}
                  {r.status === "ready" &&
                    (r.symbols === 0
                      ? "No Python found — browse and edit only"
                      : `${r.symbols.toLocaleString()} functions`)}
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
              {r.status !== "ready" && <StatusDot tone={r.status === "failed" ? "bad" : "active"} />}
              {/* Retry can only re-run what we can reconstruct: a GitHub URL. A zip's bytes
                  are gone, and a local path is deliberately never sent to the browser. */}
              {r.status === "failed" &&
                (r.source === "github" ? (
                  <Button
                    onClick={() =>
                      void state.importRepo({ url: `https://github.com/${r.slug}` })
                    }
                  >
                    Retry
                  </Button>
                ) : (
                  <span className="shrink-0 text-xs text-subtle">
                    {r.source === "zip" ? "Upload the zip again" : "Add the folder again"}
                  </span>
                ))}
            </li>
          );
        })}
      </ul>
      {state.error && <p className="text-danger">{state.error}</p>}
    </div>
  );
}
