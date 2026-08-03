import type { Repo } from "@/lib/contracts";
import { indexRepo } from "@/lib/local/index-repo";
import { newLocalId, saveLocalFiles, saveLocalRepo, type LocalRepo } from "@/lib/local/store";
import { unzip, ZipRejected } from "@/lib/local/unzip";

/**
 * Importing a repository with no backend: unzip in the browser, index it, store it.
 *
 * A `.zip` the user picked never leaves the machine. A GitHub URL is fetched by our own route
 * server-side — not because the browser could not do it, but because our CSP is
 * `connect-src 'self'` and widening it for every page to save one hop is the wrong trade.
 */

export type ImportProgress = (stage: string) => void;

function repoRow(slug: string, source: Repo["source"], ref: string): LocalRepo {
  return {
    id: newLocalId(),
    slug,
    source,
    status: "ready",
    symbols: 0,
    files: 0,
    ref,
    error: "",
    created_at: new Date().toISOString(),
    symbols_index: [],
  };
}

async function ingest(
  repo: LocalRepo,
  buffer: ArrayBuffer,
  onProgress: ImportProgress,
): Promise<LocalRepo> {
  onProgress("Unpacking…");
  const entries = await unzip(buffer);
  if (!entries.length) throw new ZipRejected("That archive has no readable text files in it.");

  onProgress("Indexing…");
  const symbols = indexRepo(entries);

  onProgress("Saving…");
  await saveLocalFiles(repo.id, entries);
  const stored: LocalRepo = {
    ...repo,
    files: entries.length,
    symbols: symbols.length,
    symbols_index: symbols,
  };
  await saveLocalRepo(stored);
  return stored;
}

export async function importLocalZip(file: File, onProgress: ImportProgress): Promise<LocalRepo> {
  const name = file.name.replace(/\.zip$/i, "") || "project";
  return ingest(repoRow(`zip:${name}`, "zip", "local"), await file.arrayBuffer(), onProgress);
}

export async function importLocalGitHub(
  url: string,
  onProgress: ImportProgress,
): Promise<LocalRepo> {
  onProgress("Fetching from GitHub…");
  const res = await fetch("/api/local/fetch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) {
    const d = (await res.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(d?.detail ?? "Could not download that repository.");
  }
  // The route knows the resolved slug and default branch; the URL alone does not.
  const slug = res.headers.get("x-repo-slug") ?? url.replace(/^https?:\/\/github\.com\//, "");
  const ref = res.headers.get("x-repo-ref") ?? "";
  return ingest(repoRow(slug, "github", ref), await res.arrayBuffer(), onProgress);
}
