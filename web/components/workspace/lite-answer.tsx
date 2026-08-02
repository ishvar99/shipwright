"use client";

import { AnswerCard } from "@/components/workspace/answer-card";

/**
 * The answer when our own engine is unreachable. It is labelled, always — an answer with no
 * index behind it is a weaker claim than a Shipwright session, and pretending otherwise would
 * be the one dishonest thing this feature could do.
 */
export function LiteAnswer({
  busy,
  text,
  error,
}: {
  busy: boolean;
  text: string;
  error: string | null;
}) {
  if (error) {
    return (
      <p role="alert" className="text-danger">
        {error}
      </p>
    );
  }
  return (
    <div className="grid gap-2">
      <AnswerCard text={text} streaming={busy} />
      <p className="text-xs text-subtle">
        Answered without the analysis backend, so there is no index behind this and no fix to
        apply. Run Shipwright locally for located results, diffs and verified fixes.
      </p>
    </div>
  );
}
