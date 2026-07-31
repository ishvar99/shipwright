"use client";

import { useCallback, useEffect, useState } from "react";
import { CodePane } from "@/components/workspace/code-pane";
import { Composer } from "@/components/workspace/composer";
import { RepoRail } from "@/components/workspace/repo-rail";
import { ResultsList } from "@/components/workspace/results-list";
import { Splitter } from "@/components/workspace/splitter";
import { StatusBar } from "@/components/workspace/status-bar";
import { TraceStrip } from "@/components/workspace/trace-strip";
import { apiPost, messageFor } from "@/lib/client/api";
import { useJobResult } from "@/lib/client/use-job-result";
import { useRepos } from "@/lib/client/use-repos";
import { JobSchema, type Repo } from "@/lib/contracts";
import { demoJob, demoRun } from "@/lib/fixtures";
import { SelectionProvider } from "@/lib/results/selection";
import { useJobStream } from "@/lib/stream/use-job-stream";
import { fixtureEvents, networkEvents } from "@/lib/stream/transport";
import { applyStoredPrefs } from "@/lib/ui-prefs";

/** Pacing only — printed durations come from the recorded server timestamps. */
const MAX_GAP_MS = 2500;

function PaneHeader({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="shrink-0 border-b border-hairline px-gutter py-gutter text-xs uppercase tracking-wide text-subtle">
      {children}
    </h2>
  );
}

export function WorkspaceShell({ live }: { live: boolean }) {
  const repos = useRepos(live);
  const [selectedRepo, setSelectedRepo] = useState<Repo | null>(null);
  const [jobId, setJobId] = useState<string>(live ? "" : demoJob.id);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Identity of the subscription. A deliberate change restarts the stream; an inline factory
  // would rebuild it every render.
  const makeStream = useCallback(
    () =>
      live
        ? networkEvents(jobId, () => Date.now())
        : fixtureEvents(
            demoRun.frames,
            { mode: "replay", capturedAt: demoRun.meta.capturedAt },
            () => Date.now(),
            { maxGapMs: MAX_GAP_MS },
          ),
    [live, jobId],
  );
  const { state } = useJobStream(jobId || "pending", makeStream);

  const replayJob = live ? null : demoJob;
  const terminal = state.outcome.kind !== "pending";
  const { job, error: resultError } = useJobResult(jobId, terminal, replayJob);
  const locations = job?.result.locations ?? [];

  useEffect(() => {
    applyStoredPrefs();
    return () => {
      delete document.documentElement.dataset.swResizing;
    };
  }, []);

  const run = async (issue: string) => {
    if (!selectedRepo) return;
    setSubmitError(null);
    try {
      const created = await apiPost(JobSchema, "/api/jobs", {
        repo_id: selectedRepo.id,
        issue,
        mode: "extract_rerank",
        base_mode: "hybrid",
      });
      setJobId(created.id);
    } catch (e) {
      setSubmitError(messageFor(e));
    }
  };

  const running = Boolean(jobId) && !terminal;

  return (
    <SelectionProvider locations={locations}>
      <div className="workspace">
        <StatusBar state={state} />

        <div className="workspace-panes">
          <section id="pane-history" className="workspace-pane" aria-label="Repositories">
            <PaneHeader>repositories</PaneHeader>
            <div className="workspace-scroll">
              <RepoRail
                repos={repos.repos}
                selectedId={selectedRepo?.id ?? null}
                onSelect={setSelectedRepo}
                state={repos}
                replay={!live}
              />
            </div>
          </section>

          <Splitter side="left" controls="pane-history" label="repositories" />

          <section className="workspace-pane workspace-centre" aria-label="Activity and results">
            <TraceStrip state={state} />
            <div className="workspace-scroll">
              <Composer
                repo={selectedRepo}
                busy={running}
                onRun={(issue) => void run(issue)}
                replay={!live}
                issueText={demoRun.issue}
              />
              {submitError && (
                <p className="px-gutter pb-gutter text-evidence-path" role="status">
                  {submitError}
                </p>
              )}
              {(jobId || !live) && (
                <ResultsList
                  locations={locations}
                  mode={job?.mode ?? state.mode ?? ""}
                  jobError={state.outcome.error ?? resultError ?? null}
                  queued={state.restStatus === "queued"}
                  running={running}
                />
              )}
            </div>
          </section>

          <Splitter side="right" controls="pane-code" label="code" />

          <section id="pane-code" className="workspace-pane" aria-label="Source">
            <PaneHeader>code</PaneHeader>
            {/* recorded: the deployed site has no backend, so source comes from the bundle. */}
            <CodePane jobId={jobId} recorded={live ? null : demoRun.sources} />
          </section>
        </div>
      </div>
    </SelectionProvider>
  );
}
