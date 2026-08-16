"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import { apiGet, apiPost, messageFor } from "@/lib/client/api";
import { JobSchema, PullRequestListSchema } from "@/lib/contracts";
import type { PullRequest } from "@/lib/contracts";
import { repoSession } from "@/lib/repo-routes";

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
