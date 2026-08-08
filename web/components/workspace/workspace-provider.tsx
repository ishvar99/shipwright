"use client";

import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { apiGet, apiPost, messageFor } from "@/lib/client/api";
import { useRepos, type ReposState } from "@/lib/client/use-repos";
import { JobListSchema, JobSchema, type Job, type Repo } from "@/lib/contracts";
import { isDemoRepo } from "@/lib/fixtures";
import { newLocalJob } from "@/lib/local/run";
import {
  isLocalJob,
  isLocalRepo,
  listLocalJobs,
  listLocalRepos,
  deleteLocalJob,
  deleteLocalRepo,
  saveLocalJob,
  type LocalRepo,
} from "@/lib/local/store";
import { repoHome, repoSession } from "@/lib/repo-routes";
import { readLastRepo, setDraft, setLastRepo } from "@/lib/ui-prefs";

type Workspace = {
  /** There is a backend to talk to. This is NOT "there is something to show". */
  live: boolean;
  repos: ReposState;
  /** The user's repositories, both origins. The recording lives in no list — it is reached
   * only through the welcome tour, and its routes resolve by id prefix. */
  repoList: Repo[];
  sessions: Job[];
  /** The sidebar and the repository home both show one repository's work, not the firehose. */
  sessionsFor: (repoId: string | null) => Job[];
  sessionsLoaded: boolean;
  currentRepo: Repo | null;
  selectRepo: (repo: Repo) => void;
  submitting: boolean;
  submitError: string | null;
  /** A run waiting on its repository to finish indexing, so surfaces can say so. */
  queuedRepoId: string | null;
  /** This deployment has a free-tier model configured AND our own engine is unreachable.
   * Never both — the real engine always wins when it is up. */
  liteMode: boolean;
  /** Repositories stored in this browser. They route to the client pipeline whatever the
   * backend is doing, because the backend has never heard of them. */
  localRepos: LocalRepo[];
  refreshLocal: () => void;
  /** A session's code pane is on screen. The frame reads it because the pane is component
   * state, not a route — and the sidebar should yield width to it the same way it yields to
   * the file browser. */
  codeOpen: boolean;
  setCodeOpen: (open: boolean) => void;
  /** Resolves to the new job id so the caller can navigate to it. `repoId` is what the
   * repository home passes: there the page's repo is the target, not the global selection. */
  run: (issue: string, repoId?: string) => Promise<string | null>;
  refreshSessions: () => void;
  patchSession: (id: string, patch: Partial<Job>) => void;
  deleteSession: (id: string) => Promise<void>;
  /** Unlink a repository: it and its sessions leave Shipwright. No files are deleted —
   * a browser-imported repo drops its cached copy, a backend one keeps its checkout. */
  unlinkRepo: (id: string) => Promise<void>;
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
  const [sessions, setSessions] = useState<Job[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(!live);
  // Read once during the first render, not in an effect: an effect would select a repo one
  // frame after the composer had already rendered pointed at a different one.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [readPrefs, setReadPrefs] = useState(false);
  if (!readPrefs && typeof document !== "undefined") {
    setReadPrefs(true);
    const stored = readLastRepo();
    if (stored) setSelectedId(stored);
  }
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [codeOpen, setCodeOpenState] = useState(false);
  const [liteMode, setLiteMode] = useState(false);
  const [localRepos, setLocalRepos] = useState<LocalRepo[]>([]);
  const [localJobs, setLocalJobs] = useState<Job[]>([]);
  const [localNonce, setLocalNonce] = useState(0);
  const refreshLocal = useCallback(() => setLocalNonce((n) => n + 1), []);
  const setCodeOpen = useCallback((open: boolean) => setCodeOpenState(open), []);
  // An issue written while the repository is still indexing. Held here rather than in the
  // composer so the run survives navigating away from the page that started it.
  const queuedRun = useRef<{ issue: string; repoId: string } | null>(null);
  const [queued, setQueued] = useState<string | null>(null);

  // Local rows sit alongside backend rows in one list; `origin` (encoded in the id prefix)
  // decides which engine answers, so the two can never contend for the same repository.
  const repoList = useMemo(
    () => [...repos.repos, ...localRepos],
    [repos.repos, localRepos],
  );
  const allSessions = useMemo(() => [...sessions, ...localJobs], [sessions, localJobs]);
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
    repoList.find((r) => r.id === selectedId) ??
    repos.repos.find((r) => r.status === "ready") ??
    repoList[0] ??
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

  // IndexedDB is browser-only, so this cannot run during the server render.
  useEffect(() => {
    let alive = true;
    void Promise.all([listLocalRepos(), listLocalJobs()])
      .then(([repos, jobs]) => {
        if (!alive) return;
        setLocalRepos(repos);
        setLocalJobs(jobs);
      })
      .catch(() => undefined); // a blocked or absent IndexedDB just means no local repos
    return () => {
      alive = false;
    };
  }, [localNonce]);

  // One probe: can this deployment answer without the engine? Booleans only cross the wire.
  useEffect(() => {
    let alive = true;
    void fetch("/api/lite/status", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((s: { lite?: boolean; backend?: boolean } | null) => {
        // Only when the fallback exists AND our own engine does not answer.
        if (alive && s) setLiteMode(Boolean(s.lite) && !s.backend);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  /** A session's own stream knows when it finished; the list does not, so it gets told. Without
   * this every row started in this browser session pulses "running" until a reload. */
  const patchSession = useCallback((id: string, patch: Partial<Job>) => {
    if (isLocalJob(id)) {
      // The local run already wrote the finished row to IndexedDB; re-read rather than merge,
      // so the list and the store cannot drift.
      setLocalJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...patch } : j)));
      void listLocalJobs().then(setLocalJobs).catch(() => undefined);
      return;
    }
    setSessions((prev) => prev.map((j) => (j.id === id ? { ...j, ...patch } : j)));
  }, []);

  const deleteSession = useCallback(
    async (id: string) => {
      // Leaving the router on a deleted session would stream against a 404 forever. Matched on
      // the trailing id so both the nested route and the legacy flat one are covered.
      const path = window.location.pathname;
      if (path.endsWith(`/s/${id}`) || path === `/app/session/${id}`) {
        const job = sessions.find((j) => j.id === id);
        router.push(job ? repoHome(job.repo_id) : "/app");
      }
      if (isLocalJob(id)) {
        setLocalJobs((prev) => prev.filter((j) => j.id !== id));
        await deleteLocalJob(id);
        return;
      }
      setSessions((prev) => prev.filter((j) => j.id !== id)); // optimistic
      try {
        const res = await fetch(`/api/jobs/${encodeURIComponent(id)}`, { method: "DELETE" });
        if (!res.ok) throw new Error(String(res.status));
      } catch {
        refreshSessions(); // the server disagreed, so put the truth back
      }
    },
    [refreshSessions, router, sessions],
  );

  const unlinkRepo = useCallback(
    async (id: string) => {
      // Standing on the repository being removed would leave the page resolving a row that
      // no longer exists, so leave first — the launcher is the one destination that is
      // always valid.
      if (window.location.pathname.startsWith(`/app/repo/${encodeURIComponent(id)}`)) {
        router.push("/app");
      }
      // A selection pointing at a gone repository would resurrect it in every composer.
      setSelectedId((cur) => (cur === id ? null : cur));
      setLastRepo("");
      if (isLocalRepo(id)) {
        setLocalRepos((prev) => prev.filter((r) => r.id !== id));
        setLocalJobs((prev) => prev.filter((j) => j.repo_id !== id));
        await deleteLocalRepo(id); // cascades its files and sessions in IndexedDB
        return;
      }
      setSessions((prev) => prev.filter((j) => j.repo_id !== id)); // optimistic, like sessions
      try {
        const res = await fetch(`/api/repos/${encodeURIComponent(id)}`, { method: "DELETE" });
        if (!res.ok) throw new Error(String(res.status));
      } finally {
        // Either way the server is the truth: on success this drops the row, on failure it
        // puts back what we optimistically hid.
        repos.refresh();
        refreshSessions();
      }
    },
    [refreshSessions, repos, router],
  );

  const run = useCallback(
    async (issue: string, repoId?: string) => {
      // A local repository never reaches the backend: it only exists in this browser.
      if (isLocalRepo(repoId ?? currentRepo?.id)) {
        const repo = repoList.find((r) => r.id === (repoId ?? currentRepo?.id));
        if (!repo) return null;
        const job = newLocalJob(repo.id, repo.slug, issue);
        await saveLocalJob(job);
        setLocalJobs((prev) => [job, ...prev]);
        setDraft(repo.id, "");
        return job.id;
      }
      const target = repoId ? (repos.repos.find((r) => r.id === repoId) ?? null) : currentRepo;
      // The recording has no workspace on disk, so a run against it would 404 in the backend.
      // Surfaces that show it offer replay instead of a live run.
      if (!target || isDemoRepo(target.id) || submitting) return null;
      // Setup does not have to finish before the user starts thinking. Park the issue and fire
      // it the moment the graph is ready, turning import-then-write-then-wait into one wait.
      if (target.status === "importing") {
        queuedRun.current = { issue, repoId: target.id };
        setQueued(target.id);
        setSubmitError(null);
        return null;
      }
      setSubmitting(true);
      setSubmitError(null);
      try {
        const created = await apiPost(JobSchema, "/api/jobs", {
          repo_id: target.id,
          issue,
          mode: "extract_rerank",
          base_mode: "hybrid",
          client: "web",
        });
        setSessions((prev) => [created, ...prev.filter((j) => j.id !== created.id)]);
        // Only now. The composer used to clear it on submit, which threw the issue away when
        // the run failed or was parked behind indexing.
        setDraft(target.id, "");
        return created.id;
      } catch (e) {
        setSubmitError(messageFor(e));
        return null;
      } finally {
        setSubmitting(false);
      }
    },
    [currentRepo, submitting, repos.repos, repoList],
  );

  // The parked run, fired once its repository finishes indexing. The payload is a ref and only
  // the banner is state: the effect must claim the run exactly once, and a state read would
  // still hold the previous value on the render that fires it. Navigation happens here because
  // the page that queued it may be long gone.
  useEffect(() => {
    const q = queuedRun.current;
    // `submitting` guard: `run` refuses while another request is in flight and returns null
    // without an error, so firing here would have swallowed the issue entirely. Leaving the
    // ref set means the next render after that request lands tries again — `run` is in the
    // dependency list and is rebuilt whenever `submitting` changes.
    if (!q || submitting) return;
    const repo = repos.repos.find((r) => r.id === q.repoId);
    if (repo?.status === "importing") return;
    if (!repo && repos.loading) return; // list in flight; absence proves nothing yet
    queuedRun.current = null;
    void (async () => {
      // Every exit clears the banner. Returning without clearing left "Queued" on screen for
      // the life of the page against a run that was never going to start.
      if (!repo || repo.status !== "ready") {
        setQueued(null);
        setSubmitError(
          repo
            ? "That repository didn't finish importing, so the run never started."
            : "That repository is no longer here, so the run never started.",
        );
        return;
      }
      const id = await run(q.issue, q.repoId);
      setQueued(null);
      if (id) router.push(repoSession(q.repoId, id));
    })();
  }, [repos.repos, repos.loading, run, router, submitting]);

  const value: Workspace = {
    live,
    repos,
    repoList,
    sessions: allSessions,
    sessionsFor: (repoId) =>
      repoId ? allSessions.filter((j) => j.repo_id === repoId) : allSessions,
    sessionsLoaded,
    currentRepo,
    selectRepo: (r: Repo) => {
      setSelectedId(r.id);
      setLastRepo(r.id);
    },
    submitting,
    submitError,
    queuedRepoId: queued,
    liteMode,
    localRepos,
    refreshLocal,
    codeOpen,
    setCodeOpen,
    run,
    refreshSessions,
    patchSession,
    deleteSession,
    unlinkRepo,
    showAll,
    setShowAll,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
