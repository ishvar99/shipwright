"use client";

import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-dot";
import { Trace } from "@/components/ui/trace";
import { ResultsList } from "@/components/workspace/results-list";
import { demoJob, demoRun } from "@/lib/fixtures";
import { SelectionProvider } from "@/lib/results/selection";
import { elapsedInStageMs, jobLabel, traceStages } from "@/lib/stream/reduce";
import { fixtureEvents } from "@/lib/stream/transport";
import { useJobStream } from "@/lib/stream/use-job-stream";

function secs(ms?: number) {
  return ms === undefined ? "—" : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * The architectural payoff: not a video or a screenshot, but the same Trace and results
 * components the workspace uses, driven by the recorded stream through the same reducer.
 *
 * Plays at real speed — no gap compression. The pause IS the finding: nearly all the wall time
 * is the model call, and compressing it would misrepresent the one number a visitor should take
 * away. Verified against the capture: played offsets equal recorded offsets exactly.
 */
export function Replay() {
  const [pass, setPass] = useState(0);
  // A new factory identity is the restart mechanism: a fresh controller replays from scratch.
  const makeStream = useCallback(
    () =>
      fixtureEvents(
        demoRun.frames,
        { mode: "replay", capturedAt: demoRun.meta.capturedAt },
        () => Date.now(),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pass],
  );
  const { state } = useJobStream(`${demoJob.id}#${pass}`, makeStream);

  const stages = traceStages(state);
  const done = state.outcome.kind !== "pending";
  const inStage = elapsedInStageMs(state);
  // Results appear when the run finishes, as they do in the product. Handing them over early
  // would spoil the only thing this replay is showing.
  const locations = done ? demoJob.result.locations : [];

  return (
    <SelectionProvider locations={locations}>
      <div className="register-dense overflow-hidden rounded-[var(--radius)] border border-hairline bg-soft">
        <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-hairline px-3 py-2">
          <span className="flex items-baseline gap-3 font-mono text-[length:var(--text-ui)]">
            <span className="text-subtle">{demoRun.meta.repo.replace(/^local:/, "")}</span>
            <StatusDot tone={jobLabel(state).tone} label={jobLabel(state).text} />
          </span>
          <span className="flex items-baseline gap-3 text-[11px] text-subtle">
            <span>
              {done ? `${secs(state.outcome.wallMs)} total` : `${secs(inStage)} in stage`}
            </span>
            <span>{demoRun.meta.model}</span>
            <Button onClick={() => setPass((p) => p + 1)}>Replay</Button>
          </span>
        </div>

        <div className="px-3 py-2">
          {stages.length ? (
            <Trace stages={stages} className="flex-nowrap overflow-x-auto" />
          ) : (
            <span className="text-subtle">starting…</span>
          )}
        </div>

        <ResultsList
          locations={locations}
          mode={demoJob.mode}
          jobError={null}
          queued={false}
          running={!done}
        />

        <p className="border-t border-hairline px-3 py-2 text-[11px] text-subtle">
          Recorded {demoRun.meta.capturedAt.slice(0, 10)} against {demoRun.meta.ref}, played at
          real speed: {secs(demoRun.meta.wallMs)} end to end, nearly all of it the model call.
        </p>
      </div>
    </SelectionProvider>
  );
}
