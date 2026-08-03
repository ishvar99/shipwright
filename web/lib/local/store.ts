import type { Job, Repo } from "@/lib/contracts";
import { idbAll, idbBulkPut, idbDel, idbDeletePrefix, idbGet, idbPut } from "@/lib/idb";
import type { LocalSymbol } from "@/lib/local/index-repo";

/**
 * Local repositories, files and sessions.
 *
 * The one rule this module exists to enforce: **a repository remembers where it came from.**
 * A backend repo always routes to the backend; a local one always routes to the client
 * pipeline, even when the backend is up — because the backend has never heard of it. That
 * makes the two worlds incapable of contending for the same row, which is what keeps this
 * feature from becoming a sync problem.
 */

export const LOCAL_PREFIX = "local-";

export const isLocalRepo = (repoId: string | null | undefined) =>
  Boolean(repoId?.startsWith(LOCAL_PREFIX));

export const isLocalJob = (jobId: string | null | undefined) =>
  Boolean(jobId?.startsWith(LOCAL_PREFIX));

/** A local repo carries its whole index; there is no server to ask for it again. */
export type LocalRepo = Repo & { symbols_index: LocalSymbol[] };

const fileKey = (repoId: string, path: string) => `${repoId}:${path}`;

/** Prefixed like the recorded demo's ids, and for the same reason: an id must say which world
 * it belongs to, because routing reads the id long before it can load the row. */
export function newLocalId(): string {
  return `${LOCAL_PREFIX}${crypto.randomUUID()}`;
}

export async function saveLocalRepo(repo: LocalRepo): Promise<void> {
  await idbPut("repos", repo.id, repo);
}

export async function listLocalRepos(): Promise<LocalRepo[]> {
  const rows = await idbAll<LocalRepo>("repos");
  return rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export const getLocalRepo = (id: string) => idbGet<LocalRepo>("repos", id);

export async function saveLocalFiles(
  repoId: string,
  files: { path: string; content: string }[],
): Promise<void> {
  await idbBulkPut(
    "files",
    files.map((f) => ({ key: fileKey(repoId, f.path), value: f })),
  );
}

export const getLocalFile = (repoId: string, path: string) =>
  idbGet<{ path: string; content: string }>("files", fileKey(repoId, path));

export async function deleteLocalRepo(repoId: string): Promise<void> {
  await idbDeletePrefix("files", `${repoId}:`);
  const jobs = await listLocalJobs();
  await Promise.all(jobs.filter((j) => j.repo_id === repoId).map((j) => idbDel("jobs", j.id)));
  await idbDel("repos", repoId);
}

export async function saveLocalJob(job: Job): Promise<void> {
  await idbPut("jobs", job.id, job);
}

export const getLocalJob = (id: string) => idbGet<Job>("jobs", id);

export async function listLocalJobs(): Promise<Job[]> {
  const rows = await idbAll<Job>("jobs");
  return rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export const deleteLocalJob = (id: string) => idbDel("jobs", id);
