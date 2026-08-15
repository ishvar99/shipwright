"use client";

import { Markdown } from "@/components/ui/markdown";
import type { Finding } from "@/lib/contracts";
import { categoryLabel, severityLabel, severityTone } from "@/lib/review";
import { cn } from "@/lib/cn";

/**
 * One finding, anchored to the line it is about.
 *
 * The severity chip reuses the outcome palette and nothing else — the four evidence hues mean
 * retrieval channels and never carry state. There is no confidence percentage because none is
 * computed; the label claims only what the analysis knows.
 */
export function FindingRow({ finding, index }: { finding: Finding; index: number }) {
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

      {finding.body && finding.body !== finding.title && (
        <div className="text-muted">
          <Markdown text={finding.body} />
        </div>
      )}
    </li>
  );
}
