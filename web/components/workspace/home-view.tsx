"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";
import { StatusDot } from "@/components/ui/status-dot";
import { Composer } from "@/components/workspace/composer";
import { WelcomeView } from "@/components/workspace/welcome-view";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import { demoRepo } from "@/lib/fixtures";
import { repoDisplayName } from "@/lib/repo-name";
import { repoHome, repoSession } from "@/lib/repo-routes";
import { SESSION_TONE, relativeTime, sessionFact, sessionTitle } from "@/lib/sessions";

export function HomeView() {
  const {
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

  // Nothing imported into either origin: the welcome view IS the empty state, so there is no
  // flag to persist and nothing to migrate. Loading is not emptiness — and neither is a
  // failed fetch: telling a user with repositories to "get started" because the list request
  // died would be the empty-state lie DESIGN.md forbids.
  if (repoList.length === 0) {
    if (repos.loading) return <div aria-hidden className="sw-skeleton h-24" />;
    if (repos.error) {
      return (
        <p role="alert" className="text-danger">
          {repos.error}
        </p>
      );
    }
    return <WelcomeView />;
  }

  return (
    <div className="sw-home">
      {/* No heading above the composer: the textarea placeholder already says what to type,
          and a second sentence saying it again was the launcher's crowding in miniature. */}
      <div className="sw-home-composer">
        <Composer
          autoFocus
          repos={repoList}
          repo={currentRepo}
          onPickRepo={selectRepo}
          busy={submitting}
          onRun={(issue) => {
            void run(issue).then((id) => {
              if (id && currentRepo) router.push(repoSession(currentRepo.id, id));
            });
          }}
          replay={false}
          queued={queuedRepoId === currentRepo?.id}
          // The examples name symbols in the recorded repository — right again only if the
          // user imports that same repository themselves.
          showExamples={currentRepo?.slug === demoRepo.slug}
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
            Pick up where you left off
          </h3>
          {/* The latest session is a continue row, not the first tile among equals — coming
              back to it is the most common reason to be on this page at all. */}
          <Link
            href={repoSession(sessions[0].repo_id, sessions[0].id)}
            title={sessionTitle(sessions[0].issue)}
            className="sw-card sw-lift sw-continue"
          >
            {sessions[0].status !== "done" && (
              <StatusDot tone={SESSION_TONE[sessions[0].status]} />
            )}
            <span className="sr-only">{sessions[0].status}</span>
            <span className="min-w-0 grid gap-0.5">
              <span className="sw-continue-title">{sessionTitle(sessions[0].issue)}</span>
              <span className="sw-home-card-meta">
                <span className="shrink-0">{sessionFact(sessions[0])}</span>
                <span aria-hidden className="shrink-0">·</span>
                {/* suppressHydrationWarning: this page is prerendered, so "3d ago" is computed
                    at build time and again on hydration. The two can never agree. */}
                <span className="shrink-0" suppressHydrationWarning>
                  {relativeTime(sessions[0].created_at)}
                </span>
              </span>
            </span>
            <Icon name="chevron" size={16} className="ml-auto shrink-0 text-subtle" />
          </Link>
        </section>
      )}

      <section className="sw-home-section" aria-labelledby="home-repos">
        <h3 id="home-repos" className="text-sm font-medium text-subtle">
          Repositories
        </h3>
        {repos.error && <p className="text-danger">{repos.error}</p>}
        <ul className="grid gap-2">
          {repoList.slice(0, 5).map((r) => (
            <li key={r.id}>
              <Link
                href={r.status === "ready" ? repoHome(r.id) : "/app/repos"}
                className="sw-card sw-lift sw-repo-card w-full"
              >
                <span aria-hidden className="sw-repo-mark">
                  {repoDisplayName(r.slug).slice(0, 1).toUpperCase()}
                </span>
                <span className="min-w-0 grid gap-0.5">
                  <span className="sw-home-card-title">{repoDisplayName(r.slug)}</span>
                  <span
                    className={cn(
                      "sw-home-card-meta",
                      r.status === "failed" && "text-danger",
                    )}
                  >
                    {r.status === "ready"
                      ? r.symbols === 0
                        ? "Nothing indexable — browse and edit"
                        : `${r.symbols.toLocaleString()} symbols`
                      : r.status === "importing"
                        ? // The wait is legible from here, not only inside Repositories.
                          `Importing… ${Math.round((repos.elapsed[r.id] ?? 0) / 1000)}s`
                        : "Import failed — retry from Repositories"}
                  </span>
                </span>
              </Link>
            </li>
          ))}
          {/* Always offered: with no backend the same page imports into this browser. */}
          <li>
            <Link href="/app/repos" className="sw-card sw-lift sw-repo-card w-full">
              <span aria-hidden className="sw-repo-mark sw-repo-mark-add">
                <Icon name="plus" size={16} />
              </span>
              <span className="min-w-0 grid gap-0.5">
                <span className="sw-home-card-title">Add a repository</span>
                <span className="sw-home-card-meta">GitHub URL, local folder, or .zip</span>
              </span>
            </Link>
          </li>
        </ul>
      </section>
    </div>
  );
}
