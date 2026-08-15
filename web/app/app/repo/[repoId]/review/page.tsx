"use client";

import { use } from "react";
import { PanelBoundary } from "@/components/ui/panel-boundary";
import { ReviewView } from "@/components/workspace/review-view";

export default function Page({ params }: { params: Promise<{ repoId: string }> }) {
  const { repoId } = use(params);
  return (
    <PanelBoundary label="review">
      <ReviewView repoId={repoId} />
    </PanelBoundary>
  );
}
