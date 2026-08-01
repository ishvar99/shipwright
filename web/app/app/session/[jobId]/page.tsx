"use client";

import { use } from "react";
import { useRouter } from "next/navigation";
import { PanelBoundary } from "@/components/ui/panel-boundary";
import { SessionView } from "@/components/workspace/session-view";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import { openTab } from "@/lib/repo-tabs";

export default function Page({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = use(params);
  const { live, sessions } = useWorkspace();
  const router = useRouter();
  return (
    // Keyed by job: a different session gets a fresh stream. No stream exists outside this
    // subtree, so nothing in the chrome can reconnect-loop against a job that does not exist.
    <PanelBoundary label="session">
      <SessionView
        key={jobId}
        jobId={jobId}
        live={live}
        session={sessions.find((j) => j.id === jobId) ?? null}
        onNewSession={() => router.push("/app")}
        onOpenInEditor={(loc, repoId, slug) => {
          // Open the tab here: navigation is the action, so the view never writes store state
          // while reacting to a prop.
          openTab(repoId, loc.path, { preview: false });
          const q = new URLSearchParams({
            file: loc.path,
            line: String(loc.start_line),
            symbol: loc.name,
            slug,
          });
          router.push(`/app/repo/${repoId}?${q}`);
        }}
      />
    </PanelBoundary>
  );
}
