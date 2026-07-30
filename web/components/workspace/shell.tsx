"use client";

import { useCallback, useEffect } from "react";
import { CodeEmpty, ComposerEmpty, HistoryEmpty } from "@/components/workspace/panes";
import { Splitter } from "@/components/workspace/splitter";
import { StatusBar } from "@/components/workspace/status-bar";
import { TraceStrip } from "@/components/workspace/trace-strip";
import { demoRun } from "@/lib/fixtures";
import { useJobStream } from "@/lib/stream/use-job-stream";
import { fixtureEvents } from "@/lib/stream/transport";
import { applyStoredPrefs } from "@/lib/ui-prefs";

/** Long enough to read, short enough not to stall the demo. Pacing only — the durations the
 * trace prints come from the recorded server timestamps. */
const MAX_GAP_MS = 2500;

function PaneHeader({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="shrink-0 border-b border-hairline px-gutter py-gutter text-xs uppercase tracking-wide text-subtle">
      {children}
    </h2>
  );
}

export function WorkspaceShell() {
  // M4 has no way to create a job, so the shell drives itself from the committed recording.
  // That makes the status bar and trace strip genuinely live without any M5 machinery — and it
  // is what the deployed site does regardless, having no backend to reach.
  const makeStream = useCallback(
    () =>
      fixtureEvents(
        demoRun.frames,
        { mode: "replay", capturedAt: demoRun.meta.capturedAt },
        () => Date.now(),
        { maxGapMs: MAX_GAP_MS },
      ),
    [],
  );
  const { state } = useJobStream(demoRun.job.id, makeStream);

  useEffect(() => {
    // The boot script does not run on a client-side navigation from `/`.
    applyStoredPrefs();
    // An unmount mid-drag would otherwise leave the whole app stuck in col-resize.
    return () => {
      delete document.documentElement.dataset.swResizing;
    };
  }, []);

  return (
    <div className="workspace">
      <StatusBar state={state} />

      <div className="workspace-panes">
        <section id="pane-history" className="workspace-pane" aria-label="History and repositories">
          <PaneHeader>history</PaneHeader>
          <div className="workspace-scroll">
            <HistoryEmpty />
          </div>
        </section>

        <Splitter side="left" controls="pane-history" label="history" />

        <section className="workspace-pane workspace-centre" aria-label="Activity and results">
          <TraceStrip state={state} />
          <div className="workspace-scroll">
            <ComposerEmpty />
          </div>
        </section>

        <Splitter side="right" controls="pane-code" label="code" />

        <section id="pane-code" className="workspace-pane" aria-label="Source">
          <PaneHeader>code</PaneHeader>
          <div className="workspace-scroll">
            <CodeEmpty />
          </div>
        </section>
      </div>
    </div>
  );
}
