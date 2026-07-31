"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import type { Repo } from "@/lib/contracts";

const MIN_CHARS = 8;
const MAX_CHARS = 20_000;

/** First matching reason wins, and it is shown rather than implied — a disabled control that
 * does not say why is the most common way a workspace reads as broken. */
function blockedBecause(repo: Repo | null, issue: string, busy: boolean): string | null {
  if (busy) return "A job is already running.";
  if (!repo) return "Select an indexed repository.";
  if (repo.status === "importing") return "This repository is still being indexed.";
  if (repo.status === "failed") return "This repository failed to index. Retry the import first.";
  if (repo.symbols === 0) return "No symbols were indexed in this repository.";
  const len = issue.trim().length;
  if (len === 0) return "Describe the issue to run a search.";
  if (len < MIN_CHARS) return `Add at least ${MIN_CHARS - len} more character${MIN_CHARS - len === 1 ? "" : "s"}.`;
  if (len > MAX_CHARS) return `Shorten the issue by ${len - MAX_CHARS} characters.`;
  return null;
}

export function Composer({
  repo,
  busy,
  onRun,
  replay,
  issueText,
}: {
  repo: Repo | null;
  busy: boolean;
  onRun: (issue: string) => void;
  replay: boolean;
  issueText?: string;
}) {
  // Local state is the only source of truth for the issue: the job record truncates it to 400
  // characters, so rehydrating from a server response would silently shorten what you typed.
  const [issue, setIssue] = useState("");
  const hintId = useId();

  if (replay) {
    return (
      <div className="p-gutter">
        <label className="mb-1 block text-xs uppercase tracking-wide text-subtle" htmlFor={hintId}>
          issue (recorded)
        </label>
        <textarea
          id={hintId}
          readOnly
          value={issueText ?? ""}
          rows={4}
          className="w-full resize-none rounded-[var(--radius)] border border-hairline bg-soft p-gutter font-mono text-[length:var(--text-ui)] text-muted"
        />
        <p className="mt-1 text-subtle">
          This deployment has no live backend, so the run above is a recording. The trace and
          results are the real components, driven by the recorded stream.
        </p>
      </div>
    );
  }

  const blocked = blockedBecause(repo, issue, busy);

  return (
    <form
      className="p-gutter"
      onSubmit={(e) => {
        e.preventDefault();
        if (!blocked) onRun(issue.trim());
      }}
    >
      <label className="mb-1 block text-xs uppercase tracking-wide text-subtle" htmlFor={hintId}>
        issue
      </label>
      <textarea
        id={hintId}
        value={issue}
        onChange={(e) => setIssue(e.target.value)}
        rows={4}
        placeholder="Describe the bug or change, as you would in a ticket."
        aria-describedby={`${hintId}-hint`}
        className="w-full resize-y rounded-[var(--radius)] border border-hairline bg-soft p-gutter font-mono text-[length:var(--text-ui)] text-fg"
      />
      <div className="mt-2 flex items-center gap-3">
        {/* aria-disabled, not disabled: the button stays in the tab order so a keyboard user can
            reach it and hear why it is unavailable. */}
        <Button variant="primary" type="submit" aria-disabled={blocked ? true : undefined}>
          Run
        </Button>
        <span id={`${hintId}-hint`} className="text-subtle">
          {blocked ?? `${issue.trim().length} characters · ${repo?.slug ?? ""}`}
        </span>
      </div>
    </form>
  );
}
