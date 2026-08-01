"use client";

import { useSyncExternalStore } from "react";

export type Tab = {
  path: string;
  /** Preview tabs are reused by the next single click; editing or double-click pins them. */
  preview: boolean;
  dirty: boolean;
  baseSha: string;
  reason?: "binary" | "too_large" | "not_recorded" | null;
};

export type Body = { content: string; sha: string; reason?: "binary" | "too_large" | "not_recorded" | null };

type State = {
  tabs: Tab[];
  active: string | null;
  recent: string[];
  /** Fetched file contents, keyed by path. */
  bodies: Record<string, Body>;
  /** Unsaved edits. Lives here, not in the view: the view unmounts on every navigation, and
   * a dirty flag that outlives its buffer is worse than losing the tab — it claims unsaved
   * work that no longer exists and blocks the page from closing to protect it. */
  drafts: Record<string, string>;
};

const EMPTY: State = { tabs: [], active: null, recent: [], bodies: {}, drafts: {} };
const CLEAN_LIMIT = 8;

/**
 * Tab state lives outside React, keyed by repo, because the workspace unmounts a view when
 * you switch to another — a dirty buffer must survive clicking a session and coming back.
 * The buffers themselves are Monaco models, which already outlive React in its own registry.
 */
const stores = new Map<string, State>();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function read(repoId: string): State {
  return stores.get(repoId) ?? EMPTY;
}

function write(repoId: string, next: State) {
  stores.set(repoId, next);
  emit();
}

export function useRepoTabs(repoId: string): State {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => read(repoId),
    () => EMPTY,
  );
}

export function anyDirty(): boolean {
  for (const state of stores.values()) if (state.tabs.some((t) => t.dirty)) return true;
  return false;
}

export function openTab(
  repoId: string,
  path: string,
  opts: { preview?: boolean; baseSha?: string; reason?: Tab["reason"] } = {},
): void {
  const state = read(repoId);
  const existing = state.tabs.find((t) => t.path === path);
  let tabs: Tab[];

  if (existing) {
    // Re-opening a preview tab through a pinning action promotes it in place.
    tabs = state.tabs.map((t) =>
      t.path === path ? { ...t, preview: opts.preview === false ? false : t.preview } : t,
    );
  } else {
    const tab: Tab = {
      path,
      preview: opts.preview ?? true,
      dirty: false,
      baseSha: opts.baseSha ?? "",
      reason: opts.reason ?? null,
    };
    // A preview tab replaces the previous preview instead of stacking: browsing the tree
    // never fills the strip.
    const withoutPreview = tab.preview ? state.tabs.filter((t) => !t.preview || t.dirty) : state.tabs;
    tabs = [...withoutPreview, tab];
  }

  write(repoId, { ...state, tabs: evict(tabs, path), active: path, recent: touch(state.recent, path) });
}

/** Only clean tabs are evicted. Dropping an edit to honour a tab cap would be worse than a
 * ninth tab, so the strip scrolls instead. */
function evict(tabs: Tab[], keep: string): Tab[] {
  const clean = tabs.filter((t) => !t.dirty && t.path !== keep);
  const over = tabs.length - CLEAN_LIMIT;
  if (over <= 0 || !clean.length) return tabs;
  const doomed = new Set(clean.slice(0, over).map((t) => t.path));
  return tabs.filter((t) => !doomed.has(t.path));
}

function touch(recent: string[], path: string): string[] {
  return [path, ...recent.filter((p) => p !== path)].slice(0, 20);
}

export function closeTab(repoId: string, path: string): void {
  const state = read(repoId);
  const index = state.tabs.findIndex((t) => t.path === path);
  const tabs = state.tabs.filter((t) => t.path !== path);
  const active =
    state.active === path ? (tabs[Math.min(index, tabs.length - 1)]?.path ?? null) : state.active;
  const drafts = { ...state.drafts };
  delete drafts[path];
  write(repoId, { ...state, tabs, active, drafts });
}

export function activateTab(repoId: string, path: string): void {
  const state = read(repoId);
  write(repoId, { ...state, active: path, recent: touch(state.recent, path) });
}

export function markTab(repoId: string, path: string, patch: Partial<Tab>): void {
  const state = read(repoId);
  write(repoId, {
    ...state,
    tabs: state.tabs.map((t) => (t.path === path ? { ...t, ...patch } : t)),
  });
}

/** Test/reset seam — the store is module state, so it outlives a remount by design. */
export function setBody(repoId: string, path: string, body: Body): void {
  const state = read(repoId);
  write(repoId, { ...state, bodies: { ...state.bodies, [path]: body } });
}

export function dropBody(repoId: string, path: string): void {
  const state = read(repoId);
  const bodies = { ...state.bodies };
  delete bodies[path];
  write(repoId, { ...state, bodies });
}

export function setDraft(repoId: string, path: string, text: string | null): void {
  const state = read(repoId);
  const drafts = { ...state.drafts };
  if (text === null) delete drafts[path];
  else drafts[path] = text;
  write(repoId, { ...state, drafts });
}

export function resetTabs(): void {
  stores.clear();
  emit();
}
