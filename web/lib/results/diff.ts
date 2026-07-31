/** Unified-diff parsing for display. The patches are our own difflib output, so the dialect
 * is fixed — but the parser still refuses to invent structure from lines it does not know. */

export type DiffLine = { kind: "add" | "del" | "ctx"; text: string };
export type DiffFile = { path: string; hunks: { header: string; lines: DiffLine[] }[] };

export function parseUnifiedDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffFile["hunks"][number] | null = null;

  for (const raw of patch.split("\n")) {
    if (raw.startsWith("--- ")) continue;
    if (raw.startsWith("+++ ")) {
      file = { path: raw.slice(4).replace(/^b\//, ""), hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (raw.startsWith("@@")) {
      if (!file) continue;
      hunk = { header: raw, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (raw.startsWith("+")) hunk.lines.push({ kind: "add", text: raw.slice(1) });
    else if (raw.startsWith("-")) hunk.lines.push({ kind: "del", text: raw.slice(1) });
    else if (raw.startsWith(" ") || raw === "") hunk.lines.push({ kind: "ctx", text: raw.slice(1) });
  }
  return files;
}

export function diffStat(files: DiffFile[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const f of files)
    for (const h of f.hunks)
      for (const l of h.lines) {
        if (l.kind === "add") additions += 1;
        if (l.kind === "del") deletions += 1;
      }
  return { additions, deletions };
}
