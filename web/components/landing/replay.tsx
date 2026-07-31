"use client";

import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { ActivityFeed } from "@/components/workspace/activity-feed";
import { ResultsList } from "@/components/workspace/results-list";
import { demoJob, demoRun } from "@/lib/fixtures";
import { SelectionProvider } from "@/lib/results/selection";
import { fixtureEvents } from "@/lib/stream/transport";
import { useJobStream } from "@/lib/stream/use-job-stream";

/** Long pauses shortened for the hero; the Done line still shows the true recorded time. */
const HERO_GAP_MS = 2500;

/**
 * The same activity feed and result cards the workspace renders, driven by a recorded stream
 * through the same reducer. Nothing here is a mock-up.
 */
export function Replay() {
  const [pass, setPass] = useState(0);
  const makeStream = useCallback(
    () =>
      fixtureEvents(
        demoRun.frames,
        { mode: "replay", capturedAt: demoRun.meta.capturedAt },
        () => Date.now(),
        { maxGapMs: HERO_GAP_MS },
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pass],
  );
  const { state } = useJobStream(`${demoJob.id}#${pass}`, makeStream);

  const done = state.outcome.kind !== "pending";
  const locations = done ? demoJob.result.locations : [];

  return (
    <SelectionProvider locations={locations}>
      <div className="register-dense sw-card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline px-4 py-2.5">
          <span className="text-[length:var(--text-ui)] font-medium text-fg">
            {demoRun.meta.repo.replace(/^local:/, "").split("__").pop()}
          </span>
          <Button variant="ghost" onClick={() => setPass((p) => p + 1)} className="h-7 px-2">
            Replay
          </Button>
        </div>

        <div className="grid gap-4 p-4">
          <ActivityFeed state={state} />
          <ResultsList locations={locations} mode={demoJob.mode} />
        </div>

        <p className="border-t border-hairline px-4 py-2 text-xs text-subtle">
          A real session, recorded {demoRun.meta.capturedAt.slice(0, 10)} — long pauses shortened
          for the replay.
        </p>
      </div>
    </SelectionProvider>
  );
}
