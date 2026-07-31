"use client";

import { useEffect, useRef } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";
import { useSource, type SourceState } from "@/lib/client/use-source";
import { qualifiedName } from "@/lib/results/rank";
import { useSelection } from "@/lib/results/selection";

function Message({ title, body }: { title: string; body?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center">
      <p className="text-fg">{title}</p>
      {body && <p className="max-w-[34ch] text-subtle">{body}</p>}
    </div>
  );
}

/** One sentence per state. `rejected` and `missing` are different facts and must not collapse
 * into a generic error. */
function Placeholder({ state }: { state: Exclude<SourceState, { kind: "loaded" }> }) {
  switch (state.kind) {
    case "idle":
      return <Message title="No location selected" body="Choose a result to see its source." />;
    case "loading":
      return <Message title="Loading source…" />;
    case "empty":
      return <Message title="That range is empty" body="The file has no lines in this range." />;
    case "missing":
      return (
        <Message
          title="File not found"
          body="It was present when the repository was indexed, so the checkout has changed since."
        />
      );
    case "too_large":
      return <Message title="File too large to display" body="The source view is capped at 2 MB." />;
    case "not_recorded":
      return (
        <Message
          title="Not part of this recording"
          body="The published capture includes source for the top few locations only."
        />
      );
    case "rejected":
      return <Message title="Cannot show that file" body={state.message} />;
    default:
      return <Message title="Could not load the source" body={state.message} />;
  }
}

export function CodePane({
  jobId,
  recorded,
  onClose,
}: {
  jobId: string;
  recorded: Record<string, unknown> | null;
  onClose?: () => void;
}) {
  const { location, focusNonce } = useSelection();
  const state = useSource(jobId, location, recorded);
  const ref = useRef<HTMLDivElement>(null);

  // Enter in the results list means "take me to the code".
  useEffect(() => {
    if (focusNonce > 0) ref.current?.focus();
  }, [focusNonce]);

  // Escape collapses the panel; focus returns to the selected card via the listbox's
  // roving tabindex when the user tabs back.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && onClose) {
      e.preventDefault();
      onClose();
    }
  };

  if (state.kind !== "loaded" || !location) {
    return (
      <div className="h-full" ref={ref} tabIndex={-1} onKeyDown={onKeyDown}>
        <Placeholder state={state.kind === "loaded" ? { kind: "idle" } : state} />
      </div>
    );
  }

  const { source } = state;
  const from = location.start_line;
  const to = location.end_line || from;

  return (
    <div
      ref={ref}
      tabIndex={-1}
      className="sw-code"
      aria-label={`Source of ${qualifiedName(location)}`}
      onKeyDown={onKeyDown}
    >
      <div className="sw-code-head">
        <span className="truncate font-mono" title={location.path}>
          {location.path.split("/").pop()}
        </span>
        <span className="shrink-0 rounded-full bg-soft px-2 py-0.5 text-xs text-subtle">
          {from === to ? `Line ${from}` : `Lines ${from}–${to}`}
        </span>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close code preview"
            className="ml-auto rounded p-1 text-subtle transition-colors hover:bg-soft hover:text-fg"
          >
            <Icon name="x" size={14} />
          </button>
        )}
      </div>
      {/* Not a syntax highlighter. The question is "is this the right function?", so the target
          range is at full contrast and its context is dimmed — no tokenizer, no theme to match. */}
      <ol className="sw-code-lines" start={source.start}>
        {source.lines.map((line, i) => {
          const n = source.start + i;
          const target = n >= from && n <= to;
          return (
            <li key={n} className={cn("sw-code-line", target && "sw-code-target")}>
              <span className="sw-code-num" aria-hidden>
                {n}
              </span>
              <code>{line || " "}</code>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
