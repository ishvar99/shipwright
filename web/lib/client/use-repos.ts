"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiPost, apiUpload, messageFor } from "@/lib/client/api";
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
  importRepo: (input: { url?: string; path?: string; private?: boolean }) => Promise<Repo | null>;
  uploadRepo: (file: File) => Promise<Repo | null>;
  /** 0–1 while bytes are in flight, then null for the indeterminate server-side stage. */
  uploadProgress: number | null;
  /** Upload-specific: `importing` is also true for URL/path imports. */
  uploading: boolean;
  importing: boolean;
  importError: string | null;
  refresh: () => void;
};

const MAX_UPLOAD_BYTES = 150 * 1024 * 1024;

export function useRepos(live: boolean): ReposState {
  const [repos, setRepos] = useState<Repo[]>([]);
  // Derived, not set in an effect: `loading` is just "live and nothing has arrived yet".
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState<Record<string, number>>({});
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const [nonce, setNonce] = useState(0);

  const startedAt = useRef<Record<string, number>>({});
  // A ref, not `importing`: uploadRepo's deps are [] so it can never read that state.
  const inFlight = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const importRepo = useCallback(async (input: { url?: string; path?: string; private?: boolean }) => {
    setImporting(true);
    setImportError(null);
    try {
      const repo = await apiPost(RepoSchema, "/api/repos/import", {
        url: input.url ?? "",
        path: input.path ?? "",
        // The BFF reads this to decide whether to attach the user's token server-side.
        private: input.private ?? false,
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

  const uploadRepo = useCallback(async (file: File) => {
    if (inFlight.current) return null;
    if (!file.name.toLowerCase().endsWith(".zip")) {
      setImportError("Upload a .zip archive.");
      return null;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setImportError("That archive is too large (limit 150 MB).");
      return null;
    }
    inFlight.current = true;
    setImporting(true);
    setUploading(true);
    setImportError(null);
    setUploadProgress(0);
    try {
      const repo = await apiUpload(RepoSchema, "/api/repos/upload", file, (f) =>
        // At 100% the bytes are sent but the server is still extracting, which reports no
        // progress — go indeterminate rather than sit at a stalled 100%.
        setUploadProgress(f >= 1 ? null : f),
      );
      setRepos((prev) => [repo, ...prev.filter((r) => r.id !== repo.id)]);
      if (repo.status === "importing") startedAt.current[repo.id] = Date.now();
      return repo;
    } catch (e) {
      setImportError(messageFor(e));
      return null;
    } finally {
      inFlight.current = false;
      setImporting(false);
      setUploading(false);
      setUploadProgress(null);
      // Refetch on failure too: the backend creates the row before reading bytes, so a
      // rejected archive leaves a failed row the list would otherwise never show.
      setNonce((n) => n + 1);
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

  return {
    repos,
    loading: live && !loaded,
    error,
    elapsed,
    importRepo,
    uploadRepo,
    uploadProgress,
    uploading,
    importing,
    importError,
    refresh,
  };
}
