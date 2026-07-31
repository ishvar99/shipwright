"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ActivityFeed } from "@/components/workspace/activity-feed";
import { FixCard } from "@/components/workspace/fix-card";
import { ResultsList } from "@/components/workspace/results-list";
import { demoJob, demoRun } from "@/lib/fixtures";
import { SelectionProvider } from "@/lib/results/selection";
import { fixtureEvents, type CapturedFrame } from "@/lib/stream/transport";
import { useJobStream } from "@/lib/stream/use-job-stream";

const GAP_MS = 2500;
type Stage = "run" | "applying" | "applied" | "testing" | "tested";

function ActionReplay({
  frames,
  pass,
  onDone,
}: {
  frames: CapturedFrame[];
  pass: number;
  onDone: () => void;
}) {
  const makeStream = useCallback(
    () =>
      fixtureEvents(frames, { mode: "replay", capturedAt: demoRun.meta.capturedAt }, () => Date.now(), {
        maxGapMs: 1500,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pass],
  );
  const { state } = useJobStream(`landing-action-${pass}`, makeStream);
  const done = state.outcome.kind !== "pending";
  useEffect(() => {
    if (done) onDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);
  return <ActivityFeed state={state} summary={false} />;
}

/**
 * The full recorded arc, self-driving: locate, fix streaming in, apply, tests. The same
 * components and reducer the workspace uses — nothing here is a mock-up, and the caption
 * says exactly what it is.
 */
export function Replay() {
  const [pass, setPass] = useState(0);
  const [stage, setStage] = useState<Stage>("run");

  const makeStream = useCallback(
    () =>
      fixtureEvents(
        demoRun.frames,
        { mode: "replay", capturedAt: demoRun.meta.capturedAt },
        () => Date.now(),
        { maxGapMs: GAP_MS },
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pass],
  );
  const { state } = useJobStream(`${demoJob.id}#${pass}`, makeStream);
  const done = state.outcome.kind !== "pending";

  // Self-driving: the recorded apply and test streams follow the session, paced for reading.
  useEffect(() => {
    if (!done || stage !== "run") return;
    const t = setTimeout(() => setStage("applying"), 900);
    return () => clearTimeout(t);
  }, [done, stage]);
  useEffect(() => {
    if (stage !== "applied") return;
    const t = setTimeout(() => setStage("testing"), 700);
    return () => clearTimeout(t);
  }, [stage]);

  const baseFix = demoJob.result.fix;
  const fix =
    baseFix && {
      ...baseFix,
      applied_branch: stage === "run" || stage === "applying" ? undefined : baseFix.applied_branch,
      tests: stage === "tested" ? baseFix.tests : undefined,
    };
  const writing =
    state.timeline.some((t) => t.type === "fix.started") &&
    !state.timeline.some((t) => ["fix.ready", "fix.failed"].includes(t.type));
  const locations = done ? demoJob.result.locations : [];

  return (
    <SelectionProvider locations={locations}>
      <div className="register-dense sw-card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline px-4 py-2.5">
          <span className="text-[length:var(--text-ui)] font-medium text-fg">
            {demoRun.meta.repo.replace(/^local:/, "").split("__").pop()}
          </span>
          <Button
            variant="ghost"
            onClick={() => {
              setStage("run");
              setPass((p) => p + 1);
            }}
            className="h-7 px-2"
          >
            Replay
          </Button>
        </div>

        <div className="grid gap-4 p-4">
          <ActivityFeed state={state} summary={false} />
          {(writing || (done && fix?.patch)) && (
            <FixCard
              fix={fix}
              fixText={state.fixText}
              writing={writing}
              busy
              live={false}
              actions={false}
              onApply={() => undefined}
              onTest={() => undefined}
              onRetry={() => undefined}
            />
          )}
          {(stage === "applying" || stage === "applied") && (
            <ActionReplay
              frames={demoRun.actions.apply ?? []}
              pass={pass}
              onDone={() => setStage((s) => (s === "applying" ? "applied" : s))}
            />
          )}
          {(stage === "testing" || stage === "tested") && (
            <ActionReplay
              frames={demoRun.actions.test ?? []}
              pass={pass}
              onDone={() => setStage("tested")}
            />
          )}
          {stage === "tested" && <ResultsList locations={locations} mode={demoJob.mode} />}
        </div>

        <p className="border-t border-hairline px-4 py-2 text-xs text-subtle">
          A real session, recorded {demoRun.meta.capturedAt.slice(0, 10)} — long pauses
          shortened for the replay. The branch, the diff and the test run all happened.
        </p>
      </div>
    </SelectionProvider>
  );
}
