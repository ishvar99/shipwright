"use client";

import { use } from "react";
import { useSearchParams } from "next/navigation";
import { PanelBoundary } from "@/components/ui/panel-boundary";
import { RepoView } from "@/components/workspace/repo-view";
import { useWorkspace } from "@/components/workspace/workspace-provider";

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
        live={live}
        initialFile={q.get("file") ?? undefined}
        initialLine={Number.isFinite(line) && line > 0 ? line : undefined}
        initialSymbol={q.get("symbol") ?? undefined}
      />
    </PanelBoundary>
  );
}
