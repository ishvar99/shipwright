"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/ui/markdown";
import type { ReviewCoverage } from "@/lib/contracts";
import { receiptMarkdown } from "@/lib/review";

/**
 * The one card every review leaves behind, whether or not it was ever posted: what was
 * checked, what the human decided, and — once posted — the link back to GitHub. Deliberately
 * silent on data posture (what happens to the code or a model's training data): the hosted
 * deploy's model tier differs from a local run, so a sometimes-true sentence would be worse
 * than none — see `receiptMarkdown`.
 */
export function ReviewReceipt({
  title,
  number,
  headSha,
  coverage,
  findings,
  kept,
  dismissed,
  reviewUrl,
}: {
  title: string;
  number: number;
  headSha: string;
  coverage: ReviewCoverage;
  findings: number;
  kept: number;
  dismissed: Record<string, number>;
  reviewUrl: string;
}) {
  const [copied, setCopied] = useState(false);
  const md = receiptMarkdown({ title, number, headSha, coverage, findings, kept, dismissed, reviewUrl });

  return (
    <div className="sw-card grid gap-2 p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="sw-section-label">Review receipt</h3>
        <Button
          variant="ghost"
          onClick={() => {
            void navigator.clipboard.writeText(md).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? "Copied" : "Copy as markdown"}
        </Button>
      </div>
      <Markdown text={md} />
    </div>
  );
}
