"use client";

import { useEffect, useRef, useState } from "react";
import { AnswerCard } from "@/components/workspace/answer-card";

/**
 * The answer when our own engine is unreachable. It is labelled, always — an answer with no
 * index behind it is a weaker claim than a Shipwright session, and pretending otherwise would
 * be the one dishonest thing this feature could do.
 */
/** Counts up while the answer is pending. The elapsed second is the one real fact available
 * before the first token, and a wait you can see progressing reads very differently from one
 * that might be broken. */
function useElapsed(active: boolean): number {
  const [secs, setSecs] = useState(0);
  const startedAt = useRef(0);

  useEffect(() => {
    if (!active) return;
    // A ref, not state: the baseline is written once per run and reading the clock during
    // render is impure. The interval is the only thing that touches state.
    startedAt.current = Date.now();
    const id = setInterval(
      () => setSecs(Math.round((Date.now() - startedAt.current) / 1000)),
      500,
    );
    return () => {
      clearInterval(id);
      setSecs(0); // so the next run does not flash the previous run's total
    };
  }, [active]);

  return active ? secs : 0;
}

export function LiteAnswer({
  busy,
  text,
  error,
}: {
  busy: boolean;
  text: string;
  error: string | null;
}) {
  const secs = useElapsed(busy && !text);
  // Named beats, because the model is the only slow part and the first call is the slowest.
  const note = (streaming: boolean, body: string) =>
    !streaming || body
      ? undefined
      : secs < 4
        ? "Reading the code…"
        : secs < 12
          ? `Thinking… ${secs}s`
          : `Thinking… ${secs}s · the first answer is slowest while the model warms up`;

  if (error) {
    return (
      <p role="alert" className="text-danger">
        {error}
      </p>
    );
  }
  return (
    <div className="grid gap-2">
      <AnswerCard text={text} streaming={busy} waitingNote={note(busy, text)} />
      {/* Measured, not hedging: with the backend down the model sees a handful of recorded
          excerpts and will sometimes generalise past them. Saying so is the difference
          between a useful fallback and a confidently wrong one. */}
      <p className="text-xs text-subtle">
        Answered without the analysis backend — from a few recorded excerpts rather than a real
        index, so it can generalise beyond this repository and has no fix to apply. Run
        Shipwright locally for located results, diffs and verified fixes.
      </p>
    </div>
  );
}
