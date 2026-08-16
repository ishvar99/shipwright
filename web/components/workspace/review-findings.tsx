"use client";

import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { FindingRow } from "@/components/workspace/finding-row";
import { ReviewReceipt } from "@/components/workspace/review-receipt";
import { apiGet, apiPost, messageFor } from "@/lib/client/api";
import { PullRequestListSchema, type Finding, type ReviewCoverage } from "@/lib/contracts";
import { coverageSentence, fillUndecided, findingKey, keptCount, type TriageMap } from "@/lib/review";

/** The triage endpoint's response — a whole-map replace, so the client never diffs. */
const SavedSchema = z.object({ ok: z.boolean(), kept: z.number() });

/**
 * Warns that the pull request has moved past the sha this review actually read.
 *
 * Fetches once per mount rather than staying live — freshness here is a courtesy, not a
 * guarantee; the posting-layer 422 (GitHub rejects a comment outside the diff) remains the
 * hard wall. A failed fetch or a PR that has not moved renders nothing: this is never an
 * error banner, only ever a heads-up.
 */
export function MovedBanner({
  repoId,
  number,
  reviewedSha,
  live,
}: {
  repoId: string;
  number: number;
  reviewedSha: string;
  live: boolean;
}) {
  const [currentSha, setCurrentSha] = useState<string | null>(null);
  // Same shape as ReviewView's own pulls fetch and account-row.tsx: state is only ever set
  // past the await boundary, and an `alive` flag keeps a late response from writing into an
  // unmounted view.
  useEffect(() => {
    if (!live || !reviewedSha || !number) return;
    let alive = true;
    void apiGet(PullRequestListSchema, `/api/repos/${repoId}/pulls`)
      .then((rows) => {
        if (alive) setCurrentSha(rows.find((p) => p.number === number)?.head_sha ?? null);
      })
      .catch(() => undefined); // freshness is a courtesy; never an error banner
    return () => {
      alive = false;
    };
  }, [live, repoId, number, reviewedSha]);

  if (!currentSha || currentSha === reviewedSha) return null;
  return (
    <p
      role="status"
      className="rounded-[var(--radius)] border border-hairline bg-warn-soft px-3 py-2 text-warn"
    >
      This pull request has moved since the review. Review it again before posting.
    </p>
  );
}

/** The findings panel, rendered inside a finished review session — the triage desk once
 * `jobId`/`onPost` are live, a read-only recap on a recorded or already-posted session. */
export function ReviewFindings({
  findings,
  coverage,
  jobId,
  initialTriage,
  repoId,
  number,
  headSha,
  title,
  live,
  onPost,
  posting,
  reviewUrl,
}: {
  findings: Finding[];
  coverage: ReviewCoverage;
  jobId: string;
  initialTriage: TriageMap;
  /** The pull request this review read, and the sha it read it at — for the moved-banner
   * freshness check and the receipt's byline. */
  repoId: string;
  number: number;
  headSha: string;
  /** The pull request's own title, for the receipt — distinct from the session's title,
   * which is the generic "Review pull request #N". */
  title: string;
  /** Live network session vs. demo/local replay — gates the moved-banner's fetch. */
  live: boolean;
  onPost?: () => void;
  posting?: boolean;
  reviewUrl?: string;
}) {
  const [triage, setTriage] = useState<TriageMap>(initialTriage);
  const [saveError, setSaveError] = useState("");
  const kept = keptCount(triage);
  // A read-only/recorded session passes no onPost, so this one flag governs whether any
  // handler reaches FindingRow — hoisted so the three props below don't each repeat the check.
  const canTriage = Boolean(onPost);

  // Serializes the POSTs: the endpoint is a read-modify-write, so two rapid decisions racing
  // in flight could let the older whole-map win and silently undo the newer one, with no
  // error surfaced. Chaining onto the same promise means the second send only starts once the
  // first has settled, so the server always applies them in the order the user made them.
  const chain = useRef<Promise<unknown>>(Promise.resolve());

  function persist(next: TriageMap) {
    setTriage(next);
    setSaveError("");
    chain.current = chain.current
      .catch(() => undefined)
      .then(() => apiPost(SavedSchema, `/api/jobs/${jobId}/triage`, { decisions: next }))
      .catch((e: unknown) => setSaveError(messageFor(e)));
  }

  const decide = (key: string, state: "kept" | "dismissed", reason = "") =>
    persist({ ...triage, [key]: { state, reason } });

  // Undoes a dismissal (or a keep) back to undecided — a mis-click on the one-click dismiss
  // control would otherwise be permanent until the whole review is redone.
  const undecide = (key: string) => {
    const next = { ...triage };
    delete next[key];
    persist(next);
  };

  // Fills only the UNDECIDED findings — an existing keep or dismissal is a decision the user
  // already made, and this button reads as "finish the rest", not "discard my triage".
  const keepAll = () => persist(fillUndecided(findings.map(findingKey), triage));

  // The receipt's dismissal breakdown, by reason — computed from the same triage map the
  // cards render from, so it never drifts from what the desk is showing.
  const dismissed = Object.values(triage).reduce<Record<string, number>>((acc, t) => {
    if (t.state === "dismissed") acc[t.reason] = (acc[t.reason] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <section className="grid gap-2">
      {/* Only worth asking while nothing has posted yet — once a review is on GitHub,
          "review it again before posting" no longer applies. */}
      {!reviewUrl && (
        <MovedBanner repoId={repoId} number={number} reviewedSha={headSha} live={live} />
      )}

      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="sw-section-label">
          {findings.length === 0
            ? "No blocking findings"
            : `${findings.length} finding${findings.length === 1 ? "" : "s"}`}
        </h3>
        {reviewUrl ? (
          <a
            href={reviewUrl}
            target="_blank"
            rel="noreferrer"
            className="rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent"
          >
            Posted to GitHub ↗
          </a>
        ) : (
          findings.length > 0 &&
          onPost && (
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={keepAll}>
                Keep all
              </Button>
              <Button
                variant="primary"
                aria-disabled={posting || kept === 0 || Boolean(saveError) || undefined}
                // Awaits the triage chain first. The server re-reads the row when the action
                // runs, so posting before the last save lands would either be refused as
                // "keep at least one finding" moments after the button said 5, or — worse —
                // post a finding the engineer had just dismissed.
                onClick={() => void chain.current.then(onPost)}
                title="Posts one review with every kept finding as an inline comment. Never approves or requests changes."
              >
                {posting ? "Posting…" : `Post ${kept} kept finding${kept === 1 ? "" : "s"}`}
              </Button>
            </div>
          )
        )}
      </div>

      {/* Silence has to be evidence: say what was checked, not just that nothing was found. */}
      <p className="text-subtle">{coverageSentence(coverage)}</p>

      {saveError && (
        <p role="alert" className="text-danger">
          {saveError}
        </p>
      )}

      {findings.length > 0 && (
        <ul className="grid gap-2">
          {findings.map((f, i) => (
            <FindingRow
              key={findingKey(f)}
              finding={f}
              index={i}
              verdict={triage[findingKey(f)]}
              onKeep={canTriage ? () => decide(findingKey(f), "kept") : undefined}
              onDismiss={canTriage ? (reason) => decide(findingKey(f), "dismissed", reason) : undefined}
              onUndo={canTriage ? () => undecide(findingKey(f)) : undefined}
            />
          ))}
        </ul>
      )}

      <ReviewReceipt
        title={title}
        number={number}
        headSha={headSha}
        coverage={coverage}
        findings={findings.length}
        kept={kept}
        dismissed={dismissed}
        reviewUrl={reviewUrl ?? ""}
      />
    </section>
  );
}
