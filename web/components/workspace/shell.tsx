"use client";

import { useCallback, useEffect, useState } from "react";
import { PanelBoundary } from "@/components/ui/panel-boundary";
import { ActivityFeed } from "@/components/workspace/activity-feed";
import { CodePane } from "@/components/workspace/code-pane";
import { FixCard } from "@/components/workspace/fix-card";
import { Composer } from "@/components/workspace/composer";
import { RepositoriesView } from "@/components/workspace/repositories-view";
import { ResultsList } from "@/components/workspace/results-list";
import { Sidebar } from "@/components/workspace/sidebar";
import { Splitter } from "@/components/workspace/splitter";
import { apiGet, apiPost, messageFor } from "@/lib/client/api";
import { useJobResult } from "@/lib/client/use-job-result";
import { useRepos } from "@/lib/client/use-repos";
import { JobListSchema, JobSchema, type Fix, type Job, type Location, type Repo } from "@/lib/contracts";
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
      .then((all) => setSessions(all.filter((j) => j.kind === "localize")))
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

  const [actions, setActions] = useState<{ id: string; kind: string }[]>([]);
  const [nonce, setNonce] = useState(0);
  // Demo outcomes are revealed by the replayed actions, not shown upfront.
  const [demoStage, setDemoStage] = useState<"proposed" | "applied" | "tested">("proposed");
  const terminal = state.outcome.kind !== "pending";
  const { job } = useJobResult(jobId, terminal, null, nonce);
  const shown = live ? job : demoJob;
  const fix = live
    ? (job?.result.fix ?? null)
    : demoJob.result.fix && {
        ...demoJob.result.fix,
        applied_branch: demoStage === "proposed" ? undefined : demoJob.result.fix.applied_branch,
        tests: demoStage === "tested" ? demoJob.result.fix.tests : undefined,
      };
  const locations = state.outcome.kind === "done" ? (shown?.result.locations ?? []) : [];
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
        mode={shown?.mode ?? state.mode ?? ""}
        jobId={jobId}
        live={live}
        fix={fix ?? null}
        actions={actions}
        onAction={(kind: ActionKind, symbol?: string) => {
          if (!live) {
            setActions((prev) => [...prev, { id: `demo-${kind}-${prev.length}`, kind }]);
            return;
          }
          void (async () => {
            try {
              const created = await apiPost(
                JobSchema,
                `/api/jobs/${encodeURIComponent(jobId)}/actions`,
                { kind, symbol: symbol ?? "" },
              );
              setActions((prev) => [...prev, { id: created.id, kind }]);
            } catch {
              // surfaced by the action feed when it mounts; a failed POST simply does not mount
            }
          })();
        }}
        onActionFinished={(kind: string) => {
          if (!live) {
            setDemoStage((s0) => (kind === "apply" && s0 === "proposed" ? "applied" : kind === "test" ? "tested" : s0));
            return;
          }
          setNonce((n) => n + 1);
        }}
      />
    </SelectionProvider>
  );
}

type ActionKind = "apply" | "test" | "fix_retry";

function ActionFeed({
  id,
  live,
  kind,
  onFinished,
}: {
  id: string;
  live: boolean;
  kind: string;
  onFinished: (kind: string) => void;
}) {
  const makeStream = useCallback(
    () =>
      live
        ? networkEvents(id, () => Date.now())
        : fixtureEvents(
            (demoRun.actions as Record<string, { t: number; raw: string }[]>)[kind] ?? [],
            { mode: "replay", capturedAt: demoRun.meta.capturedAt },
            () => Date.now(),
            { maxGapMs: 1500 },
          ),
    [live, id, kind],
  );
  const { state } = useJobStream(id, makeStream);
  const done = state.outcome.kind !== "pending";
  useEffect(() => {
    if (done) onFinished(kind);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);
  return <ActivityFeed state={state} summary={false} />;
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
  fix,
  actions,
  onAction,
  onActionFinished,
}: {
  title: string;
  repoName: string;
  state: ActivityState;
  onRetry: () => void;
  locations: readonly Location[];
  mode: string;
  jobId: string;
  live: boolean;
  fix: Fix | null;
  actions: { id: string; kind: string }[];
  onAction: (kind: ActionKind, symbol?: string) => void;
  onActionFinished: (kind: string) => void;
}) {
  const { location, clear } = useSelection();
  const busy = actions.length > 0 && state.outcome.kind === "pending";
  const writing = state.timeline.some((t) => t.type === "fix.started") &&
    !state.timeline.some((t) => ["fix.ready", "fix.failed"].includes(t.type));
  const actionBusy = busy; // an action feed reaching terminal bumps the parent nonce

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

        {(writing || Boolean(fix?.patch)) && (
          <FixCard
            fix={fix}
            fixText={state.fixText}
            writing={writing}
            busy={actionBusy}
            live={live}
            onApply={() => onAction("apply")}
            onTest={() => onAction("test")}
            onRetry={() => onAction("fix_retry")}
          />
        )}

        {actions.map((a) => (
          <ActionFeed key={a.id} id={a.id} kind={a.kind} live={live} onFinished={onActionFinished} />
        ))}

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
