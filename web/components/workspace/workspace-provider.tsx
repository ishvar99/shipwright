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
import { demoJob, demoRepo, isDemoRepo } from "@/lib/fixtures";
import { repoHome, repoSession } from "@/lib/repo-routes";
import { readLastRepo, setDraft, setLastRepo } from "@/lib/ui-prefs";

type Workspace = {
  /** There is a backend to talk to. This is NOT "there is something to show" — see `demoVisible`,
   * which is the distinction that used to be missing. */
  live: boolean;
  /** The recording is on screen: either there is no backend at all, or there is one and nothing
   * has been imported yet. Somebody who clones this and runs it locally is in the second case,
   * and used to be shown an empty app while a finished session sat unused in the bundle. */
  demoVisible: boolean;
  repos: ReposState;
  /** Real repositories, plus the recorded one whenever it is visible — without it there is no
   * way to reach the file browser or the finished session at all. */
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
  /** The fallback is answering: this deployment has a free-tier model configured AND our own
   * engine is unreachable. Never both — the real engine always wins when it is up. The rest
   * is the one in-flight answer, held here so every surface shares it. */
  liteMode: boolean;
  liteBusy: boolean;
  liteText: string;
  liteError: string | null;
  liteAsk: (issue: string, repoId?: string) => void;
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
  const [liteBusy, setLiteBusy] = useState(false);
  const [liteText, setLiteText] = useState("");
  const [liteError, setLiteError] = useState<string | null>(null);
  const setCodeOpen = useCallback((open: boolean) => setCodeOpenState(open), []);
  // An issue written while the repository is still indexing. Held here rather than in the
  // composer so the run survives navigating away from the page that started it.
  const queuedRun = useRef<{ issue: string; repoId: string } | null>(null);
  const [queued, setQueued] = useState<string | null>(null);

  // Two conditions, not one. `live` alone said "has content", so the local user with a working
  // backend and nothing imported got an empty screen instead of the recording.
  //
  // "Ready", not "exists": a freshly imported repository appears as `importing` and stays that
  // way for up to a minute, and keying on mere existence pulled the recording off the screen
  // exactly during the wait it was there to fill.
  const demoVisible = !live || (!repos.loading && !repos.repos.some((r) => r.status === "ready"));
  const repoList = useMemo(
    () => (demoVisible ? [...repos.repos, demoRepo] : repos.repos),
    [demoVisible, repos.repos],
  );
  const allSessions = useMemo(
    () => (demoVisible ? [...sessions, demoJob] : sessions),
    [demoVisible, sessions],
  );
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
  // A real repository beats the recording as the default — the recording is only ever the
  // fallback when there is nothing of the user's own to aim at.
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

  const liteAsk = useCallback((issue: string, repoId?: string) => {
    setLiteBusy(true);
    setLiteText("");
    setLiteError(null);
    void (async () => {
      try {
        const res = await fetch("/api/lite/ask", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ issue, repoId: repoId ?? "" }),
        });
        if (!res.ok || !res.body) {
          const detail = (await res.json().catch(() => null)) as { detail?: string } | null;
          throw new Error(detail?.detail ?? "Lite answering isn't available right now.");
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let text = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
          setLiteText(text);
        }
      } catch (e) {
        setLiteError(e instanceof Error ? e.message : "Lite answering failed.");
      } finally {
        setLiteBusy(false);
      }
    })();
  }, []);

  /** A session's own stream knows when it finished; the list does not, so it gets told. Without
   * this every row started in this browser session pulses "running" until a reload. */
  const patchSession = useCallback((id: string, patch: Partial<Job>) => {
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

  const run = useCallback(
    async (issue: string, repoId?: string) => {
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
    [currentRepo, submitting, repos.repos],
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
    demoVisible,
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
    liteBusy,
    liteText,
    liteError,
    liteAsk,
    codeOpen,
    setCodeOpen,
    run,
    refreshSessions,
    patchSession,
    deleteSession,
    showAll,
    setShowAll,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
