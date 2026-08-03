"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { PanelBoundary } from "@/components/ui/panel-boundary";
import { ActivityFeed } from "@/components/workspace/activity-feed";
import { AnswerCard, NoWorkCard } from "@/components/workspace/answer-card";
import { CodePane } from "@/components/workspace/code-pane";
import { FixCard } from "@/components/workspace/fix-card";
import { ResultsList } from "@/components/workspace/results-list";
import { Splitter } from "@/components/workspace/splitter";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import { apiPost, messageFor } from "@/lib/client/api";
import { useJobResult } from "@/lib/client/use-job-result";
import { repoDisplayName } from "@/lib/repo-name";
import { repoHome } from "@/lib/repo-routes";
import { JobSchema, type Fix, type Job, type Location } from "@/lib/contracts";
import { demoJob, demoRun } from "@/lib/fixtures";
import { localEvents } from "@/lib/local/run";
import { isLocalJob } from "@/lib/local/store";
import { SelectionProvider, useSelection } from "@/lib/results/selection";
import { sessionTitle } from "@/lib/sessions";
import { useJobStream } from "@/lib/stream/use-job-stream";
import type { ActivityState } from "@/lib/stream/reduce";
import { fixtureEvents, networkEvents } from "@/lib/stream/transport";

/** Demo pacing only — the Done line still shows the true recorded wall time. */
const DEMO_GAP_MS = 2500;

