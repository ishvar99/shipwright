"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { FindingRow } from "@/components/workspace/finding-row";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import { apiGet, apiPost, messageFor } from "@/lib/client/api";
import { JobSchema, PullRequestListSchema } from "@/lib/contracts";
import type { PullRequest } from "@/lib/contracts";
import { repoSession } from "@/lib/repo-routes";
import { coverageSentence } from "@/lib/review";

/**
 * Pick one of the repository's open pull requests and review it.
 *
 * Loading is a skeleton, never empty-state copy — "no open pull requests" while a fetch is in
 * flight would be a claim we cannot yet make.
 */
export function ReviewView({ repoId }: { repoId: string }) {
  const { repoList } = useWorkspace();
  const router = useRouter();
  const repo = repoList.find((r) => r.id === repoId);

  const [pulls, setPulls] = useState<PullRequest[] | null>(null);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(0);

  // Same shape as account-row.tsx: state is only ever set past the await boundary, and an
  // `alive` flag keeps a late response from writing into an unmounted view.
  useEffect(() => {
    let alive = true;
    void apiGet(PullRequestListSchema, `/api/repos/${repoId}/pulls`)
      .then((rows) => {
        if (alive) setPulls(rows);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setPulls([]);
        setError(messageFor(e));
      });
    return () => {
      alive = false;
    };
  }, [repoId]);

  async function review(number: number) {
    setStarting(number);
    setError("");
    try {
      const job = await apiPost(JobSchema, "/api/reviews", { repo_id: repoId, number });
      router.push(repoSession(repoId, job.id));
    } catch (e) {
      setError(messageFor(e));
      setStarting(0);
    }
  }

  if (repo && repo.source !== "github") {
    return (
      <div className="sw-repo-home">
        <h1 className="text-head font-semibold text-fg">Review a pull request</h1>
        <p className="text-muted">
          This repository was not imported from GitHub, so it has no pull requests to review.
        </p>
      </div>
    );
  }

  return (
    <div className="sw-repo-home">
      <header>
        <h1 className="text-head font-semibold text-fg">Review a pull request</h1>
        <p className="mt-1 text-subtle">
          {repo?.slug ?? "This repository"} · findings are anchored to lines the diff changed,
          and nothing is posted to GitHub unless you ask.
        </p>
      </header>

      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}

      {pulls === null ? (
        <div aria-hidden className="grid gap-1">
          <div className="sw-skeleton h-14" />
          <div className="sw-skeleton h-14" />
          <div className="sw-skeleton h-14" />
        </div>
      ) : pulls.length === 0 && !error ? (
        <p className="text-muted">No open pull requests on this repository.</p>
      ) : (
        <ul className="grid gap-2">
          {pulls.map((pr, i) => (
            <li
              key={pr.number}
              className="sw-card sw-rise-in flex items-center justify-between gap-3 p-4"
              style={{ animationDelay: `${Math.min(i, 6) * 45}ms` }}
            >
              <div className="min-w-0">
                <p className="truncate font-medium text-fg">
                  #{pr.number} {pr.title}
                </p>
                <p className="mt-1 truncate text-xs text-subtle">
                  {pr.author}
                  {pr.draft && " · draft"}
                </p>
              </div>
              <Button
                variant="secondary"
                aria-disabled={starting === pr.number || undefined}
                onClick={() => void review(pr.number)}
              >
                <Icon name="crosshair" size={14} />
                {starting === pr.number ? "Starting…" : "Review"}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The findings panel, rendered inside a finished review session. */
export function ReviewFindings({
  findings,
  coverage,
  onPost,
  posting,
  reviewUrl,
}: {
  findings: import("@/lib/contracts").Finding[];
  coverage: import("@/lib/contracts").ReviewCoverage;
  onPost?: () => void;
  posting?: boolean;
  reviewUrl?: string;
}) {
  return (
    <section className="grid gap-2">
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
            <Button
              variant="primary"
              aria-disabled={posting || undefined}
              onClick={onPost}
              title="Posts one review with every finding as an inline comment. Never approves or requests changes."
            >
              {posting ? "Posting…" : "Post to GitHub"}
            </Button>
          )
        )}
      </div>

      {/* Silence has to be evidence: say what was checked, not just that nothing was found. */}
      <p className="text-subtle">{coverageSentence(coverage)}</p>

      {findings.length > 0 && (
        <ul className="grid gap-2">
          {findings.map((f, i) => (
            <FindingRow key={`${f.path}:${f.line}:${f.category}`} finding={f} index={i} />
          ))}
        </ul>
      )}
    </section>
  );
}
