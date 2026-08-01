"use client";

import Link from "next/link";
import { Icon } from "@/components/ui/icon";
import { StatusDot } from "@/components/ui/status-dot";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { RepoPicker } from "@/components/workspace/repo-picker";
import type { Job, Repo } from "@/lib/contracts";
import { isDemoJob } from "@/lib/fixtures";
import { repoDisplayName } from "@/lib/repo-name";
import { repoHome, repoSession } from "@/lib/repo-routes";
import { SESSION_TONE, relativeTime, sessionTitle } from "@/lib/sessions";
import { groupSessions } from "@/lib/sessions-group";

/** Navigation is links, not callbacks: every destination is a real address, so middle-click and
 * copy-link work and the browser owns the history. `sw-rail-hide` marks what folds away when the
 * sidebar collapses — the icons stay so the rail keeps its wayfinding.
 *
 * The list is one repository's sessions rather than every session there has ever been: which
 * repository you are in is the page you are on, and changing it is navigation. */
export function Sidebar({
  repos,
  currentRepo,
  onPickRepo,
  sessions,
  sessionsLoaded,
  activeJobId,
  scoped,
  demo,
  onToggleRail,
  onDelete,
  showAll,
  onShowAll,
}: {
  repos: Repo[];
  currentRepo: Repo | null;
  onPickRepo: (repo: Repo) => void;
  sessions: Job[];
  sessionsLoaded: boolean;
  activeJobId: string | null;
  /** True when the list belongs to one repository, which changes what "empty" means. */
  scoped: boolean;
  demo: boolean;
  onToggleRail: () => void;
  onDelete: (id: string) => void;
  showAll: boolean;
  onShowAll: (value: boolean) => void;
}) {
  return (
    <nav aria-label="Sessions" className="workspace-sidebar">
      <div className="flex items-center gap-1">
        <Link
          href="/"
          aria-label="Shipwright home"
          className="flex min-w-0 items-center gap-2 px-2 py-1 text-fg transition-colors hover:text-accent"
        >
          <Icon name="crosshair" size={18} className="shrink-0 text-accent" />
          <span className="sw-rail-hide font-semibold">Shipwright</span>
        </Link>
        <button
          type="button"
          onClick={onToggleRail}
          aria-label="Toggle sidebar"
          title="Toggle sidebar  ⌘B"
          className="sw-rail-toggle ml-auto"
        >
          <Icon name="chevron" size={14} />
        </button>
      </div>

      {repos.length > 0 && (
        <div className="sw-rail-hide mt-3">
          <RepoPicker repos={repos} repo={currentRepo} onPick={onPickRepo} block />
        </div>
      )}

      <Link
        href={currentRepo ? repoHome(currentRepo.id) : "/app"}
        className="sw-new-session mt-2"
        title="New session"
      >
        <Icon name="plus" size={16} className="shrink-0" />
        <span className="sw-rail-hide">New session</span>
      </Link>

      <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
        <p className="sw-sessions-heading sw-rail-hide px-2 pb-1 text-xs font-medium text-subtle">
          Sessions
        </p>
        {/* Skeletons, not empty copy: the list is fetched, so "nothing here" is not yet known. */}
        {!sessionsLoaded && (
          <div aria-hidden className="sw-rail-hide grid gap-1 px-2">
            <div className="sw-skeleton" />
            <div className="sw-skeleton" />
            <div className="sw-skeleton" />
          </div>
        )}
        {sessionsLoaded && sessions.length === 0 && (
          <p className="sw-rail-hide px-2 py-1 text-subtle">
            {scoped ? "No sessions in this repository yet." : "Your sessions will appear here."}
          </p>
        )}
        {groupSessions(sessions).map((group) => (
          <div key={group.label} className="sw-rail-hide">
            <p className="sw-session-group">{group.label}</p>
            <ul className="sw-session-list">
              {group.sessions.map((job) => (
                <li key={job.id} className="sw-session-row-wrap">
                  <Link
                    href={repoSession(job.repo_id, job.id)}
                    aria-current={job.id === activeJobId || undefined}
                    title={sessionTitle(job.issue)}
                    className="sw-session-row"
                  >
                    <span className="sw-session-title">{sessionTitle(job.issue)}</span>
                    <span className="sw-session-meta">
                      {/* The dot is aria-hidden, so the status needs a text equivalent. */}
                      <StatusDot tone={SESSION_TONE[job.status]} />
                      <span className="sr-only">{job.status}</span>
                      {/* Redundant once the list is one repository's — the switcher above
                          already names it. */}
                      {!scoped && job.repo_slug && (
                        <span className="sw-truncate">{repoDisplayName(job.repo_slug)}</span>
                      )}
                      <span className="shrink-0">{relativeTime(job.created_at)}</span>
                      {isDemoJob(job.id) && (
                        <span className="shrink-0 rounded-full bg-soft px-1.5 font-medium">
                          Recorded
                        </span>
                      )}
                    </span>
                  </Link>
                  {/* The recording has no row in the database to delete. */}
                  {!isDemoJob(job.id) && (
                    <button
                      type="button"
                      aria-label={`Delete ${sessionTitle(job.issue)}`}
                      title="Delete session"
                      onClick={() => onDelete(job.id)}
                      className="sw-session-delete"
                    >
                      <Icon name="x" size={12} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}

        {/* Named for what it does now that the list is repo-scoped: the hidden rows are the
            benchmark harness's, not another person's. */}
        {!demo && sessionsLoaded && (
          <button
            type="button"
            onClick={() => onShowAll(!showAll)}
            className="sw-rail-hide mt-2 px-2 text-xs text-subtle transition-colors hover:text-fg"
          >
            {showAll ? "Hide harness runs" : "Show harness runs"}
          </button>
        )}
      </div>

      <div className="sw-side-footer">
        {/* Shown in demo too: it is the only route to the file browser, which the hosted
            demo can drive from the recording. */}
        <Link href="/app/repos" className="sw-side-item" title="Repositories">
          <Icon name="folder" size={16} className="shrink-0" />
          <span className="sw-rail-hide">Repositories</span>
        </Link>
        <div className="sw-rail-hide px-2 py-1">
          <ThemeToggle />
        </div>
      </div>
    </nav>
  );
}
