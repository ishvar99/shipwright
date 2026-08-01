"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { apiGet, apiPost, messageFor } from "@/lib/client/api";
import { useRepos, type ReposState } from "@/lib/client/use-repos";
import { JobListSchema, JobSchema, type Job, type Repo } from "@/lib/contracts";
import { demoJob, demoRepo } from "@/lib/fixtures";

type Workspace = {
  live: boolean;
  repos: ReposState;
  /** Demo has no backend to poll, so the recorded repo is the whole list — without it there is
   * no way to reach the file browser at all. */
  repoList: Repo[];
  sessions: Job[];
  sessionsLoaded: boolean;
  currentRepo: Repo | null;
  selectRepo: (repo: Repo) => void;
  submitting: boolean;
  submitError: string | null;
  /** Resolves to the new job id so the caller can navigate to it. */
  run: (issue: string) => Promise<string | null>;
  refreshSessions: () => void;
  patchSession: (id: string, patch: Partial<Job>) => void;
  deleteSession: (id: string) => Promise<void>;
  /** Harness and CLI runs are hidden by default; this reveals them. */
  showAll: boolean;
  setShowAll: (value: boolean) => void;
};

const Ctx = createContext<Workspace | null>(null);

export function useWorkspace(): Workspace {
  const value = useContext(Ctx);
  if (!value) throw new Error("useWorkspace must be used inside WorkspaceProvider");
  return value;
}

/**
 * The data every workspace route shares. It lives here rather than in a page because a layout
 * cannot pass props to routed children, and re-fetching sessions per route would flash the
 * sidebar on every navigation.
 */
export function WorkspaceProvider({
  live,
  children,
}: {
  live: boolean;
  children: React.ReactNode;
}) {
  const repos = useRepos(live);
  const router = useRouter();
  const [sessions, setSessions] = useState<Job[]>(live ? [] : [demoJob]);
  const [sessionsLoaded, setSessionsLoaded] = useState(!live);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const repoList = useMemo(() => (live ? repos.repos : [demoRepo]), [live, repos.repos]);
  // Whatever was imported last is what the user came to work on, so the composer aims there
  // rather than at whichever repo happens to be first in the list.
  const lastImported = repos.repos[0];
  const [seenReady, setSeenReady] = useState<string | null>(null);
  // Keyed on "became ready", not on "appeared": an import arrives as `importing`, so keying on
  // the id alone meant the handoff never fired.
  if (lastImported?.status === "ready" && lastImported.id !== seenReady) {
    setSeenReady(lastImported.id);
    if (!selectedId) setSelectedId(lastImported.id);
  }
  // Derived from the live list, never a snapshot: a stored Repo object froze its status, so a
  // repo picked while importing stayed "still indexing" forever.
  const currentRepo =
    repos.repos.find((r) => r.id === selectedId) ??
    repos.repos.find((r) => r.status === "ready") ??
    null;

  const refreshSessions = useCallback(() => {
    if (!live) return;
    // Filtered in SQL, not here: filtering after the limit let 25 harness rows fill the page
    // and push every one of the user's own sessions off it.
    const q = new URLSearchParams({ limit: "25", kind: "localize" });
    if (!showAll) q.set("client", "web");
    void apiGet(JobListSchema, `/api/jobs?${q}`)
      .then(setSessions)
      .catch(() => undefined) // the sidebar list is never worth an error banner
      .finally(() => setSessionsLoaded(true));
  }, [live, showAll]);

  useEffect(() => {
    refreshSessions();
  }, [refreshSessions]);

  /** A session's own stream knows when it finished; the list does not, so it gets told. Without
   * this every row started in this browser session pulses "running" until a reload. */
  const patchSession = useCallback((id: string, patch: Partial<Job>) => {
    setSessions((prev) => prev.map((j) => (j.id === id ? { ...j, ...patch } : j)));
  }, []);

  const deleteSession = useCallback(
    async (id: string) => {
      // Leaving the router on a deleted session would stream against a 404 forever.
      if (window.location.pathname === `/app/session/${id}`) router.push("/app");
      setSessions((prev) => prev.filter((j) => j.id !== id)); // optimistic
      try {
        const res = await fetch(`/api/jobs/${encodeURIComponent(id)}`, { method: "DELETE" });
        if (!res.ok) throw new Error(String(res.status));
      } catch {
        refreshSessions(); // the server disagreed, so put the truth back
      }
    },
    [refreshSessions, router],
  );

  const run = useCallback(
    async (issue: string) => {
      if (!currentRepo || submitting) return null;
      setSubmitting(true);
      setSubmitError(null);
      try {
        const created = await apiPost(JobSchema, "/api/jobs", {
          repo_id: currentRepo.id,
          issue,
          mode: "extract_rerank",
          base_mode: "hybrid",
          client: "web",
        });
        setSessions((prev) => [created, ...prev.filter((j) => j.id !== created.id)]);
        return created.id;
      } catch (e) {
        setSubmitError(messageFor(e));
        return null;
      } finally {
        setSubmitting(false);
      }
    },
    [currentRepo, submitting],
  );

  const value: Workspace = {
    live,
    repos,
    repoList,
    sessions,
    sessionsLoaded,
    currentRepo,
    selectRepo: (r: Repo) => setSelectedId(r.id),
    submitting,
    submitError,
    run,
    refreshSessions,
    patchSession,
    deleteSession,
    showAll,
    setShowAll,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
