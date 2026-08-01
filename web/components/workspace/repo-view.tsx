"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { FileTree } from "@/components/workspace/editor/file-tree";
import { QuickOpen } from "@/components/workspace/editor/quick-open";
import { TabStrip } from "@/components/workspace/editor/tab-strip";
import { Splitter } from "@/components/workspace/splitter";
import { messageFor } from "@/lib/client/api";
import { fetchRepoFile, saveRepoFile } from "@/lib/client/repo-file";
import { loadDemoWorkspace } from "@/lib/fixtures";
import { useRepoTree } from "@/lib/client/use-repo-tree";
import { cn } from "@/lib/cn";
import type { RepoTree } from "@/lib/contracts";
import type { EditorHandle } from "@/components/workspace/editor/monaco-editor";
import type { Body } from "@/lib/repo-tabs";
import { ancestorsOf } from "@/lib/repo-fold";
import { repoDisplayName } from "@/lib/repo-name";
import { repoHome } from "@/lib/repo-routes";
import {
  activateTab,
  closeTab,
  dropBody,
  markTab,
  openTab,
  setBody,
  setDraft,
  useRepoTabs,
} from "@/lib/repo-tabs";

// ssr:false is only legal inside a client component, and Monaco touches window on import.
const CodeEditor = dynamic(
  () => import("@/components/workspace/editor/monaco-editor").then((m) => m.CodeEditor),
  { ssr: false, loading: () => <div className="p-4 text-subtle">Loading the editor…</div> },
);

type Save = { state: "idle" | "saving" | "saved" | "error"; message?: string; commit?: string };

const PLACEHOLDER: Record<string, string> = {
  binary: "This file isn't text, so there's nothing to show.",
  too_large: "This file is too large to open here (limit 2 MB).",
  not_recorded: "This demo includes a handful of recorded files — run Shipwright locally to browse everything.",
};

