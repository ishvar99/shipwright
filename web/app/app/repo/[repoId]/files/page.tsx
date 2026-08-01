"use client";

import { use } from "react";
import { useSearchParams } from "next/navigation";
import { PanelBoundary } from "@/components/ui/panel-boundary";
import { RepoView } from "@/components/workspace/repo-view";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import { isDemoRepo } from "@/lib/fixtures";

export default function Page({ params }: { params: Promise<{ repoId: string }> }) {
  const { repoId } = use(params);
  const q = useSearchParams();
  const { live, repoList } = useWorkspace();
  // The list is authoritative once loaded; the query param covers a cold deep link.
  const slug = repoList.find((r) => r.id === repoId)?.slug ?? q.get("slug") ?? "";
  const line = Number(q.get("line"));
  return (
    <PanelBoundary label="repository">
      <RepoView
        repoId={repoId}
        slug={slug}
        // The recorded repository serves its tree and file bodies from the bundle, and is
        // read-only, whether or not a backend is running.
        live={live && !isDemoRepo(repoId)}
        initialFile={q.get("file") ?? undefined}
        initialLine={Number.isFinite(line) && line > 0 ? line : undefined}
        initialSymbol={q.get("symbol") ?? undefined}
      />
    </PanelBoundary>
  );
}
