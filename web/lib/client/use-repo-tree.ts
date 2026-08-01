"use client";

import { useEffect, useState } from "react";
import { apiGet, messageFor } from "@/lib/client/api";
import { RepoTreeSchema, type RepoTree } from "@/lib/contracts";

/** The repo's file list. One fetch per repo — the tree is static for a checkout, and the
 * branch it reports is the one the workspace is actually on. */
export function useRepoTree(
  repoId: string,
  live: boolean,
  recorded: RepoTree | null,
): { tree: RepoTree | null; error: string | null; loading: boolean } {
  const [fetched, setFetched] = useState<RepoTree | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Recorded wins at render time, not just as an initial value: the demo fixture is loaded
  // asynchronously, and a useState initialiser would pin `null` for the life of the hook.
  const tree = recorded ?? fetched;

  useEffect(() => {
    if (!live || recorded) return;
    let cancelled = false;
    void apiGet(RepoTreeSchema, `/api/repos/${encodeURIComponent(repoId)}/tree`)
      .then((next) => {
        if (!cancelled) setFetched(next);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(messageFor(e));
      });
    return () => {
      cancelled = true;
    };
  }, [repoId, live, recorded]);

  // Derived, not a third state: loading is just "expected to arrive and nothing has yet".
  return { tree, error, loading: live && !recorded && !tree && !error };
}
