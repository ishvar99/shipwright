"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/icon";

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

/** A question gets an answer grounded in the code that was found — and never an edit. The
 * ranked locations below it are the evidence for what it says. */
export function AnswerCard({ text, streaming }: { text: string; streaming: boolean }) {
  const secs = useElapsed(streaming && !text);
  // Named beats: the model is the only slow part, and the first call is the slowest.
  const note =
    secs < 4
      ? "Reading the code…"
      : secs < 12
        ? `Thinking… ${secs}s`
        : `Thinking… ${secs}s · the first answer is slowest while the model warms up`;

  if (!text && !streaming) return null;
  return (
    <div className="sw-card grid gap-2 p-4">
      <p className="flex items-center gap-2 text-xs font-medium text-subtle">
        <Icon name="crosshair" size={14} />
        Answer
      </p>
      {/* A blinking 7px caret is not feedback for a 20-second wait — it rendered as an empty
          box. Before the first token the card says what it is doing; after it, the caret is
          enough because text is visibly arriving. */}
      {!text && streaming ? (
        <p className="flex items-center gap-2 text-muted" role="status">
          <span className="sw-thinking" aria-hidden />
          {note}
        </p>
      ) : (
        <p className="whitespace-pre-wrap text-fg">
          {text}
          {streaming && <span className="sw-caret" aria-hidden />}
        </p>
      )}
    </div>
  );
}

/** Nothing in the repository to act on. Said plainly, with the two things that do work. */
/** The router said "no code work" — but why matters. A capability question gets capabilities,
 * a symptomless "fix it" gets asked for the symptom, and only noise gets the generic card. */
const NO_WORK: Record<string, { title: string; body: string }> = {
  meta: {
    title: "Here\u2019s what I can do.",
    body:
      "Shipwright reads this repository and works from your words. Ask where something lives " +
      "or how it works, and it answers from the code. Describe a bug or a change, and it " +
      "finds the exact places, drafts the fix, and proves it against your tests.",
  },
  vague: {
    title: "Tell me what\u2019s broken, and I\u2019ll find it.",
    body:
      "\u201CFix it\u201D gives the search nothing to hold on to. Say what happens and where " +
      "\u2014 an error message, a symptom, a function name \u2014 and Shipwright finds the " +
      "code behind it.",
  },
};

const NO_WORK_DEFAULT = {
  title: "There\u2019s nothing here for me to work on.",
  body:
    "Shipwright works on one repository at a time. Describe a bug or a change you want made " +
    "and it will find the code and propose a fix, or ask a question about the code and it " +
    "will answer with the relevant files.",
};

export function NoWorkCard({
  reason = "",
  onNewSession,
}: {
  reason?: string;
  onNewSession?: () => void;
}) {
  const copy = NO_WORK[reason] ?? NO_WORK_DEFAULT;
  return (
    <div className="sw-card grid gap-2 p-4">
      <p className="font-medium text-fg">{copy.title}</p>
      <p className="text-muted">{copy.body}</p>
      {onNewSession && (
        <div>
          <button
            type="button"
            onClick={onNewSession}
            className="text-accent underline underline-offset-4 transition-colors hover:text-fg"
          >
            Start a new session
          </button>
        </div>
      )}
    </div>
  );
}
