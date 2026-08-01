"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, messageFor } from "@/lib/client/api";
import {
  GitHubRepoListSchema,
  GitHubStatusSchema,
  type GitHubRepo,
  type GitHubStatus,
} from "@/lib/contracts";

const IDLE: GitHubStatus = { configured: false, connected: false, login: "" };

/** Connect state plus the picker's list. The token never reaches this layer — the BFF holds
 * it and only ever returns repository names. */
export function useGitHub(live: boolean) {
  const [status, setStatus] = useState<GitHubStatus>(IDLE);
  const [repos, setRepos] = useState<GitHubRepo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    void apiGet(GitHubStatusSchema, "/api/github/status")
      .then((s) => !cancelled && setStatus(s))
      .catch(() => undefined); // not configured is the normal case, never an error banner
    return () => {
      cancelled = true;
    };
  }, [live]);

  const loadRepos = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRepos(await apiGet(GitHubRepoListSchema, "/api/github/repos"));
    } catch (e) {
      setError(messageFor(e));
      setRepos(null);
    } finally {
      setLoading(false);
    }
  }, []);

  return { status, repos, error, loading, loadRepos };
}
