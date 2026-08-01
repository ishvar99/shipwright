"use client";

import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { StatusDot } from "@/components/ui/status-dot";
import { RepoPicker } from "@/components/workspace/repo-picker";
import type { Repo } from "@/lib/contracts";
import { repoDisplayName } from "@/lib/repo-name";
import { cn } from "@/lib/cn";
import { readDraft, setDraft as saveDraft } from "@/lib/ui-prefs";

const MIN_CHARS = 8;
const MAX_CHARS = 20_000;

/** Example prompts for the demo repository — one click to a believable session. */
const EXAMPLES = [
  "Token refresh happens on every silent call — cache the authority validation.",
  "get_accounts returns stale results after a cache write.",
  "Regional endpoints ignore the configured authority host.",
];

function lengthProblem(issue: string): string | null {
  const len = issue.trim().length;
  if (len === 0) return "Describe the bug or the change first.";
  if (len < MIN_CHARS) return "Add a little more detail so the search has something to go on.";
  if (len > MAX_CHARS) return "That's longer than we can read — trim it under 20,000 characters.";
  return null;
}

function blockedBecause(
  repo: Repo | null,
  issue: string,
  busy: boolean,
  hasRepos: boolean,
): string | null {
  if (busy) return "Your current session is still running.";
  // With nothing imported, "choose" names an action that does not exist yet.
  if (!repo) return hasRepos ? "Choose a repository first." : "Import a repository first.";
  if (repo.status === "failed") return "This repository didn't import. Retry it from Repositories.";
  // Indexing is no longer a blocker: the run is parked and fires when the graph is ready, so
  // writing the issue and building the index happen in parallel rather than one after the
  // other. The symbol count is meaningless until that finishes, so it is not consulted yet.
  if (repo.status !== "importing" && repo.symbols === 0)
    return "No Python code found here — Shipwright reads Python today.";
  return lengthProblem(issue);
}

/** Past this many, a chip row is a wall of pills rather than a choice. */
const CHIP_LIMIT = 5;

export function Composer({
  repos = [],
  repo,
  onPickRepo,
  busy,
  onRun,
  replay,
  issueText,
  onReplay,
  hosted = false,
  queued = false,
  showExamples = true,
}: {
  /** Omitted where the repository is the page itself, which is what removes the chip row. */
  repos?: Repo[];
  repo: Repo | null;
  onPickRepo?: (repo: Repo) => void;
  busy: boolean;
  onRun: (issue: string) => void;
  replay: boolean;
  issueText?: string;
  onReplay?: () => void;
  /** No backend at all. The recording also appears on a local install with nothing imported,
   * where telling the reader to "run Shipwright locally" would be nonsense. */
  hosted?: boolean;
  /** A run for this repository is parked until indexing finishes. */
  queued?: boolean;
  /** The examples name symbols in the recorded repository, so they are wrong anywhere else. */
  showExamples?: boolean;
}) {
  const [issue, setIssue] = useState("");
  const [attempted, setAttempted] = useState(false);
  const id = useId();
  const draftKey = repo?.id ?? "";

  // Restored in an effect, and deliberately not during render or in a lazy initialiser: this
  // page is prerendered, so any of those would have the client's first pass produce different
  // markup from the server's and fail hydration. After-paint is the only correct time to read
  // storage into a controlled input.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- see above
    if (draftKey) setIssue(readDraft(draftKey));
  }, [draftKey]);

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
          {hosted
            ? "This hosted demo replays a real recorded session, long pauses shortened — run Shipwright locally to search your own repositories."
            : "A real recorded session, long pauses shortened. Import a repository to run your own."}
        </p>
      </div>
    );
  }

  const blocked = blockedBecause(repo, issue, busy, repos.length > 0);

  return (
    <form
      className="sw-card grid gap-3 p-5"
      onSubmit={(e) => {
        e.preventDefault();
        setAttempted(true);
        if (!blocked) {
          // Neither the textarea nor the stored draft is cleared here. Submitting is not the
          // same as starting: the run can fail, or park behind indexing, and this component
          // cannot tell. The provider clears the draft once a session actually exists.
          onRun(issue.trim());
          setAttempted(false);
        }
      }}
    >
      {/* Chips while they still fit; a searchable picker once scanning tints stops working. */}
      {onPickRepo && repos.length > 0 && repos.length <= CHIP_LIMIT && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Repository">
          {repos.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => onPickRepo(r)}
              aria-pressed={r.id === repo?.id}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-[var(--radius)] border px-3 py-1 text-xs font-medium transition-colors",
                // A check plus a border, not tint alone: two soft washes are not an affordance.
                r.id === repo?.id
                  ? "border-accent bg-accent-soft text-fg"
                  : "border-hairline bg-soft text-muted hover:text-fg",
              )}
            >
              {r.id === repo?.id && <Icon name="check" size={12} className="text-accent" />}
              {r.status !== "ready" && <StatusDot tone={r.status === "failed" ? "bad" : "active"} />}
              {repoDisplayName(r.slug)}
            </button>
          ))}
        </div>
      )}
      {onPickRepo && repos.length > CHIP_LIMIT && (
        <RepoPicker repos={repos} repo={repo} onPick={onPickRepo} />
      )}

      <label htmlFor={id} className="sr-only">
        Describe the bug or the change
      </label>
      <textarea
        id={id}
        value={issue}
        onChange={(e) => {
          setIssue(e.target.value);
          if (draftKey) saveDraft(draftKey, e.target.value);
        }}
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
        {/* Setup is legible instead of obstructive: the button works, and this says what will
            happen when it is pressed. Independent of `blocked` — a parked run has an empty
            draft again, and gating the banner on validity hid it exactly when it mattered. */}
        {queued ? (
          <span role="status" className="text-subtle">
            Queued — this starts the moment indexing finishes.
          </span>
        ) : repo?.status === "importing" ? (
          <span className="text-subtle">Still indexing — press it anyway and we&apos;ll wait.</span>
        ) : null}
      </div>

      {showExamples && !issue && (
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
