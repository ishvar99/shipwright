import type { RepoTree } from "@/lib/contracts";

export type TreeNode =
  | { kind: "dir"; name: string; path: string; children: TreeNode[] }
  | { kind: "file"; name: string; path: string; size: number };

/** Flat paths -> nested nodes. Directories first, then files, each alphabetical — the order
 * every file browser uses, and the one users scan by. */
export function foldTree(entries: RepoTree["entries"]): TreeNode[] {
  const root: TreeNode[] = [];
  const dirs = new Map<string, TreeNode & { kind: "dir" }>();

  for (const entry of entries) {
    const parts = entry.path.split("/").filter(Boolean);
    if (!parts.length) continue;
    let level = root;
    let prefix = "";
    for (const part of parts.slice(0, -1)) {
      prefix = prefix ? `${prefix}/${part}` : part;
      let dir = dirs.get(prefix);
      if (!dir) {
        dir = { kind: "dir", name: part, path: prefix, children: [] };
        dirs.set(prefix, dir);
        level.push(dir);
      }
      level = dir.children;
    }
    const name = parts[parts.length - 1];
    level.push({ kind: "file", name, path: entry.path, size: entry.size });
  }

  const sort = (nodes: TreeNode[]): TreeNode[] => {
    nodes.sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1,
    );
    for (const n of nodes) if (n.kind === "dir") sort(n.children);
    return nodes;
  };
  return sort(root);
}

/** Every directory on the way to a file, so opening one reveals it in the tree. */
export function ancestorsOf(path: string): string[] {
  const parts = path.split("/").filter(Boolean).slice(0, -1);
  const out: string[] = [];
  let prefix = "";
  for (const part of parts) {
    prefix = prefix ? `${prefix}/${part}` : part;
    out.push(prefix);
  }
  return out;
}
