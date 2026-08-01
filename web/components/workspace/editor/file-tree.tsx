"use client";

import { useMemo, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";
import { foldTree, type TreeNode } from "@/lib/repo-fold";
import type { RepoTree } from "@/lib/contracts";

type Row = { node: TreeNode; level: number };

/** Flatten what is actually on screen. Collapsed children are never mounted — that, not the
 * folding, is what bounds the DOM when one directory holds thousands of siblings. */
function visible(nodes: TreeNode[], expanded: Set<string>, level = 1): Row[] {
  const rows: Row[] = [];
  for (const node of nodes) {
    rows.push({ node, level });
    if (node.kind === "dir" && expanded.has(node.path)) {
      rows.push(...visible(node.children, expanded, level + 1));
    }
  }
  return rows;
}

/**
 * WAI-ARIA tree with a roving tabindex: one row is tabbable, arrows move between rows, and
 * Left/Right collapse and expand — the same pattern the results list already uses.
 */
export function FileTree({
  tree,
  activePath,
  expanded,
  onToggle,
  onOpen,
  onPin,
}: {
  tree: RepoTree;
  activePath: string | null;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
  onPin: (path: string) => void;
}) {
  const nodes = useMemo(() => foldTree(tree.entries), [tree.entries]);
  const rows = useMemo(() => visible(nodes, expanded), [nodes, expanded]);
  const [focused, setFocused] = useState<string | null>(null);

  const trail = useMemo(() => {
    const parts = activePath?.split("/").slice(0, -1) ?? [];
    return new Set(parts.map((_, i) => parts.slice(0, i + 1).join("/")));
  }, [activePath]);

  // Exactly one row is tabbable — and it has to be a row that is actually rendered, or
  // collapsing a subtree drops the whole tree out of the tab order.
  const shown = (path: string | null) => (path && rows.some((r) => r.node.path === path) ? path : null);
  const tabbable = shown(focused) ?? shown(activePath) ?? rows[0]?.node.path ?? null;

  const focusAt = (index: number) => {
    const next = rows[Math.min(Math.max(index, 0), rows.length - 1)];
    if (!next) return;
    setFocused(next.node.path);
    document.getElementById(`sw-tree-${next.node.path}`)?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent, row: Row) => {
    const { node } = row;
    const isDir = node.kind === "dir";
    const open = isDir && expanded.has(node.path);
    const at = rows.findIndex((r) => r.node.path === node.path);
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        focusAt(at + 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        focusAt(at - 1);
        break;
      case "ArrowRight":
        e.preventDefault();
        if (isDir && !open) onToggle(node.path);
        else focusAt(at + 1);
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (isDir && open) onToggle(node.path);
        else focusAt(at - 1);
        break;
      case "Home":
        e.preventDefault();
        focusAt(0);
        break;
      case "End":
        e.preventDefault();
        focusAt(rows.length - 1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        // Opening by keyboard is deliberate, so it pins rather than previews.
        if (isDir) onToggle(node.path);
        else onPin(node.path);
        break;
      default:
        break;
    }
  };

  return (
    <div className="sw-tree" role="tree" aria-label="Files">
      {rows.map((row) => {
        const { node, level } = row;
        const isDir = node.kind === "dir";
        const open = isDir && expanded.has(node.path);
        const active = node.path === activePath;
        return (
          <div
            key={node.path}
            id={`sw-tree-${node.path}`}
            role="treeitem"
            aria-level={level}
            aria-selected={active}
            {...(isDir ? { "aria-expanded": open } : {})}
            tabIndex={node.path === tabbable ? 0 : -1}
            onFocus={() => setFocused(node.path)}
            onKeyDown={(e) => onKeyDown(e, row)}
            onClick={() => (isDir ? onToggle(node.path) : onOpen(node.path))}
            onDoubleClick={() => !isDir && onPin(node.path)}
            className={cn(
              "sw-tree-row",
              active && "sw-tree-row-active",
              !active && isDir && trail.has(node.path) && "text-fg",
            )}
            style={{ paddingInlineStart: `${level * 12}px` }}
          >
            {isDir ? (
              <Icon
                name="chevron"
                size={12}
                className={cn("shrink-0 text-subtle transition-transform", open && "rotate-90")}
              />
            ) : (
              <span aria-hidden className="w-3 shrink-0" />
            )}
            <span className="truncate">{node.name}</span>
          </div>
        );
      })}
      {tree.truncated && (
        <p className="px-2 py-1 text-xs text-subtle">
          Showing the first {tree.entries.length.toLocaleString()} files.
        </p>
      )}
    </div>
  );
}
