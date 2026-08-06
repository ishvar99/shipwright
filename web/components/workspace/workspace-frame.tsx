"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Sidebar } from "@/components/workspace/sidebar";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import { demoRepo, isDemoRepo } from "@/lib/fixtures";
import { parseWorkspacePath, repoHome } from "@/lib/repo-routes";
import { anyDirty } from "@/lib/repo-tabs";
import {
  applyStoredPrefs,
  readStoredSidebarPref,
  setLastRepo,
  setSidebarState,
  type SidebarState,
} from "@/lib/ui-prefs";

/** The chrome around every workspace route: sidebar, the scrolling main pane, and the two
 * window-level concerns (the dirty-buffer guard and ⌘B). */
export function WorkspaceFrame({ children }: { children: React.ReactNode }) {
  const {
    live,
    repos,
    repoList,
    sessionsFor,
    sessionsLoaded,
    currentRepo,
    selectRepo,
    codeOpen,
    deleteSession,
    showAll,
    setShowAll,
  } = useWorkspace();
  const router = useRouter();
  const pathname = usePathname();
  // The file browser always wants the width; a session wants it once its code pane is open.
  // The repository home and the launcher never do.
  const onEditor = pathname.endsWith("/files");
  const { repoId: routeRepoId, jobId: activeJobId } = parseWorkspacePath(pathname);
  // The URL wins where it says something — including when it names a repository that does not
  // exist, where falling back to the selection would label the page with an unrelated repo.
  // Elsewhere the selection carries over so the switcher is never blank on /app.
  // The recording lives in no list, so it resolves by prefix — same rule as repo-home. Without
  // this the sidebar read "Choose a repository" beside a playing tour.
  const shownRepo = routeRepoId
    ? (repoList.find((r) => r.id === routeRepoId) ??
      (isDemoRepo(routeRepoId) ? demoRepo : null))
    : currentRepo;
  // Scoped only when the URL names a repository. On the launcher you are not inside one, and
  // narrowing the sidebar to a fallback selection made it claim "no sessions in this
  // repository" beside a main pane listing every session there is. Route, not selection — and
  // the route, not the resolved row, so a cold deep link does not flash the full list first.
  const scoped = Boolean(routeRepoId);
  const shownSessions = sessionsFor(routeRepoId);

  // Only the stored preference is state; whether the rail is showing is derived from it and the
  // route. "auto" gives the editor the width, an explicit choice always wins.
  const [pref, setPref] = useState<SidebarState>("auto");
  const [read, setRead] = useState(false);
  // Adjusted during render rather than in an effect: the boot script has already stamped the
  // attribute, and an effect would paint the wrong width first.
  if (!read && typeof document !== "undefined") {
    setRead(true);
    setPref(readStoredSidebarPref());
  }
  // Content yields regardless of the stored preference: one toggle press months ago should not
  // mean the code pane arrives squeezed beside a full sidebar forever. The override is the
  // escape hatch — transient, per pane, never persisted.
  const yielding = onEditor || codeOpen;
  const [expandOverride, setExpandOverride] = useState(false);
  // Adjusted during render, same as the pref read above: the next pane starts railed again.
  const [wasYielding, setWasYielding] = useState(yielding);
  if (wasYielding !== yielding) {
    setWasYielding(yielding);
    if (!yielding) setExpandOverride(false);
  }
  const railed = pref === "rail" || (yielding && !expandOverride);

  useEffect(() => {
    applyStoredPrefs();
    return () => {
      delete document.documentElement.dataset.swResizing;
      delete document.documentElement.dataset.sidebar;
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.sidebar = railed ? "rail" : "expanded";
  }, [railed]);

  // Arriving at a repository by any route — a link, a bookmark, the back button — is what makes
  // it the one you were last working in. Persisting only on the switcher missed all of those.
  useEffect(() => {
    if (routeRepoId && !isDemoRepo(routeRepoId)) setLastRepo(routeRepoId);
  }, [routeRepoId]);

  // Derived from what is on screen, not from the stored preference: on the editor route the
  // yield already renders railed, so mapping the preference alone made the first click a
  // no-op. Expanding over a yielded pane is the transient override, not a stored choice —
  // otherwise pressing it once would resurrect the squeezed layout permanently.
  const toggle = useCallback(() => {
    if (railed && yielding) {
      setExpandOverride(true);
      return;
    }
    if (!railed && yielding && expandOverride) {
      setExpandOverride(false);
      return;
    }
    const next: SidebarState = railed ? "expanded" : "rail";
    setPref(next);
    setSidebarState(next);
  }, [railed, yielding, expandOverride]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "b" || e.key === "B")) {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  // The whole app is the drop target for the one artifact home invites, and preventDefault on
  // dragover is what stops a missed drop from navigating away and losing the session.
  useEffect(() => {
    if (!live) return;
    const over = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      const file = e.dataTransfer?.files?.[0];
      if (!file?.name.toLowerCase().endsWith(".zip")) return; // text drags keep native behaviour
      e.preventDefault();
      router.push("/app/repos");
      void repos.uploadRepo(file);
    };
    document.addEventListener("dragover", over);
    document.addEventListener("drop", drop);
    return () => {
      document.removeEventListener("dragover", over);
      document.removeEventListener("drop", drop);
    };
  }, [live, repos, router]);

  useEffect(() => {
    if (!live) return;
    const guard = (e: BeforeUnloadEvent) => {
      if (anyDirty()) e.preventDefault();
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [live]);

  return (
    <main className="workspace">
      <h1 className="sr-only">Shipwright workspace</h1>
      <a href="#session" className="sw-skip">
        Skip to the session
      </a>

      <Sidebar
        repos={repoList}
        currentRepo={shownRepo}
        onPickRepo={(r) => {
          selectRepo(r);
          router.push(repoHome(r.id));
        }}
        sessions={shownSessions}
        sessionsLoaded={sessionsLoaded}
        activeJobId={activeJobId}
        scoped={scoped}
        demo={!live}
        onToggleRail={toggle}
        onDelete={(id) => void deleteSession(id)}
        showAll={showAll}
        onShowAll={setShowAll}
      />

      <div id="session" tabIndex={-1} className="workspace-main">
        {/* Keyed on the route so the entrance animation replays on navigation. */}
        <div key={pathname} className="sw-view">
          {children}
        </div>
      </div>
    </main>
  );
}
