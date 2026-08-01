"use client";

import Link from "next/link";
import { Icon } from "@/components/ui/icon";
import { StatusDot } from "@/components/ui/status-dot";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import type { Job } from "@/lib/contracts";
import { repoDisplayName } from "@/lib/repo-name";
import { SESSION_TONE, relativeTime, sessionTitle } from "@/lib/sessions";

export function Sidebar({
  sessions,
  activeJobId,
  demo,
  onNewSession,
  onOpenSession,
  onOpenRepositories,
}: {
  sessions: Job[];
  activeJobId: string | null;
  demo: boolean;
  onNewSession: () => void;
  onOpenSession: (job: Job) => void;
  onOpenRepositories: () => void;
}) {
  return (
    <nav aria-label="Sessions" className="workspace-sidebar">
      <Link href="/" className="flex items-center gap-2 px-2 py-1 text-fg">
        <Icon name="crosshair" size={18} className="text-accent" />
        <span className="font-semibold">Shipwright</span>
      </Link>

      <button type="button" onClick={onNewSession} className="sw-new-session">
        <Icon name="plus" size={16} />
        New session
      </button>

      <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
        <p className="px-2 pb-1 text-xs font-medium text-subtle">Sessions</p>
        {sessions.length === 0 && (
          <p className="px-2 py-1 text-subtle">Your sessions will appear here.</p>
        )}
        <ul className="sw-session-list">
          {sessions.map((job) => (
            <li key={job.id}>
              <button
                type="button"
                onClick={() => onOpenSession(job)}
                aria-current={job.id === activeJobId || undefined}
                title={sessionTitle(job.issue)}
                className="sw-session-row"
              >
                <span className="sw-session-title">{sessionTitle(job.issue)}</span>
                <span className="sw-session-meta">
                  <StatusDot tone={SESSION_TONE[job.status]} />
                  {/* Titles come from the issue's first line, so two runs of the same text are
                      otherwise indistinguishable in this list. */}
                  {job.repo_slug && (
                    <span className="sw-truncate">{repoDisplayName(job.repo_slug)}</span>
                  )}
                  <span className="shrink-0">{relativeTime(job.created_at)}</span>
                  {demo && <span className="shrink-0 rounded-full bg-soft px-1.5 font-medium">Demo</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-2 grid gap-1 border-t border-hairline pt-2">
        {/* Shown in demo too: it is the only route to the file browser, which the hosted
            demo can drive from the recording. */}
        <button type="button" onClick={onOpenRepositories} className="sw-side-item">
          <Icon name="folder" size={16} />
          Repositories
        </button>
        <div className="px-2 py-1">
          <ThemeToggle />
        </div>
      </div>
    </nav>
  );
}