export function RepoView({
  repoId,
  slug,
  live,
  initialFile,
  initialLine,
  initialSymbol,
}: {
  repoId: string;
  slug: string;
  live: boolean;
  initialFile?: string;
  initialLine?: number;
  initialSymbol?: string;
}) {
  // Demo: the fixture is fetched here, not statically imported, so the 188KB never lands in
  // the landing page's bundle.
  const [demoData, setDemoData] = useState<{
    tree: RepoTree;
    files: Record<string, { content: string; sha: string }>;
  } | null>(null);
  useEffect(() => {
    if (live) return;
    let cancelled = false;
    void loadDemoWorkspace().then((w) => {
      if (cancelled) return;
      setDemoData({
        tree: { entries: w.entries, truncated: w.truncated, branch: w.meta.branch, head: w.meta.ref },
        files: w.files,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [live]);

  const { tree, error, loading } = useRepoTree(repoId, live, demoData?.tree ?? null);
  // Buffers come from the store, not component state: this view unmounts on every
  // navigation, and an edit that dies with it leaves a tab claiming changes it no longer has.
  const { tabs, active, recent, bodies, drafts } = useRepoTabs(repoId);
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [quickOpen, setQuickOpen] = useState(false);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [save, setSave] = useState<Save>({ state: "idle" });
  const [conflict, setConflict] = useState<{ path: string; currentSha: string } | null>(null);
  const [loadError, setLoadError] = useState<{ path: string; message: string } | null>(null);
  const pendingReveal = useRef<{ line: number; symbol?: string } | null>(null);
  // Stable identity: a new function each render would re-run the editor's cleanup and null
  // the handle before the reveal could use it. Revealing here also means it fires exactly
  // when the editor is ready, rather than racing the body arriving.
  const editorRef = useRef<EditorHandle | null>(null);
  const onEditorReady = useCallback((handle: EditorHandle | null) => {
    editorRef.current = handle;
    if (!handle || !pendingReveal.current) return;
    const { line, symbol } = pendingReveal.current;
    pendingReveal.current = null;
    handle.reveal(line, symbol);
  }, []);

  const paths = useMemo(() => tree?.entries.map((e) => e.path) ?? [], [tree]);
  const activeTab = tabs.find((t) => t.path === active) ?? null;
  // Manual toggles plus the trail to whatever is open, so revealing a file never fights a
  // collapse the user just made and never writes state from an effect.
  const expanded = useMemo(() => {
    const set = new Set([...opened, ...(active ? ancestorsOf(active) : [])]);
    for (const path of collapsed) set.delete(path);
    return set;
  }, [opened, collapsed, active]);
  const body = active ? bodies[active] : undefined;
  const draft = active ? (drafts[active] ?? body?.content ?? "") : "";
  // Not editable until the body is actually here: an empty editor plus one keystroke
  // would auto-commit a file truncated to that keystroke.
  const readOnly = !live || !body || Boolean(body.reason);

  const load = useCallback(
    (path: string, opts: { preview?: boolean } = {}) => {
      openTab(repoId, path, { preview: opts.preview, baseSha: bodies[path]?.sha });
    },
    [repoId, bodies],
  );

  // The one place a body is fetched. Keyed on the active tab so a deep link, a tree click and
  // quick-open all take the same path, and every write lands after an await.
  useEffect(() => {
    if (!active || bodies[active]) return;
    let cancelled = false;
    void (async () => {
      if (!live) {
        const rec = demoData?.files?.[active];
        const next: Body = rec
          ? { content: rec.content, sha: rec.sha }
          : { content: "", sha: "", reason: "not_recorded" };
        if (!cancelled) setBody(repoId, active, next);
        return;
      }
      try {
        const file = await fetchRepoFile(repoId, active);
        if (cancelled) return;
        setBody(repoId, active, { content: file.content, sha: file.sha, reason: file.reason });
        markTab(repoId, active, { baseSha: file.sha, reason: file.reason });
      } catch (e) {
        // Never cache a failure as a body: it would render as an editable empty file whose
        // save has no base sha.
        if (!cancelled) setLoadError({ path: active, message: messageFor(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, bodies, live, demoData, repoId]);

  const doSave = useCallback(
    async (overrideSha?: string) => {
      if (!live || !active || !activeTab) return;
      const text = drafts[active];
      if (text === undefined) return;
      setSave({ state: "saving" });
      const result = await saveRepoFile(repoId, active, text, overrideSha ?? activeTab.baseSha);
      if (result.ok) {
        setBody(repoId, active, { content: text, sha: result.sha });
        setDraft(repoId, active, null);
        markTab(repoId, active, { dirty: false, baseSha: result.sha, preview: false });
        setConflict(null);
        setSave({ state: "saved", commit: result.commit ?? undefined });
        return;
      }
      if (result.reason === "conflict") {
        setConflict({ path: active, currentSha: result.currentSha });
        setSave({ state: "error", message: "This file changed on disk since you opened it." });
        return;
      }
      setSave({ state: "error", message: result.message });
    },
    [live, active, activeTab, drafts, repoId],
  );

  // One capture-phase listener: Cmd+S opens the browser's Save dialog and Cmd+P the print
  // dialog, and capture means it does not matter whether focus is in Monaco, the tree or a
  // portal. Registering the same chords on the editor too would double-fire the save.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.isComposing) return;
      if (e.key === "p" || e.key === "P") {
        e.preventDefault();
        setQuickOpen((v) => !v);
      }
      if ((e.key === "s" || e.key === "S") && !e.repeat) {
        e.preventDefault();
        if (live) void doSave();
        else setSave({ state: "error", message: "This demo is read-only — run Shipwright locally to edit." });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [doSave, live]);

  // Deep link from a result or a fix. The tab is opened by whoever navigated here; this only
  // records where to scroll. The line is a hint — it was computed before any fix was applied,
  // and the workspace may be parked on a fix branch.
  useEffect(() => {
    if (!initialFile) return;
    pendingReveal.current = { line: initialLine ?? 1, symbol: initialSymbol };
    // A cold deep link never passed through the session view, so the tab is opened here.
    // Idempotent: openTab promotes an existing tab rather than duplicating it.
    openTab(repoId, initialFile, { preview: false });
  }, [initialFile, initialLine, initialSymbol, repoId]);

  useEffect(() => {
    if (save.state !== "saved") return;
    const t = setTimeout(() => setSave({ state: "idle" }), 4000);
    return () => clearTimeout(t);
  }, [save]);

  // Status and conflict describe one file; carrying them across a tab switch would show a
  // stale error on another file and let Overwrite save with the wrong sha. Adjusted during
  // render rather than in an effect, which would paint the stale state first.
  const [statusFor, setStatusFor] = useState(active);
  if (statusFor !== active) {
    setStatusFor(active);
    setSave({ state: "idle" });
    setConflict(null);
  }

  const onChange = (next: string) => {
    if (!active) return;
    setDraft(repoId, active, next);
    markTab(repoId, active, { dirty: next !== (bodies[active]?.content ?? ""), preview: false });
  };

  const closeWithGuard = (path: string) => {
    const tab = tabs.find((t) => t.path === path);
    if (tab?.dirty && !window.confirm(`Discard unsaved changes to ${path.split("/").pop()}?`)) return;
    closeTab(repoId, path); // also drops the draft
    void import("@/components/workspace/editor/monaco-editor").then((m) =>
      m.disposeModel(repoId, path),
    );

  };

  return (
    <div className="sw-repo">
      <header className="sw-repo-head">
        <div className="flex min-w-0 items-center gap-2">
          {/* The repository name is the way back to its page, the same as in a session header —
              the editor is one surface of a repository, not a place of its own. */}
          <Link href={repoHome(repoId)} className="flex min-w-0 items-center gap-2 hover:text-accent">
            <Icon name="folder" size={16} className="shrink-0 text-subtle" />
            <span className="truncate font-medium text-fg">{repoDisplayName(slug)}</span>
          </Link>
          {active && (
            <>
              <span className="text-subtle">/</span>
              <span className="truncate text-muted">{active}</span>
            </>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="ghost" onClick={() => setQuickOpen(true)} className="h-7 px-2">
            Go to file
          </Button>
          {live && (
            <Button
              variant="ghost"
              onClick={() => void doSave()}
              aria-disabled={!activeTab?.dirty || undefined}
              className="h-7 px-2"
            >
              Save
            </Button>
          )}
        </div>
      </header>

      <div className="sw-repo-body">
        <aside id="sw-repo-tree" className="sw-repo-tree" aria-label="Files">
          {(loading || (!live && !demoData)) && <p className="p-3 text-subtle">Loading files…</p>}
          {error && <p className="p-3 text-danger">{error}</p>}
          {tree && (
            <FileTree
              tree={tree}
              activePath={active}
              expanded={expanded}
              onToggle={(p) => {
                // Two sets, because the trail expands directories the user never opened —
                // toggling only `opened` would leave those permanently stuck open.
                const isOpen = expanded.has(p);
                setCollapsed((prev) => {
                  const next = new Set(prev);
                  if (isOpen) next.add(p);
                  else next.delete(p);
                  return next;
                });
                setOpened((prev) => {
                  const next = new Set(prev);
                  if (isOpen) next.delete(p);
                  else next.add(p);
                  return next;
                });
              }}
              onOpen={(p) => void load(p, { preview: true })}
              onPin={(p) => void load(p, { preview: false })}
            />
          )}
        </aside>

        <Splitter side="left" controls="sw-repo-tree" label="Resize the file tree" />

        <section className="sw-repo-editor" aria-label="Editor">
          <TabStrip tabs={tabs} active={active} onSelect={(p) => activateTab(repoId, p)} onClose={closeWithGuard} />

          {!active && (
            <div className="sw-editor-empty">
              <p className="font-medium text-fg">Nothing open</p>
              <ul className="grid gap-1.5">
                <li>
                  Go to file <kbd className="sw-kbd">⌘P</kbd>
                </li>
                {live && (
                  <li>
                    Save <kbd className="sw-kbd">⌘S</kbd>
                  </li>
                )}
              </ul>
              {!live && <p>This demo is read-only — run Shipwright locally to edit.</p>}
            </div>
          )}

          {active && loadError?.path === active && (
            <div className="sw-editor-empty">
              <p>{loadError.message}</p>
              <Button
                onClick={() => {
                  setLoadError(null);
                  dropBody(repoId, active);
                }}
              >
                Try again
              </Button>
            </div>
          )}

          {active && !loadError && !body && <div className="sw-editor-empty">Opening…</div>}

          {active && body?.reason && <div className="sw-editor-empty">{PLACEHOLDER[body.reason]}</div>}

          {active && body && !body.reason && (
            <div className="min-h-0 flex-1">
              <CodeEditor
                repoId={repoId}
                path={active}
                value={draft}
                readOnly={readOnly}
                onChange={onChange}
                onCursor={(line, column) => setCursor({ line, column })}
                handleRef={onEditorReady}
              />
            </div>
          )}

          <footer className="sw-repo-status">
            <span className="flex items-center gap-3">
              {tree?.branch && <span className="font-mono">{tree.branch}</span>}
              {active && <span>{active.split(".").pop()}</span>}
            </span>
            <span className="flex items-center gap-3">
              {active && !body?.reason && (
                <span className="tabular-nums">
                  Ln {cursor.line}, Col {cursor.column}
                </span>
              )}
              <span
                className={cn(
                  save.state === "error" && "text-danger",
                  save.state === "saved" && "text-ok",
                )}
                role={save.state === "error" ? "alert" : undefined}
              >
                {save.state === "saving" && "Saving…"}
                {/* Every save is a commit — say so, it is the differentiator. */}
                {save.state === "saved" && (save.commit ? `Saved · committed ${save.commit}` : "Saved")}
                {save.state === "error" && save.message}
                {save.state === "idle" && activeTab?.dirty && "Unsaved changes"}
              </span>
            </span>
          </footer>

          {conflict && conflict.path === active && (
            <div className="sw-conflict" role="alert">
              <p>That file changed on disk since you opened it.</p>
              <div className="flex gap-2">
                <Button
                  variant="primary"
                  onClick={() => {
                    dropBody(repoId, conflict.path);
                    setDraft(repoId, conflict.path, null);
                    markTab(repoId, conflict.path, { dirty: false });
                    setConflict(null);
                    setSave({ state: "idle" });
                    // Dropping the body re-runs the fetch effect for the active tab.
                  }}
                >
                  Reload
                </Button>
                <Button onClick={() => void doSave(conflict.currentSha)}>Overwrite</Button>
              </div>
            </div>
          )}
        </section>
      </div>

      {quickOpen && (
        <QuickOpen
          paths={paths}
          recent={recent}
          onPick={(p) => {
            setQuickOpen(false);
            load(p, { preview: false });
            editorRef.current?.focus();
          }}
          onClose={() => setQuickOpen(false)}
        />
      )}
    </div>
  );
}
