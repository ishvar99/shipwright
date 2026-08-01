"use client";

import { use } from "react";
import { useRouter } from "next/navigation";
import { PanelBoundary } from "@/components/ui/panel-boundary";
import { SessionView } from "@/components/workspace/session-view";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import { isDemoJob } from "@/lib/fixtures";
import { repoFiles, repoHome } from "@/lib/repo-routes";
import { openTab } from "@/lib/repo-tabs";

export default function Page({
  params,
}: {
  params: Promise<{ repoId: string; jobId: string }>;
}) {
  const { repoId, jobId } = use(params);
  const { live, sessions } = useWorkspace();
  const router = useRouter();
  return (
    // Keyed by job: a different session gets a fresh stream. No stream exists outside this
    // subtree, so nothing in the chrome can reconnect-loop against a job that does not exist.
    <PanelBoundary label="session">
      <SessionView
        key={jobId}
        jobId={jobId}
        // Per session, not per app: the recording can now sit beside real rows, and it must
        // replay from the bundle rather than stream against a job the backend never had.
        live={live && !isDemoJob(jobId)}
        session={sessions.find((j) => j.id === jobId) ?? null}
        onNewSession={() => router.push(repoHome(repoId))}
        onOpenInEditor={(loc, jobRepoId, slug) => {
          // Open the tab here: navigation is the action, so the view never writes store state
          // while reacting to a prop.
          openTab(jobRepoId, loc.path, { preview: false });
          router.push(
            repoFiles(jobRepoId, {
              file: loc.path,
              line: loc.start_line,
              symbol: loc.name,
              slug,
            }),
          );
        }}
      />
    </PanelBoundary>
  );
}
