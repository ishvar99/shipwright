"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";
import { StatusDot } from "@/components/ui/status-dot";
import { Composer } from "@/components/workspace/composer";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import { demoJob, demoRun } from "@/lib/fixtures";
import { repoDisplayName } from "@/lib/repo-name";
import { SESSION_TONE, relativeTime, sessionTitle } from "@/lib/sessions";

export function HomeView() {
  const { live, repos, repoList, sessions, currentRepo, selectRepo, submitting, submitError, run } =
    useWorkspace();
  const router = useRouter();
  // With nothing imported, the composer is the wrong hero: it points at the one action the user
  // cannot take, and the only thing that works is a tertiary card at the bottom of the page.
  const empty = live && !repos.repos.length && !repos.loading;

  return (
    <div className="sw-home">
      {empty && (
        <div className="sw-card grid gap-3 p-5">
          <h2 className="text-xl font-semibold text-fg">Import a repository to get started</h2>
          <p className="text-muted">
            Paste a GitHub URL, point at a local folder, or drop a .zip anywhere on this page.
            Shipwright indexes it and then finds the code behind any bug you describe.
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
        <h2 className="text-xl font-semibold text-fg">
          Describe a bug or a change. Shipwright finds where in the code it lives.
        </h2>
        <Composer
          repos={live ? repos.repos : []}
          repo={currentRepo}
          onPickRepo={selectRepo}
          busy={submitting}
          onRun={(issue) => {
            void run(issue).then((id) => {
              if (id) router.push(`/app/session/${id}`);
            });
          }}
          replay={!live}
          issueText={demoRun.issue}
          onReplay={() => router.push(`/app/session/${demoJob.id}`)}
        />
        {empty && (
          <p className="text-subtle">Import a repository first — then describe what to change.</p>
        )}
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
                  href={`/app/session/${job.id}`}
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
                    <span className="shrink-0">{relativeTime(job.created_at)}</span>
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
                href={r.status === "ready" ? `/app/repo/${r.id}` : "/app/repos"}
                className="sw-card sw-lift sw-home-card w-full"
              >
                <span className="sw-home-card-title">{repoDisplayName(r.slug)}</span>
                <span className="sw-home-card-meta">
                  {r.status === "ready"
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
