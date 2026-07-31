"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiPost, messageFor } from "@/lib/client/api";
import { RepoListSchema, RepoSchema, type Repo } from "@/lib/contracts";

/** A graph build has no progress signal, so polling is the only mechanism. The ladder keeps a
 * fast repo responsive without hammering a slow one: 15.8s is a normal large-repo build. */
function nextDelay(elapsedMs: number): number {
  if (elapsedMs < 10_000) return 1000;
  if (elapsedMs < 120_000) return 3000;
  return 10_000;
}

const MAX_CONSECUTIVE_FAILURES = 5;

export type ReposState = {
  repos: Repo[];
  loading: boolean;
  error: string | null;
  /** Wall-clock ms since an import started, per repo id. */
  elapsed: Record<string, number>;
  importRepo: (input: { url?: string; path?: string }) => Promise<Repo | null>;
  importing: boolean;
  importError: string | null;
  refresh: () => void;
};

export function useRepos(live: boolean): ReposState {
  const [repos, setRepos] = useState<Repo[]>([]);
  // Derived, not set in an effect: `loading` is just "live and nothing has arrived yet".
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState<Record<string, number>>({});
  const [nonce, setNonce] = useState(0);

  const startedAt = useRef<Record<string, number>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const importRepo = useCallback(async (input: { url?: string; path?: string }) => {
    setImporting(true);
    setImportError(null);
    try {
      const repo = await apiPost(RepoSchema, "/api/repos/import", {
        url: input.url ?? "",
        path: input.path ?? "",
      });
      // Insert the returned row rather than refetching: the response is authoritative and a
      // refetch would race the background build.
      setRepos((prev) => [repo, ...prev.filter((r) => r.id !== repo.id)]);
      if (repo.status === "importing") startedAt.current[repo.id] = Date.now();
      setNonce((n) => n + 1);
      return repo;
    } catch (e) {
      setImportError(messageFor(e));
      return null;
    } finally {
      setImporting(false);
    }
  }, []);

  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    let failures = 0;

    const tick = async () => {
      if (cancelled) return;
      try {
        const next = await apiGet(RepoListSchema, "/api/repos");
        if (cancelled) return;
        failures = 0;
        setError(null);
        setRepos(next);
        setLoaded(true);

        const now = Date.now();
        for (const r of next) {
          if (r.status === "importing" && !startedAt.current[r.id]) startedAt.current[r.id] = now;
          if (r.status !== "importing") delete startedAt.current[r.id];
        }
        setElapsed(
          Object.fromEntries(Object.entries(startedAt.current).map(([id, t]) => [id, now - t])),
        );
      } catch (e) {
        if (cancelled) return;
        failures += 1;
        setLoaded(true);
        setError(messageFor(e));
        if (failures >= MAX_CONSECUTIVE_FAILURES) return; // stop rather than spin
      }

      const pending = Object.values(startedAt.current);
      // Only keep polling while something is actually indexing.
      if (!pending.length && !failures) return;
      const oldest = pending.length ? Date.now() - Math.min(...pending) : 0;
      const delay = nextDelay(oldest) * 2 ** failures;
      timer.current = setTimeout(() => {
        // A backgrounded tab throttles timers anyway; skipping avoids a burst on return.
        if (document.hidden) timer.current = setTimeout(tick, delay);
        else void tick();
      }, delay);
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [live, nonce]);

  return { repos, loading: live && !loaded, error, elapsed, importRepo, importing, importError, refresh };
}
