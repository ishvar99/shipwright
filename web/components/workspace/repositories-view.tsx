"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { GitHubConnect } from "@/components/workspace/github-connect";
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
  onUnlinkRepo,
  sessionCount,
  local,
}: {
  state: ReposState;
  demo?: boolean;
  onOpenRepo?: (repo: Repo) => void;
  /** Absent in the recorded demo, where there is nothing of the user's to unlink. */
  onUnlinkRepo?: (repo: Repo) => void;
  /** How many sessions each repository would take with it, so the confirm can say so. */
  sessionCount?: (repoId: string) => number;
  /** Present when there is no backend: imports are unzipped and indexed in this browser
   * instead of being sent anywhere. Same form, different destination. */
  local?: {
    busy: string | null;
    error: string | null;
    importZip: (file: File) => void;
    importUrl: (url: string) => void;
  };
}) {
  const [url, setUrl] = useState("");
  const [path, setPath] = useState("");
  const [useLocalPath, setUseLocalPath] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  // dragenter/leave fire per child element; a counter is what keeps the overlay stable.
  const dragDepth = useRef(0);

  const busy = local ? Boolean(local.busy) : state.importing;
  // Which row is asking "are you sure". One at a time, cleared on any other action — an
  // inline step rather than a dialog: unlinking is reversible by re-importing, and a modal
  // for it would out-weigh the act.
  const [confirming, setConfirming] = useState<string | null>(null);

  const drop = (file: File | undefined) => {
    dragDepth.current = 0;
    setDragging(false);
    if (!file || busy) return;
    if (local) local.importZip(file);
    else void state.uploadRepo(file);
  };

  return (
    <div
      className="sw-page relative grid gap-4"
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

      <h1 className="text-head font-semibold text-fg">Repositories</h1>

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
              if (busy) return;
              if (local) {
                local.importUrl(url.trim());
                setUrl("");
                return;
              }
              const input = useLocalPath && path.trim() ? { path: path.trim() } : { url: url.trim() };
              void state.importRepo(input).then((r) => {
                if (r) {
                  setUrl("");
                  setPath("");
                }
              });
            }}
          >
            {/* Input and action on one line: a lone button dropped under a full-width field
                read as a form that had lost its way. */}
            <div className="flex items-center gap-2">
              {!useLocalPath ? (
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://github.com/owner/name"
                  aria-label="GitHub repository URL"
                  className="sw-input min-w-0 flex-1"
                />
              ) : (
                <input
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder="/absolute/local/path"
                  aria-label="Local folder to index"
                  className="sw-input min-w-0 flex-1"
                />
              )}
              <Button
                variant="primary"
                type="submit"
                aria-disabled={busy || undefined}
                className="shrink-0"
              >
                {local?.busy ?? (state.importing ? "Adding…" : "Add repository")}
              </Button>
            </div>
            {!local && (
              <div>
                <Button variant="ghost" type="button" onClick={() => setUseLocalPath((v) => !v)}>
                  {useLocalPath ? "Use a GitHub URL instead" : "Use a local folder instead"}
                </Button>
              </div>
            )}
          </form>

          <GitHubConnect
            live={!demo}
            importing={state.importing}
            onImport={(input) => void state.importRepo(input)}
          />

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

      {(local?.error ?? state.importError) && (
        <p role="alert" className="text-danger">
          {firstLine(redact(local?.error ?? state.importError ?? ""))}
        </p>
      )}
      {local && (
        <p className="text-xs text-subtle">
          No backend here, so this repository is unzipped and indexed in your browser and stays
          on this machine. Search works; applying and testing fixes needs the local engine.
        </p>
      )}
      {/* Only true, and only worth saying, on the hosted public deploy — a build-time flag
          rather than a `demo`/`local` inference, since neither distinguishes "real backend,
          but shared with strangers" from a developer's own backendful local run. */}
      {!local && !demo && process.env.NEXT_PUBLIC_PUBLIC_SANDBOX === "1" && (
        <p className="text-xs text-subtle">
          Public sandbox — imports are shared with other visitors and reset when the free host
          restarts. Demo repositories restore themselves.
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
                  {/* Say it at import time: otherwise the user only learns a repo is
                      unreadable after writing an issue and pressing Ask Shipwright. */}
                  {r.status === "ready" &&
                    (r.symbols === 0
                      ? "Nothing indexable — browse and edit only"
                      : `${r.symbols.toLocaleString()} symbols`)}
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
              {/* A finished import used to just change some text and leave the user to work out
                  the next step. One destination now: the repository's own page is where a
                  session starts, so "open it" and "work in it" stopped being two things. */}
              {openable && (
                <Button
                  className="h-7 shrink-0 px-2"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenRepo?.(r);
                  }}
                >
                  Open
                </Button>
              )}
              {onUnlinkRepo &&
                (confirming === r.id ? (
                  <span className="flex shrink-0 items-center gap-2 text-xs">
                    {/* Names what actually goes: the sessions are the part a user would not
                        expect, and re-importing is the undo. */}
                    <span className="text-subtle">
                      Unlink{sessionCount?.(r.id) ? ` and ${sessionCount(r.id)} session${sessionCount(r.id) === 1 ? "" : "s"}` : ""}?
                    </span>
                    <Button
                      className="h-7 shrink-0 px-2 text-danger"
                      onClick={() => {
                        setConfirming(null);
                        onUnlinkRepo(r);
                      }}
                    >
                      Unlink
                    </Button>
                    <Button
                      variant="ghost"
                      className="h-7 shrink-0 px-2"
                      onClick={() => setConfirming(null)}
                    >
                      Cancel
                    </Button>
                  </span>
                ) : (
                  <Button
                    variant="ghost"
                    className="h-7 shrink-0 px-2"
                    title="Remove this repository from Shipwright. Your files are not touched."
                    onClick={() => setConfirming(r.id)}
                  >
                    Unlink
                  </Button>
                ))}
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