export function SessionView({
  jobId,
  live,
  session,
  onOpenInEditor,
  onNewSession,
}: {
  jobId: string;
  live: boolean;
  session: Job | null;
  onOpenInEditor: (location: Location, repoId: string, slug: string) => void;
  onNewSession: () => void;
}) {
  const makeStream = useCallback(
    () =>
      // Three sources, one protocol: the network, this browser, and the recording.
      isLocalJob(jobId)
        ? localEvents(jobId, session?.repo_id ?? "", session?.issue ?? "", () => Date.now())
        : live
        ? networkEvents(jobId, () => Date.now())
        : fixtureEvents(
            demoRun.frames,
            { mode: "replay", capturedAt: demoRun.meta.capturedAt },
            () => Date.now(),
            { maxGapMs: DEMO_GAP_MS },
          ),
    [live, jobId, session?.repo_id, session?.issue],
  );
  const { state, retry } = useJobStream(jobId, makeStream);

  const [actions, setActions] = useState<{ id: string; kind: string }[]>([]);
  const [pendingAction, setPendingAction] = useState<ActionKind | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const { patchSession } = useWorkspace();
  // Demo outcomes are revealed by the replayed actions, not shown upfront.
  const [demoStage, setDemoStage] = useState<"proposed" | "applied" | "tested">("proposed");
  const terminal = state.outcome.kind !== "pending";
  // Gated on `live`: a replayed session's id belongs to no row, so fetching it is a guaranteed
  // 404 whose result is discarded two lines below anyway.
  // A local job has no row on any server; its result arrives through the stream instead.
  const { job } = useJobResult(jobId, terminal && live && !isLocalJob(jobId), null, nonce);
  const shown = isLocalJob(jobId) ? session : live ? job : demoJob;
  const fix = live
    ? (job?.result.fix ?? null)
    : demoJob.result.fix && {
        ...demoJob.result.fix,
        applied_branch: demoStage === "proposed" ? undefined : demoJob.result.fix.applied_branch,
        tests: demoStage === "tested" ? demoJob.result.fix.tests : undefined,
      };
  const locations = state.outcome.kind === "done" ? (shown?.result.locations ?? []) : [];
  // Prefer the job we fetched over the sidebar row: the row is absent for anything past the
  // 25-row page, for harness sessions once "show all" is off, and for one just deleted.
  const title =
    sessionTitle(shown?.issue ?? session?.issue ?? (live ? "" : demoRun.issue)) || "Session";
  const repoName = repoDisplayName(state.repo ?? "");

  // The row's dot is its only state signal; without this it pulses "running" forever.
  useEffect(() => {
    if (state.outcome.kind === "pending") return;
    patchSession(jobId, { status: state.outcome.kind === "failed" ? "errored" : "done" });
  }, [state.outcome.kind, jobId, patchSession]);

  return (
    <SelectionProvider locations={locations}>
      <SessionBody
        title={title}
        repoName={repoName}
        state={state}
        onRetry={retry}
        locations={locations}
        mode={shown?.mode ?? state.mode ?? ""}
        intent={state.intent ?? shown?.result.intent ?? undefined}
        answer={state.answerText || (shown?.result.answer ?? "")}
        noWorkReason={shown?.result.reason ?? ""}
        onNewSession={onNewSession}
        jobId={jobId}
        live={live}
        repoId={shown?.repo_id ?? session?.repo_id ?? ""}
        repoSlug={shown?.repo_slug ?? session?.repo_slug ?? ""}
        onOpenInEditor={onOpenInEditor}
        fix={fix ?? null}
        actions={actions}
        pendingAction={pendingAction}
        actionError={actionError}
        onAction={(kind: ActionKind, symbol?: string) => {
          if (!live) {
            setActions((prev) => [...prev, { id: `demo-${kind}-${prev.length}`, kind }]);
            return;
          }
          setPendingAction(kind);
          setActionError(null);
          void (async () => {
            try {
              const created = await apiPost(
                JobSchema,
                `/api/jobs/${encodeURIComponent(jobId)}/actions`,
                { kind, symbol: symbol ?? "" },
              );
              setActions((prev) => [...prev, { id: created.id, kind }]);
            } catch (e) {
              // Previously swallowed: the user clicked Apply and nothing happened at all.
              setActionError(messageFor(e));
              setPendingAction(null);
            }
          })();
        }}
        onActionFinished={(kind: string) => {
          setPendingAction(null);
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
  // A lost stream never produces an outcome, so treat a failed phase as finished too — otherwise
  // the parent's pending flag disables Apply and Test permanently.
  const done = state.outcome.kind !== "pending" || state.phase === "failed";
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
  intent,
  answer,
  noWorkReason,
  onNewSession,
  jobId,
  live,
  repoId,
  repoSlug,
  onOpenInEditor,
  fix,
  actions,
  pendingAction,
  actionError,
  onAction,
  onActionFinished,
}: {
  title: string;
  repoName: string;
  state: ActivityState;
  onRetry: () => void;
  locations: readonly Location[];
  mode: string;
  intent?: "change" | "question" | "other";
  answer: string;
  noWorkReason: string;
  onNewSession: () => void;
  jobId: string;
  live: boolean;
  repoId: string;
  repoSlug: string;
  onOpenInEditor: (location: Location, repoId: string, slug: string) => void;
  fix: Fix | null;
  actions: { id: string; kind: string }[];
  pendingAction: ActionKind | null;
  actionError: string | null;
  onAction: (kind: ActionKind, symbol?: string) => void;
  onActionFinished: (kind: string) => void;
}) {
  const { location, clear } = useSelection();
  const { setCodeOpen } = useWorkspace();
  // The frame collapses the sidebar for the code pane the way it does for the file browser,
  // but the pane is selection state, not a route — so it is told, not derived. Cleared on
  // unmount, or leaving the session would keep the sidebar collapsed everywhere.
  useEffect(() => {
    setCodeOpen(Boolean(location));
    return () => setCodeOpen(false);
  }, [location, setCodeOpen]);
  // The parent localize job is already "done" when the fix card renders, so its outcome could
  // never disable these buttons — the action actually in flight is what matters.
  const actionBusy = pendingAction !== null;
  const writing = state.timeline.some((t) => t.type === "fix.started") &&
    !state.timeline.some((t) => ["fix.ready", "fix.failed"].includes(t.type));

  return (
    <div className="sw-session" data-code={location ? "open" : undefined}>
      {/* Explicit minmax(0,1fr): with no template the implicit column sizes to max-content,
          so a long headline held the track wider than the container and ran under the code
          pane instead of wrapping. */}
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-5">
        <header className="grid gap-1.5">
          {/* The repository above the issue, and a link: a session is somewhere, and this is
              the way back to it. */}
          {repoName && (
            <Link href={repoHome(repoId)} className="sw-session-repo">
              <Icon name="folder" size={13} className="shrink-0" />
              <span className="sw-truncate">{repoName}</span>
            </Link>
          )}
          <h2 className="text-head font-semibold text-fg">{title}</h2>
        </header>

        <ActivityFeed state={state} onRetry={onRetry} />

        {state.restStatus === "queued" && state.timeline.length === 0 && (
          <p className="text-subtle" role="status">
            Queued — your analysis will start in a moment.
          </p>
        )}

        {/* A question is answered, never patched. */}
        {intent === "question" && (
          <AnswerCard text={answer} streaming={state.outcome.kind === "pending" && !answer} />
        )}

        {intent === "other" && state.outcome.kind === "done" && (
          <NoWorkCard reason={noWorkReason} onNewSession={onNewSession} />
        )}

        {(writing || Boolean(fix?.patch)) && (
          <FixCard
            fix={fix}
            fixText={state.fixText}
            writing={writing}
            busy={actionBusy}
            pendingKind={pendingAction}
            live={live}
            onApply={() => onAction("apply")}
            onTest={() => onAction("test")}
            onRetry={() => onAction("fix_retry")}
          />
        )}

        {actionError && (
          <p role="alert" className="text-danger">
            {actionError}
          </p>
        )}

        {actions.map((a) => (
          <ActionFeed key={a.id} id={a.id} kind={a.kind} live={live} onFinished={onActionFinished} />
        ))}

        {state.outcome.kind === "done" && locations.length === 0 && intent !== "other" && (
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
              <CodePane
                jobId={jobId}
                recorded={live ? null : demoRun.sources}
                onClose={clear}
                onOpenInEditor={live && repoId ? () => onOpenInEditor(location, repoId, repoSlug) : undefined}
              />
            </PanelBoundary>
          </aside>
        </>
      )}
    </div>
  );
}
