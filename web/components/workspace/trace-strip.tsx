"use client";

import { useState } from "react";
import { Trace } from "@/components/ui/trace";
import {
  elapsedInStageMs,
  traceStages,
  type ActivityState,
} from "@/lib/stream/reduce";
import { readTraceState, setTraceState } from "@/lib/ui-prefs";

function secs(ms?: number) {
  return ms === undefined ? "" : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * A strip, not a pane. The pipeline is eight events over a few seconds; a full pane would sit
 * empty afterwards and imply a chat metaphor. Two fixed heights, so collapsing cannot shift the
 * centre pane's scroll position.
 */
export function TraceStrip({ state }: { state: ActivityState }) {
  // Initial value comes from the boot script's data attribute, so this matches first paint.
  const [collapsed, setCollapsed] = useState(() =>
    typeof document === "undefined" ? false : readTraceState() === "collapsed",
  );
  const stages = traceStages(state);
  const elapsed = elapsedInStageMs(state);

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    setTraceState(next ? "collapsed" : "open");
  };

  return (
    <div className="workspace-trace">
      <div className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          className="shrink-0 text-subtle hover:text-fg"
        >
          {collapsed ? "▸" : "▾"} <span className="sr-only">activity detail</span>
        </button>
        {stages.length === 0 ? (
          <span className="text-subtle">no activity yet</span>
        ) : (
          <Trace stages={stages} className="min-w-0 flex-nowrap overflow-x-auto" />
        )}
      </div>

      <div className="workspace-trace-detail">
        {state.outcome.wallMs !== undefined && <span>{secs(state.outcome.wallMs)} total</span>}
        {elapsed !== undefined && <span>{secs(elapsed)} in stage</span>}
        {state.usage && (
          <span>
            {state.usage.inputTokens + state.usage.outputTokens} tokens
            {state.usage.parseFailures > 0 && ` · ${state.usage.parseFailures} parse failures`}
          </span>
        )}
        {state.graph && <span>{state.graph.symbols} symbols</span>}
        {state.quarantined.length > 0 && (
          <span className="text-evidence-path">
            {state.quarantined.length} unrecognised event
            {state.quarantined.length > 1 ? "s" : ""}
          </span>
        )}
      </div>
    </div>
  );
}
