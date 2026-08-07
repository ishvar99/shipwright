"use client";

import { useEffect, useId, useRef, useState } from "react";
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

/** Example prompts for the demo repository — one click to a believable session. One per
 * intent, so the breadth (ask, report, request) is shown rather than claimed. */
const EXAMPLES = [
  "How does the token cache decide what to evict?",
  "get_accounts returns stale results after a cache write.",
  "Add a timeout to the regional endpoint lookup.",
];

function lengthProblem(issue: string): string | null {
  const len = issue.trim().length;
  if (len === 0) return "Ask a question or describe a change first.";
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
  // With the section fallback, zero symbols means genuinely nothing textual survived import.
  if (repo.status !== "importing" && repo.symbols === 0)
    return "Nothing to read here — this repository has no text files Shipwright can index.";
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
  showExamples = false,
  autoFocus = false,
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
  /** Where the composer IS the page (launcher, repo home), arriving ready to type is the
   * point. Never used where it would steal focus from something else. */
  autoFocus?: boolean;
}) {
  const [issue, setIssue] = useState("");
  const [attempted, setAttempted] = useState(false);
  const id = useId();
  const draftKey = repo?.id ?? "";
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    // preventScroll: focus should never yank a page that has content above the composer.
    if (autoFocus) inputRef.current?.focus({ preventScroll: true });
  }, [autoFocus]);

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
      <div className="sw-composer">
        <label htmlFor={id} className="sr-only">
          Recorded request
        </label>
        <textarea
          id={id}
          readOnly
          value={issueText ?? ""}
          rows={3}
          className="sw-composer-input"
        />
        <div className="sw-composer-bar">
          <Button variant="primary" onClick={onReplay} className="ml-auto shrink-0">
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
  const dimmed = Boolean(blocked && blocked !== lengthProblem(issue));

  return (
    <div className="grid gap-2">
    <form
      className="sw-composer"
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
      <label htmlFor={id} className="sr-only">
        Ask about the code or describe a change
      </label>
      {/* The input first, bare inside the card; the controls sit on a bar beneath it. That is
          the grammar every chat product has taught: write here, aim and send below. */}
      <textarea
        id={id}
        ref={inputRef}
        value={issue}
        onChange={(e) => {
          setIssue(e.target.value);
          if (draftKey) saveDraft(draftKey, e.target.value);
        }}
        onKeyDown={(e) => {
          // The chat-product grammar: ⌘⏎ (or Ctrl+⏎) sends, Enter stays a newline — a bug
          // report is multi-line prose, so plain Enter must never fire the run.
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            e.currentTarget.form?.requestSubmit();
          }
        }}
        rows={3}
        placeholder="Describe a bug, a change, or a question about this code."
        className="sw-composer-input"
      />

      <div className="sw-composer-bar">
        {/* Chips while they still fit; a searchable picker once scanning tints stops working.
            None at all for a single repository — a one-item "choice" is furniture, and the
            sidebar already names the repo. */}
        {onPickRepo && repos.length > 1 && repos.length <= CHIP_LIMIT && (
          <div className="flex min-w-0 flex-wrap gap-1.5" role="group" aria-label="Repository">
            {repos.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => onPickRepo(r)}
                aria-pressed={r.id === repo?.id}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-[var(--radius)] border px-3 py-1 text-xs font-medium transition-colors",
                  // The selected chip keeps its border — a check plus a border, not tint
                  // alone. Unselected ones drop theirs (transparent, so nothing shifts):
                  // a bordered pill inside the composer's own ring was outline on outline.
                  r.id === repo?.id
                    ? "border-accent bg-accent-soft text-fg hover:bg-soft"
                    : "border-transparent bg-soft text-muted hover:text-fg",
                )}
              >
                {r.id === repo?.id && <Icon name="check" size={12} className="text-accent" />}
                {r.status !== "ready" && (
                  <StatusDot tone={r.status === "failed" ? "bad" : "active"} />
                )}
                {repoDisplayName(r.slug)}
              </button>
            ))}
          </div>
        )}
        {onPickRepo && repos.length > CHIP_LIMIT && (
          <RepoPicker repos={repos} repo={repo} onPick={onPickRepo} />
        )}

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

        <Button
          variant="primary"
          type="submit"
          aria-disabled={dimmed ? true : undefined}
          title="⌘⏎ to send"
          className="ml-auto shrink-0"
        >
          <Icon name="send" size={16} />
          Ask Shipwright
        </Button>
      </div>

    </form>
      {showExamples && !issue && (
        <div className="flex flex-wrap gap-1.5">
          {EXAMPLES.map((e) => (
            <button key={e} type="button" onClick={() => setIssue(e)} className="sw-example">
              {e}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
