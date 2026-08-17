"use client";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Markdown } from "@/components/ui/markdown";
import type { Finding } from "@/lib/contracts";
import {
  categoryLabel,
  DISMISS_REASONS,
  hunkLines,
  severityLabel,
  severityTone,
  type TriageState,
} from "@/lib/review";
import { cn } from "@/lib/cn";

/**
 * One finding, anchored to the line it is about — and, once triaged, a judgment surface.
 *
 * The severity chip reuses the outcome palette and nothing else — the four evidence hues mean
 * retrieval channels and never carry state. There is no confidence percentage because none is
 * computed; the label claims only what the analysis knows.
 */
export function FindingRow({
  finding,
  index,
  verdict,
  onKeep,
  onDismiss,
  onUndo,
}: {
  finding: Finding;
  index: number;
  /** This finding's saved triage decision, if any. */
  verdict?: TriageState;
  /** Present only where triage is live — a read-only/recorded session passes neither. */
  onKeep?: () => void;
  onDismiss?: (reason: string) => void;
  /** Reverts a dismissal (or a keep) back to undecided — a mis-click on the one-click
   * dismiss control would otherwise be permanent. Present only where triage is live. */
  onUndo?: () => void;
}) {
  // Dismissed collapses to one line — never removed, since the record of the decision is the
  // point — so the desk reads as "handled", not as a card the reviewer still has to scan.
  // Where triage is live the whole row is a button so a mis-click is one click to undo.
  if (verdict?.state === "dismissed") {
    const content = (
      <>
        <Icon name="x" size={13} className="shrink-0" />
        <span className="sw-truncate">{finding.title}</span>
        <span className="ml-auto shrink-0 rounded-full bg-soft px-2 py-0.5 text-xs">
          {DISMISS_REASONS[verdict.reason] ?? verdict.reason}
        </span>
      </>
    );
    return onUndo ? (
      <li>
        <button
          type="button"
          title="Undo this dismissal"
          onClick={onUndo}
          className="flex w-full items-center gap-2 px-4 py-2 text-left text-subtle hover:bg-soft"
        >
          {content}
        </button>
      </li>
    ) : (
      <li className="flex items-center gap-2 px-4 py-2 text-subtle">{content}</li>
    );
  }

  return (
    <li
      className="sw-card sw-rise-in grid gap-2 p-4"
      style={{ animationDelay: `${Math.min(index, 8) * 40}ms` }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-xs font-medium",
            severityTone(finding.severity),
          )}
        >
          {severityLabel(finding.severity)}
        </span>
        <span className="rounded-full bg-soft px-2 py-0.5 text-xs text-subtle">
          {categoryLabel(finding.category)}
        </span>
        {finding.rule && (
          <span className="rounded-full bg-soft px-2 py-0.5 text-xs text-subtle">
            {finding.rule}
          </span>
        )}
        {finding.agreed && (
          <span className="rounded-full bg-soft px-2 py-0.5 text-xs text-subtle">
            two checks agree
          </span>
        )}
      </div>

      <p className="font-medium text-fg">{finding.title}</p>

      <p className="font-mono text-xs text-subtle">
        {finding.path}:{finding.line}
        {finding.side === "LEFT" && " (removed line)"}
      </p>

      {finding.hunk && (
        <div className="overflow-x-auto rounded-[var(--radius)] border border-hairline">
          <pre className="sw-diff">
            {hunkLines(finding.hunk).map((l, j) => (
              <div key={j} className={cn("sw-diff-line", `sw-diff-${l.kind}`)}>
                <span aria-hidden className="sw-diff-sign">
                  {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
                </span>
                {l.text || " "}
              </div>
            ))}
          </pre>
        </div>
      )}

      {finding.body && finding.body !== finding.title && (
        <div className="text-muted">
          <Markdown text={finding.body} />
        </div>
      )}

      {onKeep && onDismiss && (
        <div className="flex flex-wrap items-center gap-2">
          {verdict?.state === "kept" ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-ok-soft px-2 py-0.5 text-xs font-medium text-ok">
              <Icon name="check" size={12} />
              Kept
            </span>
          ) : (
            <Button variant="secondary" onClick={onKeep}>
              Keep
            </Button>
          )}
          {/* Outside-click is deliberately not handled here — that needs the ref/effect
              machinery repo-picker.tsx already has for its own popover, and wiring a second
              copy of it is more than a dismiss-reason menu warrants. Escape still closes it. */}
          <details
            className="relative"
            onKeyDown={(e) => {
              if (e.key === "Escape") e.currentTarget.removeAttribute("open");
            }}
          >
            <summary className="sw-quiet-button list-none">Dismiss…</summary>
            <div className="absolute z-10 mt-1 grid gap-1 rounded-[var(--radius-card)] border border-hairline bg-surface p-1 shadow-[var(--shadow-2)]">
              {Object.entries(DISMISS_REASONS).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className="rounded-[var(--radius)] px-2 py-1 text-left text-xs hover:bg-soft"
                  onClick={() => onDismiss(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </details>
        </div>
      )}
    </li>
  );
}
