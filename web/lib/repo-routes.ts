/**
 * Workspace addresses. Sessions live inside their repository, so nearly every destination needs
 * a repo id — keeping the construction here is what stops half the app linking to the old flat
 * `/app/session/:id` and quietly losing the repo context the sidebar reads back out.
 */

export type EditorTarget = { file?: string; line?: number; symbol?: string; slug?: string };

const seg = (v: string) => encodeURIComponent(v);

export const repoHome = (repoId: string) => `/app/repo/${seg(repoId)}`;

export const repoReview = (repoId: string) => `/app/repo/${seg(repoId)}/review`;

export const repoSession = (repoId: string, jobId: string) =>
  `/app/repo/${seg(repoId)}/s/${seg(jobId)}`;

export function repoFiles(repoId: string, target: EditorTarget = {}) {
  const q = new URLSearchParams();
  if (target.file) q.set("file", target.file);
  if (target.line && target.line > 0) q.set("line", String(target.line));
  if (target.symbol) q.set("symbol", target.symbol);
  if (target.slug) q.set("slug", target.slug);
  const s = q.toString();
  return `/app/repo/${seg(repoId)}/files${s ? `?${s}` : ""}`;
}

/** Which repo the chrome should consider current, and which session is active. Derived from the
 * URL rather than stored, so back/forward and a cold deep link agree with the sidebar. */
export function parseWorkspacePath(pathname: string): {
  repoId: string | null;
  jobId: string | null;
} {
  const parts = pathname.split("/").filter(Boolean); // ["app","repo",id,"s",jobId]
  if (parts[0] !== "app") return { repoId: null, jobId: null };
  if (parts[1] === "repo" && parts[2]) {
    const repoId = decodeURIComponent(parts[2]);
    const jobId = parts[3] === "s" && parts[4] ? decodeURIComponent(parts[4]) : null;
    return { repoId, jobId };
  }
  // The legacy flat route still resolves an active session while it redirects.
  if (parts[1] === "session" && parts[2]) {
    return { repoId: null, jobId: decodeURIComponent(parts[2]) };
  }
  return { repoId: null, jobId: null };
}
