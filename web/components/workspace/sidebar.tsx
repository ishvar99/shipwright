"use client";

import Link from "next/link";
import { Icon } from "@/components/ui/icon";
import { StatusDot, type StatusTone } from "@/components/ui/status-dot";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import type { Job } from "@/lib/contracts";
import { cn } from "@/lib/cn";
import { relativeTime, sessionTitle } from "@/lib/sessions";

const TONE: Record<Job["status"], StatusTone> = {
  queued: "active",
  running: "active",
  done: "good",
  errored: "bad",
};

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
        <ul className="grid gap-0.5">
          {sessions.map((job) => (
            <li key={job.id}>
              <button
                type="button"
                onClick={() => onOpenSession(job)}
                aria-current={job.id === activeJobId || undefined}
                className={cn(
                  "block w-full rounded-[var(--radius)] px-2 py-1.5 text-left transition-colors duration-150 hover:bg-soft",
                  job.id === activeJobId && "bg-accent-soft",
                )}
              >
                <span className="block truncate text-fg">{sessionTitle(job.issue)}</span>
                <span className="mt-0.5 flex items-center gap-2 text-xs text-subtle">
                  <StatusDot tone={TONE[job.status]} />
                  {relativeTime(job.created_at)}
                  {demo && <span className="rounded-full bg-soft px-1.5 font-medium">Demo</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-2 grid gap-1 border-t border-hairline pt-2">
        {!demo && (
          <button type="button" onClick={onOpenRepositories} className="sw-side-item">
            <Icon name="folder" size={16} />
            Repositories
          </button>
        )}
        <div className="px-2 py-1">
          <ThemeToggle />
        </div>
      </div>
    </nav>
  );
}
