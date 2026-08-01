"use client";

import { apiGet } from "@/lib/client/api";
import { RepoFileSchema, type RepoFile } from "@/lib/contracts";

export function fetchRepoFile(repoId: string, path: string): Promise<RepoFile> {
  return apiGet(
    RepoFileSchema,
    `/api/repos/${encodeURIComponent(repoId)}/file?path=${encodeURIComponent(path)}`,
  );
}

/** Explicit outcomes rather than a thrown error: a conflict and a busy repo need different
 * UI, and the conflict's current sha is what makes Overwrite a single request. */
export type SaveResult =
  | { ok: true; sha: string; commit: string | null }
  | { ok: false; reason: "conflict"; currentSha: string }
  | { ok: false; reason: "busy" | "error"; message: string };

export async function saveRepoFile(
  repoId: string,
  path: string,
  content: string,
  baseSha: string,
): Promise<SaveResult> {
  let res: Response;
  try {
    res = await fetch(`/api/repos/${encodeURIComponent(repoId)}/file`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, content, base_sha: baseSha }),
      cache: "no-store",
    });
  } catch {
    return { ok: false, reason: "error", message: "Can't reach Shipwright." };
  }

  const body: unknown = await res.json().catch(() => null);
  // Type-aware: String(null) is "null", which is truthy and would render as a commit sha.
  const read = (key: string): string => {
    const v = body && typeof body === "object" ? (body as Record<string, unknown>)[key] : undefined;
    return typeof v === "string" ? v : "";
  };

  if (res.status === 409) {
    return read("reason") === "conflict"
      ? { ok: false, reason: "conflict", currentSha: read("current_sha") }
      : { ok: false, reason: "busy", message: read("detail") || "A job is running on this repository." };
  }
  if (!res.ok) {
    return { ok: false, reason: "error", message: read("message") || read("detail") || "The save failed." };
  }
  return { ok: true, sha: read("sha"), commit: read("commit") || null };
}
