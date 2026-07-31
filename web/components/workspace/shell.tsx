"use client";

import { useCallback, useEffect, useState } from "react";
import { PanelBoundary } from "@/components/ui/panel-boundary";
import { ActivityFeed } from "@/components/workspace/activity-feed";
import { CodePane } from "@/components/workspace/code-pane";
import { Composer } from "@/components/workspace/composer";
import { RepositoriesView } from "@/components/workspace/repositories-view";
import { ResultsList } from "@/components/workspace/results-list";
import { Sidebar } from "@/components/workspace/sidebar";
import { Splitter } from "@/components/workspace/splitter";
import { apiGet, apiPost, messageFor } from "@/lib/client/api";
import { useJobResult } from "@/lib/client/use-job-result";
import { useRepos } from "@/lib/client/use-repos";
import { JobListSchema, JobSchema, type Job, type Location, type Repo } from "@/lib/contracts";
import { demoJob, demoRun } from "@/lib/fixtures";
import { SelectionProvider, useSelection } from "@/lib/results/selection";
import { sessionTitle } from "@/lib/sessions";
import { useJobStream } from "@/lib/stream/use-job-stream";
import type { ActivityState } from "@/lib/stream/reduce";
import { fixtureEvents, networkEvents } from "@/lib/stream/transport";
import { applyStoredPrefs } from "@/lib/ui-prefs";

/** Demo pacing only — the Done line still shows the true recorded wall time. */
const DEMO_GAP_MS = 2500;

type View = { kind: "home" } | { kind: "repos" } | { kind: "session"; jobId: string; pass: number };

export function WorkspaceShell({ live }: { live: boolean }) {
  const repos = useRepos(live);
  const [view, setView] = useState<View>({ kind: "home" });
  const [selectedRepo, setSelectedRepo] = useState<Repo | null>(null);
  const [sessions, setSessions] = useState<Job[]>(live ? [] : [demoJob]);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Derived, not set in an effect: the default is simply the first ready repository.
  const currentRepo = selectedRepo ?? repos.repos.find((r) => r.status === "ready") ?? null;

  const refreshSessions = useCallback(() => {
    if (!live) return;
    void apiGet(JobListSchema, "/api/jobs?limit=25")
      .then(setSessions)
      .catch(() => undefined); // the sidebar list is never worth an error banner
  }, [live]);

  useEffect(() => {
    refreshSessions();
    applyStoredPrefs();
    return () => {
      delete document.documentElement.dataset.swResizing;
    };
  }, [refreshSessions]);

  const run = async (issue: string) => {
    if (!currentRepo) return;
    setSubmitError(null);
    try {
      const created = await apiPost(JobSchema, "/api/jobs", {
        repo_id: currentRepo.id,
        issue,
        mode: "extract_rerank",
        base_mode: "hybrid",
      });
      setSessions((prev) => [created, ...prev.filter((j) => j.id !== created.id)]);
      setView({ kind: "session", jobId: created.id, pass: 0 });
    } catch (e) {
      setSubmitError(messageFor(e));
    }
  };

  const activeJobId = view.kind === "session" ? view.jobId : null;
  const activeSession = sessions.find((j) => j.id === activeJobId) ?? null;

  return (
    <main className="workspace">
      <h1 className="sr-only">Shipwright workspace</h1>
      <a href="#session" className="sw-skip">
        Skip to the session
      </a>

      <Sidebar
        sessions={sessions}
        activeJobId={activeJobId}
        demo={!live}
        onNewSession={() => setView({ kind: "home" })}
        onOpenSession={(job) =>
          setView((v) => ({
            kind: "session",
            jobId: job.id,
            // Reopening the demo session replays it from the start.
            pass: v.kind === "session" && v.jobId === job.id && !live ? v.pass + 1 : 0,
          }))
        }
        onOpenRepositories={() => setView({ kind: "repos" })}
      />

      <div id="session" tabIndex={-1} className="workspace-main">
        {view.kind === "repos" && <RepositoriesView state={repos} />}

        {view.kind === "home" && (
          <div className="sw-home">
            <h2 className="text-xl font-semibold text-fg">
              Describe a bug or a change. Shipwright finds where in the code it lives.
            </h2>
            <Composer
              repos={live ? repos.repos : []}
              repo={currentRepo}
              onPickRepo={setSelectedRepo}
              busy={false}
              onRun={(issue) => void run(issue)}
              replay={!live}
              issueText={demoRun.issue}
              onReplay={() => setView((v) => ({ kind: "session", jobId: demoJob.id, pass: v.kind === "session" ? v.pass + 1 : 0 }))}
            />
            {submitError && <p className="text-danger">{submitError}</p>}
          </div>
        )}

        {view.kind === "session" && (
          // Keyed by job and pass: a new session gets a fresh stream, and replaying the demo
          // restarts it. No stream exists outside this component, so nothing in the chrome can
          // reconnect-loop against a job that does not exist yet.
          <PanelBoundary label="session">
            <SessionView
              key={`${view.jobId}#${view.pass}`}
              jobId={view.jobId}
              live={live}
              session={activeSession}
            />
          </PanelBoundary>
        )}
      </div>
    </main>
  );
}

