"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Icon } from "@/components/ui/icon";
import { Composer } from "@/components/workspace/composer";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import { apiPost, messageFor } from "@/lib/client/api";
import { RepoSchema } from "@/lib/contracts";
import { demoJob, demoRepo, demoRun, isDemoRepo } from "@/lib/fixtures";
import { repoDisplayName } from "@/lib/repo-name";
import { repoFiles, repoSession } from "@/lib/repo-routes";
import { relativeTime } from "@/lib/sessions";

/**
 * Where work on one repository happens. The repository is not a parameter of a session here —
 * it is the page, which is what makes "which repo am I in" answerable without a chip row.
 */
export function RepoHome({ repoId }: { repoId: string }) {
  const { live, repos, repoList, sessionsFor, submitting, submitError, queuedRepoId, run } =
    useWorkspace();
  const router = useRouter();
  // Resolved directly when it is the recording: `repoList` drops it as soon as the user has a
  // ready repository of their own, and a bookmarked demo URL must not become an error card.
  const repo = repoList.find((r) => r.id === repoId) ?? (isDemoRepo(repoId) ? demoRepo : null);
  const sessions = sessionsFor(repoId);
  const [reindexing, setReindexing] = useState(false);
  const [reindexError, setReindexError] = useState<string | null>(null);

  if (!repo) {
    // Still fetching is not the same as gone, and only one of them is worth an error.
    if (repos.loading) return <div aria-hidden className="sw-skeleton h-24" />;
    return (
      <div className="sw-card grid gap-3 p-5">
        <h2 className="text-subhead font-semibold text-fg">That repository isn&apos;t here</h2>
        <p className="text-muted">It may have been removed, or never finished importing.</p>
        <div>
          <Link href="/app/repos" className="sw-primary-link">
            Go to Repositories
          </Link>
        </div>
      </div>
    );
  }

  const reindex = async () => {
    setReindexing(true);
    setReindexError(null);
    try {
      await apiPost(RepoSchema, `/api/repos/${encodeURIComponent(repo.id)}/reindex`, {});
      repos.refresh(); // the row flips to importing, which restarts the poll
    } catch (e) {
      setReindexError(messageFor(e));
    } finally {
      setReindexing(false);
    }
  };

  const facts = [
    repo.ref,
    repo.symbols > 0
      ? `${repo.symbols.toLocaleString()} functions${repo.files ? ` across ${repo.files.toLocaleString()} files` : ""}`
      : null,
    `imported ${relativeTime(repo.created_at)}`,
  ].filter(Boolean);

  return (
    <div className="sw-repo-home">
      <header className="sw-repo-home-head">
        <div className="min-w-0">
          <h2 className="text-head font-semibold text-fg">{repoDisplayName(repo.slug)}</h2>
          <p className="mt-1 text-subtle">{facts.join(" · ")}</p>
        </div>
        <div className="sw-repo-home-actions">
          <Link href={repoFiles(repo.id)} className="sw-quiet-button">
            <Icon name="folder" size={14} />
            Browse files
          </Link>
          {live && !isDemoRepo(repo.id) && repo.status !== "importing" && (
            <button
              type="button"
              onClick={() => void reindex()}
              disabled={reindexing}
              title="The index is a snapshot of the checkout at import time — re-index after pulling new commits."
              className="sw-quiet-button"
            >
              <Icon name="refresh" size={14} />
              {reindexing ? "Re-indexing…" : "Re-index"}
            </button>
          )}
        </div>
      </header>

      {repo.status === "importing" && (
        <p role="status" className="text-muted">
          Indexing this repository — reading every Python file and mapping what calls what.
          Usually under a minute.
        </p>
      )}
      {repo.status === "failed" && (
        <p role="alert" className="text-danger">
          {repo.error || "This repository didn't import."}
        </p>
      )}
      {reindexError && (
        <p role="alert" className="text-danger">
          {reindexError}
        </p>
      )}

      <Composer
        repo={repo}
        busy={submitting}
        onRun={(issue) => {
          void run(issue, repo.id).then((id) => {
            if (id) router.push(repoSession(repo.id, id));
          });
        }}
        // The recording has no workspace to search, so its page offers the finished session
        // instead of a run that would fail.
        replay={isDemoRepo(repo.id)}
        hosted={!live}
        queued={queuedRepoId === repo.id}
        issueText={demoRun.issue}
        onReplay={() => router.push(repoSession(demoRepo.id, demoJob.id))}
        // Every example names a symbol in the recorded repository.
        showExamples={repo.slug === demoRepo.slug}
      />
      {submitError && (
        <p role="alert" className="text-danger">
          {submitError}
        </p>
      )}

      {/* No session grid here: the sidebar beside this page lists exactly these sessions,
          already scoped to this repository. Two renderings of one list was the launcher's
          mistake repeated. First-time emptiness gets one quiet line, because the sidebar's
          own empty copy sits under a heading the user may not have connected to this page. */}
      {sessions.length === 0 && (
        <p className="text-subtle">
          Nothing here yet — your sessions in this repository will collect in the sidebar.
        </p>
      )}
    </div>
  );
}
