"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Trace } from "@/components/ui/trace";
import { cn } from "@/lib/cn";
import { activeElapsedMs, doneSummary, failureCopy, narrate } from "@/lib/stream/narrative";
import { traceStages, type ActivityState } from "@/lib/stream/reduce";

/**
 * The run, told as short lines that check off — the product's answer to "what is it doing?".
 * Pure presentation over the reducer's timeline; live, reopened and recorded sessions all
 * render through this one component.
 */
export function ActivityFeed({
  state,
  onRetry,
  summary = true,
}: {
  state: ActivityState;
  onRetry?: () => void;
  summary?: boolean;
}) {
  const lines = narrate(state);
  const done = summary ? doneSummary(state) : null;
  const elapsed = activeElapsedMs(state);
  const failed = state.outcome.kind === "failed";
  const failure = failed && state.outcome.error ? failureCopy(state.outcome.error) : null;
  const [showSteps, setShowSteps] = useState(false);
  const lastDone = [...lines].reverse().find((l) => l.state === "done");

  return (
    <section aria-label="Activity" className="grid gap-1.5">
      {/* Announce completed beats once; active lines stay visual-only so screen readers are
          not spammed by the shimmer line changing. */}
      <p className="sr-only" role="status">
        {failure ? failure.headline : (done ?? lastDone?.label ?? "")}
      </p>

      <ol className="grid gap-1.5">
        {lines.map((line) => (
          <li key={line.key} className="sw-feed-line" data-state={line.state}>
            <span className="sw-feed-icon" aria-hidden>
              {line.state === "done" && <Icon name="check" size={14} className="text-ok" />}
              {line.state === "failed" && <Icon name="x" size={14} className="text-danger" />}
              {line.state === "active" && <span className="sw-feed-pulse" />}
            </span>
            <span className={cn(line.state === "active" && "sw-feed-active-label")}>
              {line.label}
              {line.state === "active" && elapsed !== undefined && (
                <span className="ml-2 text-xs tabular-nums text-subtle">
                  {Math.round(elapsed / 1000)}s
                </span>
              )}
            </span>
            {line.fact && <span className="text-subtle">· {line.fact}</span>}
          </li>
        ))}
      </ol>

      {(state.phase === "reconnecting" && state.reconnects >= 2) && (
        <p className="pl-6 text-subtle">Reconnecting…</p>
      )}
      {state.phase === "failed" && !failed && (
        <div className="sw-feed-line" data-state="failed">
          <span className="sw-feed-icon" aria-hidden>
            <Icon name="warning" size={14} className="text-warn" />
          </span>
          <span>Lost the connection to the engine. Check it&rsquo;s running, then retry.</span>
          {onRetry && (
            <Button variant="ghost" onClick={onRetry} className="h-7 px-2">
              Retry
            </Button>
          )}
        </div>
      )}

      {done && (
        <div className="flex items-center gap-3 pl-6 pt-1">
          <span className="font-medium text-fg">{done}</span>
          <button
            type="button"
            onClick={() => setShowSteps((v) => !v)}
            aria-expanded={showSteps}
            className="inline-flex items-center gap-1 text-xs text-subtle hover:text-fg"
          >
            <Icon name="chevron" size={12} className={cn("transition-transform", showSteps && "rotate-90")} />
            {showSteps ? "Hide steps" : "Show steps"}
          </button>
        </div>
      )}
      {done && showSteps && (
        <div className="pl-6">
          <Trace stages={traceStages(state)} className="flex-nowrap overflow-x-auto" />
        </div>
      )}

      {failure && (
        <div className="sw-card mt-2 grid gap-2 p-4">
          <p className="text-fg">{failure.headline}</p>
          {onRetry && (
            <div>
              <Button variant="primary" onClick={onRetry}>
                Try again
              </Button>
            </div>
          )}
          <details className="text-xs text-subtle">
            <summary className="cursor-pointer">Technical details</summary>
            <p className="mt-1 font-mono">{failure.detail}</p>
          </details>
        </div>
      )}
    </section>
  );
}
