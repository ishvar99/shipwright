"use client";

import { Icon } from "@/components/ui/icon";

/** A question gets an answer grounded in the code that was found — and never an edit. The
 * ranked locations below it are the evidence for what it says. */
export function AnswerCard({
  text,
  streaming,
  waitingNote,
}: {
  text: string;
  streaming: boolean;
  /** Shown only before the first token, in place of an empty box. */
  waitingNote?: string;
}) {
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
          {waitingNote ?? "Thinking…"}
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
            className="text-accent underline underline-offset-4"
          >
            Start a new session
          </button>
        </div>
      )}
    </div>
  );
}
