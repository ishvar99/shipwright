"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { StatusDot } from "@/components/ui/status-dot";
import type { Repo } from "@/lib/contracts";
import { cn } from "@/lib/cn";

const MIN_CHARS = 8;
const MAX_CHARS = 20_000;

/** Example prompts for the demo repository — one click to a believable session. */
const EXAMPLES = [
  "Token refresh happens on every silent call — cache the authority validation.",
  "get_accounts returns stale results after a cache write.",
  "Regional endpoints ignore the configured authority host.",
];

function blockedBecause(repo: Repo | null, issue: string, busy: boolean): string | null {
  if (busy) return "Your current session is still running.";
  if (!repo) return "Choose a repository first.";
  if (repo.status === "importing") return "Still indexing this repository — usually under a minute.";
  if (repo.status === "failed") return "This repository didn't import. Retry it from Repositories.";
  if (repo.symbols === 0) return "No Python code found here — Shipwright reads Python today.";
  const len = issue.trim().length;
  if (len === 0) return "Describe the bug or the change first.";
  if (len < MIN_CHARS) return "Add a little more detail so the search has something to go on.";
  if (len > MAX_CHARS) return "That's longer than we can read — trim it under 20,000 characters.";
  return null;
}

export function Composer({
  repos,
  repo,
  onPickRepo,
  busy,
  onRun,
  replay,
  issueText,
  onReplay,
}: {
  repos: Repo[];
  repo: Repo | null;
  onPickRepo: (repo: Repo) => void;
  busy: boolean;
  onRun: (issue: string) => void;
  replay: boolean;
  issueText?: string;
  onReplay?: () => void;
}) {
  const [issue, setIssue] = useState("");
  const [attempted, setAttempted] = useState(false);
  const id = useId();

  if (replay) {
    return (
      <div className="sw-card grid gap-3 p-5">
        <label htmlFor={id} className="sr-only">
          Recorded request
        </label>
        <textarea
          id={id}
          readOnly
          value={issueText ?? ""}
          rows={3}
          className="sw-textarea"
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" onClick={onReplay}>
            <Icon name="send" size={16} />
            Replay this session
          </Button>
        </div>
        <p className="text-xs text-subtle">
          This hosted demo replays a real recorded session, long pauses shortened — run
          Shipwright locally to search your own repositories.
        </p>
      </div>
    );
  }

  const blocked = blockedBecause(repo, issue, busy);

  return (
    <form
      className="sw-card grid gap-3 p-5"
      onSubmit={(e) => {
        e.preventDefault();
        setAttempted(true);
        if (!blocked) {
          onRun(issue.trim());
          setAttempted(false);
        }
      }}
    >
      {repos.length > 0 && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Repository">
          {repos.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => onPickRepo(r)}
              aria-pressed={r.id === repo?.id}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors",
                r.id === repo?.id
                  ? "bg-accent-soft text-fg"
                  : "bg-soft text-muted hover:text-fg",
              )}
            >
              {r.status !== "ready" && <StatusDot tone={r.status === "failed" ? "bad" : "active"} />}
              {r.slug.replace(/^local:/, "").split("__").pop()}
            </button>
          ))}
        </div>
      )}

      <label htmlFor={id} className="sr-only">
        Describe the bug or the change
      </label>
      <textarea
        id={id}
        value={issue}
        onChange={(e) => setIssue(e.target.value)}
        rows={3}
        placeholder="Describe the bug or the change — paste the ticket if you have one."
        className="sw-textarea"
      />

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" type="submit" aria-disabled={blocked ? true : undefined}>
          <Icon name="send" size={16} />
          Find the code
        </Button>
        {attempted && blocked && <span className="text-danger">{blocked}</span>}
      </div>

      {!issue && (
        <div className="flex flex-wrap gap-1.5">
          {EXAMPLES.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => setIssue(e)}
              className="rounded-full bg-soft px-3 py-1 text-left text-xs text-muted transition-colors hover:text-fg"
            >
              {e}
            </button>
          ))}
        </div>
      )}
    </form>
  );
}
