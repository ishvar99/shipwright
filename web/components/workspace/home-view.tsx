"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";
import { StatusDot } from "@/components/ui/status-dot";
import { Composer } from "@/components/workspace/composer";
import { FirstRun } from "@/components/workspace/first-run";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import { demoJob, demoRepo, demoRun, isDemoJob, isDemoRepo } from "@/lib/fixtures";
import { repoDisplayName } from "@/lib/repo-name";
import { repoHome, repoSession } from "@/lib/repo-routes";
import { SESSION_TONE, relativeTime, sessionTitle } from "@/lib/sessions";

export function HomeView() {
  const {
    live,
    demoVisible,
    repos,
    repoList,
    sessions,
    currentRepo,
    selectRepo,
    submitting,
    submitError,
    queuedRepoId,
    run,
  } = useWorkspace();
  const router = useRouter();
  // With nothing imported, the composer is the wrong hero: it points at the one action the user
  // cannot take, and the only thing that works is a tertiary card at the bottom of the page.
  const empty = live && !repos.repos.length && !repos.loading;
  // The composer can only replay when the recording is what it is aimed at.
  const replay = isDemoRepo(currentRepo?.id);

  return (
    <div className="sw-home">
      {live && (
        <FirstRun
          exampleVisible={demoVisible}
          ownRepos={repos.repos.length}
          ownSessions={sessions.filter((j) => !isDemoJob(j.id)).length}
          exampleHref={repoSession(demoRepo.id, demoJob.id)}
        />
      )}

      {empty && (
        <div className="sw-card grid gap-3 p-5">
          <h2 className="text-head font-semibold text-fg">Import a repository to get started</h2>
          <p className="text-muted">
            Paste a GitHub URL, point at a local folder, or drop a .zip anywhere on this page.
            Shipwright indexes it and then finds the code behind any bug you describe. Meanwhile
            the session below is a real recorded run — open it to see what a finished one looks
            like.
          </p>
          <div>
            <Link href="/app/repos" className="sw-primary-link">
              <Icon name="plus" size={16} />
              Add a repository
            </Link>
          </div>
        </div>
      )}

      <div className={cn("sw-home-composer", empty && "sw-home-muted")}>
        <h2 className="text-head font-semibold text-fg">
          Describe a bug or a change. Shipwright finds where in the code it lives.
        </h2>
        <Composer
          repos={repoList}
          repo={currentRepo}
          onPickRepo={selectRepo}
          busy={submitting}
          onRun={(issue) => {
            void run(issue).then((id) => {
              if (id && currentRepo) router.push(repoSession(currentRepo.id, id));
            });
          }}
          replay={replay}
          hosted={!live}
          queued={queuedRepoId === currentRepo?.id}
          issueText={demoRun.issue}
          onReplay={() => router.push(repoSession(demoRepo.id, demoJob.id))}
        />
        {submitError && (
          <p role="alert" className="text-danger">
            {submitError}
          </p>
        )}
      </div>

      {sessions.length > 0 && (
        <section className="sw-home-section" aria-labelledby="recent-sessions">
          <h3 id="recent-sessions" className="text-sm font-medium text-subtle">
            Recent sessions
          </h3>
          <ul className="sw-home-grid">
            {sessions.slice(0, 6).map((job) => (
              <li key={job.id}>
                <Link
                  href={repoSession(job.repo_id, job.id)}
                  title={sessionTitle(job.issue)}
                  className="sw-card sw-lift sw-home-card w-full"
                >
                  <span className="sw-home-card-title">{sessionTitle(job.issue)}</span>
                  <span className="sw-home-card-meta">
                    {/* The dot is aria-hidden, so the status needs a text equivalent. */}
                    <StatusDot tone={SESSION_TONE[job.status]} />
                    <span className="sr-only">{job.status}</span>
                    {job.repo_slug && (
                      <span className="sw-truncate">{repoDisplayName(job.repo_slug)}</span>
                    )}
                    {/* Named, so nobody mistakes it for a run they started. */}
                    {isDemoJob(job.id) ? (
                      <span className="shrink-0 rounded-full bg-soft px-1.5 font-medium">
                        Recorded
                      </span>
                    ) : (
                      <span className="shrink-0">{relativeTime(job.created_at)}</span>
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="sw-home-section" aria-labelledby="home-repos">
        <h3 id="home-repos" className="text-sm font-medium text-subtle">
          Repositories
        </h3>
        {repos.error && <p className="text-danger">{repos.error}</p>}
        <ul className="sw-home-grid">
          {repoList.slice(0, 5).map((r) => (
            <li key={r.id}>
              <Link
                href={r.status === "ready" ? repoHome(r.id) : "/app/repos"}
                className="sw-card sw-lift sw-home-card w-full"
              >
                <span className="sw-home-card-title">{repoDisplayName(r.slug)}</span>
                <span className="sw-home-card-meta">
                  {isDemoRepo(r.id)
                    ? "Recorded example — a real repository and a real session"
                    : r.status === "ready"
                    ? r.symbols === 0
                      ? "Browse and edit"
                      : `${r.symbols.toLocaleString()} functions`
                    : r.status === "importing"
                      ? // The wait is legible from here, not only inside Repositories.
                        `Importing… ${Math.round((repos.elapsed[r.id] ?? 0) / 1000)}s`
                      : "Import failed"}
                </span>
              </Link>
            </li>
          ))}
          {live && (
            <li>
              <Link href="/app/repos" className="sw-card sw-lift sw-home-card w-full">
                <span className="flex items-center gap-2 font-medium text-accent">
                  <Icon name="plus" size={16} />
                  Add a repository
                </span>
                <span className="sw-home-card-meta">GitHub URL, local folder, or .zip</span>
              </Link>
            </li>
          )}
        </ul>
        {!live && (
          <p className="text-subtle">Run Shipwright locally to import your own repositories.</p>
        )}
      </section>
    </div>
  );
}
