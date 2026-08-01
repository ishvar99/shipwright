"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Sidebar } from "@/components/workspace/sidebar";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import { anyDirty } from "@/lib/repo-tabs";
import {
  applyStoredPrefs,
  readStoredSidebarPref,
  setSidebarState,
  type SidebarState,
} from "@/lib/ui-prefs";

/** The chrome around every workspace route: sidebar, the scrolling main pane, and the two
 * window-level concerns (the dirty-buffer guard and ⌘B). */
export function WorkspaceFrame({ children }: { children: React.ReactNode }) {
  const { live, repos, sessions, sessionsLoaded, deleteSession, showAll, setShowAll } =
    useWorkspace();
  const router = useRouter();
  const pathname = usePathname();
  const onEditor = pathname.startsWith("/app/repo/");

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
  const railed = pref === "rail" || (pref === "auto" && onEditor);

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

  // Derived from what is on screen, not from the stored preference: on the editor route "auto"
  // already renders railed, so mapping auto->rail made the first click a no-op.
  const toggle = useCallback(() => {
    const next: SidebarState = railed ? "expanded" : "rail";
    setPref(next);
    setSidebarState(next);
  }, [railed]);

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

  const activeJobId = pathname.startsWith("/app/session/") ? (pathname.split("/")[3] ?? null) : null;

  return (
    <main className="workspace">
      <h1 className="sr-only">Shipwright workspace</h1>
      <a href="#session" className="sw-skip">
        Skip to the session
      </a>

      <Sidebar
        sessions={sessions}
        sessionsLoaded={sessionsLoaded}
        activeJobId={activeJobId}
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
