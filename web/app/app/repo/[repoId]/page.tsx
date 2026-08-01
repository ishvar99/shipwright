"use client";

import { use } from "react";
import { PanelBoundary } from "@/components/ui/panel-boundary";
import { RepoHome } from "@/components/workspace/repo-home";

export default function Page({ params }: { params: Promise<{ repoId: string }> }) {
  const { repoId } = use(params);
  return (
    <PanelBoundary label="repository">
      <RepoHome repoId={repoId} />
    </PanelBoundary>
  );
}
