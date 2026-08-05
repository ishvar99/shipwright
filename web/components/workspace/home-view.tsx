"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";
import { StatusDot } from "@/components/ui/status-dot";
import { Composer } from "@/components/workspace/composer";
import { FirstRun } from "@/components/workspace/first-run";
import { LiteAnswer } from "@/components/workspace/lite-answer";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import { demoJob, demoRepo, demoRun, isDemoJob, isDemoRepo } from "@/lib/fixtures";
import { repoDisplayName } from "@/lib/repo-name";
import { isLocalRepo } from "@/lib/local/store";
import { repoHome, repoSession } from "@/lib/repo-routes";
import { SESSION_TONE, relativeTime, sessionFact, sessionTitle } from "@/lib/sessions";

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
    liteMode,
    liteBusy,
    liteText,
    liteError,
    liteAsk,
    run,
  } = useWorkspace();
  const router = useRouter();
  // Counted across both origins. Reading `repos.repos` alone meant a repository imported into
  // this browser did not exist as far as the empty state and the checklist were concerned, so
  // the page told a user with a repo open to go and import one.
  const own = repoList.filter((r) => !isDemoRepo(r.id));
  const empty = !own.length && !repos.loading;
  // Replay only when there is nothing that can answer: with the fallback configured, the
  // composer takes real questions even though our own engine is unreachable.
  const replay = isDemoRepo(currentRepo?.id) && !liteMode;
  // The inline answer belongs to the bare fallback only; a local run gets its own session.
  const inlineAnswer = liteMode && !isLocalRepo(currentRepo?.id);

  return (
    <div className="sw-home">
      {live && (
        <FirstRun
          exampleVisible={demoVisible}
          ownRepos={own.length}
          ownSessions={sessions.filter((j) => !isDemoJob(j.id)).length}
          exampleHref={repoSession(demoRepo.id, demoJob.id)}
        />
      )}

      {empty && (
        <div className="sw-card grid gap-3 p-5">
          <h2 className="text-head font-semibold text-fg">Import a repository to get started</h2>
          <p className="text-muted">
            Paste a GitHub URL, point at a local folder, or drop a .zip anywhere on this page.
            Shipwright indexes it, then answers questions about it and finds the code behind
            any bug or change you describe. Meanwhile
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
        <div className="grid gap-1">
          <h2 className="text-head font-semibold text-fg">
            Ask about the code — or change it.
          </h2>
          <p className="text-muted">
            Shipwright answers from the repository, or finds where the change lives and drafts
            the fix.
          </p>
        </div>
        <Composer
          repos={repoList}
          repo={currentRepo}
          onPickRepo={selectRepo}
          busy={submitting}
          onRun={(issue) => {
            // A local repository has a real index in this browser, so it goes through the
            // client pipeline — retrieve, rank, then answer from the ranked excerpts. The
            // bare fallback is only for when there is nothing indexed to search, and taking
            // it here sent the model no code at all.
            if (liteMode && !isLocalRepo(currentRepo?.id)) {
              liteAsk(issue, currentRepo?.id);
              return;
            }
            void run(issue).then((id) => {
              if (id && currentRepo) router.push(repoSession(currentRepo.id, id));
            });
          }}
          replay={replay}
          hosted={!live}
          queued={queuedRepoId === currentRepo?.id}
          issueText={demoRun.issue}
          onReplay={() => router.push(repoSession(demoRepo.id, demoJob.id))}
          // The examples name symbols in the recorded repository — under any other repo they
          // would invite a run about code that is not there.
          showExamples={currentRepo?.slug === demoRepo.slug}
        />
        {submitError && (
          <p role="alert" className="text-danger">
            {submitError}
          </p>
        )}
        {inlineAnswer && (liteBusy || liteText || liteError) && (
          <LiteAnswer busy={liteBusy} text={liteText} error={liteError} />
        )}
      </div>

      {sessions.length > 0 && (
        <section className="sw-home-section" aria-labelledby="recent-sessions">
          <h3 id="recent-sessions" className="text-sm font-medium text-subtle">
            {isDemoJob(sessions[0].id) ? "See a finished session" : "Pick up where you left off"}
          </h3>
          {/* The latest session is a continue row, not the first tile among equals — coming
              back to it is the most common reason to be on this page at all. */}
          {/* One continue row; the sidebar already lists the rest. A tile grid here rendered
              the same sessions a third time on one screen. The outcome leads the meta — it is
              the row's payoff, and the repo name already appears elsewhere on this page. */}
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
                {isDemoJob(sessions[0].id) ? (
                  <span className="shrink-0 rounded-full bg-soft px-1.5 font-medium">
                    Recorded
                  </span>
                ) : (
                  // suppressHydrationWarning: this page is prerendered, so "3d ago" is computed
                  // at build time and again on hydration. The two can never agree.
                  <span className="shrink-0" suppressHydrationWarning>
                    {relativeTime(sessions[0].created_at)}
                  </span>
                )}
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
                    {isDemoRepo(r.id)
                      ? "Recorded example — a real repository and a real session"
                      : r.status === "ready"
                      ? r.symbols === 0
                        ? "No Python found — browse and edit"
                        : `${r.symbols.toLocaleString()} functions`
                      : r.status === "importing"
                        ? // The wait is legible from here, not only inside Repositories.
                          `Importing… ${Math.round((repos.elapsed[r.id] ?? 0) / 1000)}s`
                        : "Import failed — retry from Repositories"}
                  </span>
                </span>
              </Link>
            </li>
          ))}
          {live && (
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
          )}
        </ul>
        {!live && (
          <p className="text-subtle">Run Shipwright locally to import your own repositories.</p>
        )}
      </section>
    </div>
  );
}