function SessionView({ jobId, live, session }: { jobId: string; live: boolean; session: Job | null }) {
  const makeStream = useCallback(
    () =>
      live
        ? networkEvents(jobId, () => Date.now())
        : fixtureEvents(
            demoRun.frames,
            { mode: "replay", capturedAt: demoRun.meta.capturedAt },
            () => Date.now(),
            { maxGapMs: DEMO_GAP_MS },
          ),
    [live, jobId],
  );
  const { state, retry } = useJobStream(jobId, makeStream);

  const terminal = state.outcome.kind !== "pending";
  const { job } = useJobResult(jobId, terminal, live ? null : demoJob);
  const locations = state.outcome.kind === "done" ? (job?.result.locations ?? []) : [];
  const title = sessionTitle(session?.issue ?? (live ? "" : demoRun.issue)) || "Session";
  const repoName = (state.repo ?? "").replace(/^local:/, "").split("__").pop() ?? "";

  return (
    <SelectionProvider locations={locations}>
      <SessionBody
        title={title}
        repoName={repoName}
        state={state}
        onRetry={retry}
        locations={locations}
        mode={job?.mode ?? state.mode ?? ""}
        jobId={jobId}
        live={live}
      />
    </SelectionProvider>
  );
}

function SessionBody({
  title,
  repoName,
  state,
  onRetry,
  locations,
  mode,
  jobId,
  live,
}: {
  title: string;
  repoName: string;
  state: ActivityState;
  onRetry: () => void;
  locations: readonly Location[];
  mode: string;
  jobId: string;
  live: boolean;
}) {
  const { location, clear } = useSelection();

  return (
    <div className="sw-session" data-code={location ? "open" : undefined}>
      <div className="grid min-w-0 content-start gap-5">
        <header className="grid gap-1.5">
          <h2 className="text-lg font-semibold text-fg">{title}</h2>
          {repoName && (
            <span className="justify-self-start rounded-full bg-soft px-2.5 py-0.5 text-xs font-medium text-muted">
              {repoName}
            </span>
          )}
        </header>

        <ActivityFeed state={state} onRetry={onRetry} />

        {state.restStatus === "queued" && state.timeline.length === 0 && (
          <p className="text-subtle" role="status">
            Queued — your analysis will start in a moment.
          </p>
        )}

        {state.outcome.kind === "done" && locations.length === 0 && (
          <p className="text-subtle" role="status">
            No matches found. Adding a function name or an error message usually helps.
          </p>
        )}

        <ResultsList locations={locations} mode={mode} />
      </div>

      {location && (
        <>
          <Splitter side="right" controls="code-panel" label="code" />
          <aside id="code-panel" aria-label="Code preview" className="sw-code-panel">
            <PanelBoundary label="code">
              <CodePane jobId={jobId} recorded={live ? null : demoRun.sources} onClose={clear} />
            </PanelBoundary>
          </aside>
        </>
      )}
    </div>
  );
}
