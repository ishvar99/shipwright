"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiGet } from "@/lib/client/api";
import { JobSchema } from "@/lib/contracts";
import { demoRepo, isDemoJob } from "@/lib/fixtures";
import { repoSession } from "@/lib/repo-routes";
import { useWorkspace } from "@/components/workspace/workspace-provider";

/**
 * The flat session route from before sessions moved inside repositories. It resolves the job's
 * repository and forwards, so links already shared or bookmarked still land in the right place.
 */
export default function Page({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = use(params);
  const { sessions, sessionsLoaded } = useWorkspace();
  const router = useRouter();
  const [missing, setMissing] = useState(false);

  // The recording is not in the database, so asking for it would be a guaranteed 404 that
  // ends on "That session isn't here" for a session sitting in the bundle.
  const known = isDemoJob(jobId) ? demoRepo.id : sessions.find((j) => j.id === jobId)?.repo_id;

  useEffect(() => {
    if (known) {
      router.replace(repoSession(known, jobId));
      return;
    }
    // Only once the list has settled, otherwise every cold load refetches a job it is about
    // to be handed.
    if (!sessionsLoaded) return;
    let alive = true;
    void apiGet(JobSchema, `/api/jobs/${encodeURIComponent(jobId)}`)
      .then((job) => alive && router.replace(repoSession(job.repo_id, jobId)))
      .catch(() => alive && setMissing(true));
    return () => {
      alive = false;
    };
  }, [known, jobId, router, sessionsLoaded]);

  if (missing) {
    return (
      <div className="sw-card grid gap-3 p-5">
        <h2 className="text-subhead font-semibold text-fg">That session isn&apos;t here</h2>
        <p className="text-muted">
          It may have been deleted, or it belongs to a repository that is no longer imported.
        </p>
        <div>
          <Link href="/app" className="sw-primary-link">
            Back to the workspace
          </Link>
        </div>
      </div>
    );
  }
  return <p className="p-5 text-subtle">Opening session…</p>;
}
