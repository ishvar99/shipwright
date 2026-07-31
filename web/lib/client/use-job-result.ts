"use client";

import { useEffect, useState } from "react";
import { apiGet, messageFor } from "@/lib/client/api";
import { JobSchema, type Job } from "@/lib/contracts";

/**
 * The row source of truth. Locations come from GET /api/jobs/{id}, NOT from the event stream:
 * `localization.ready` carries only a count, so a stream that dies before `job.done` would
 * otherwise leave the results panel permanently empty beside a completed trace.
 */
export function useJobResult(
  jobId: string,
  terminal: boolean,
  replayJob: Job | null,
): { job: Job | null; error: string | null } {
  const [job, setJob] = useState<Job | null>(replayJob);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (replayJob || !terminal) return;
    let cancelled = false;
    void (async () => {
      try {
        const next = await apiGet(JobSchema, `/api/jobs/${encodeURIComponent(jobId)}`);
        if (!cancelled) setJob(next);
      } catch (e) {
        if (!cancelled) setError(messageFor(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId, terminal, replayJob]);

  return { job, error };
}
