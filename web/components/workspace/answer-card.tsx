"use client";

import { Icon } from "@/components/ui/icon";

/** A question gets an answer grounded in the code that was found — and never an edit. The
 * ranked locations below it are the evidence for what it says. */
export function AnswerCard({ text, streaming }: { text: string; streaming: boolean }) {
  if (!text && !streaming) return null;
  return (
    <div className="sw-card grid gap-2 p-4">
      <p className="flex items-center gap-2 text-xs font-medium text-subtle">
        <Icon name="crosshair" size={14} />
        Answer
      </p>
      <p className="whitespace-pre-wrap text-fg">
        {text}
        {streaming && <span className="sw-caret" aria-hidden />}
      </p>
    </div>
  );
}

/** Nothing in the repository to act on. Said plainly, with the two things that do work. */
export function NoWorkCard({ onNewSession }: { onNewSession?: () => void }) {
  return (
    <div className="sw-card grid gap-2 p-4">
      <p className="font-medium text-fg">There&rsquo;s nothing here for me to work on.</p>
      <p className="text-muted">
        Shipwright works on one repository at a time. Describe a bug or a change you want made
        and it will find the code and propose a fix, or ask a question about the code and it
        will answer with the relevant files.
      </p>
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
