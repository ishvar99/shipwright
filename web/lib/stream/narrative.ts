import { classifyJobError, firstLine } from "@/lib/errors";
import { redact } from "@/lib/stream/redact";
import type { ActivityState } from "@/lib/stream/reduce";

/**
 * The customer-facing account of a run: short present-tense lines that check off as the
 * pipeline moves. Pure over ActivityState.timeline, so the same feed renders live, on a
 * reopened session, and in the recorded demo.
 *
 * Rules: numbers appear only in completed lines; no channel names, modes, token counts or
 * model names — the engine is an implementation detail behind the API.
 */
export type FeedLine = {
  key: string;
  state: "active" | "done" | "failed";
  label: string;
  /** A small fact for the completed line ("33 files, 463 definitions"). */
  fact?: string;
};

type Beat = {
  key: string;
  opens: readonly string[];
  closes: readonly string[];
  active: string;
  done: string;
  fact?: (data: Record<string, number | string>) => string | undefined;
};

const INTENT_FACT: Record<string, string> = {
  change: "a change request",
  question: "a question about the code",
  other: "nothing to change here",
};

const BEATS: readonly Beat[] = [
  {
    key: "intent",
    opens: ["intent.started"],
    closes: ["intent.ready"],
    active: "Reading what you asked for…",
    done: "Understood what you asked for",
    fact: (d) => (typeof d.intent === "string" ? INTENT_FACT[d.intent] : undefined),
  },
  {
    key: "answer",
    opens: ["answer.started"],
    closes: ["answer.ready"],
    active: "Writing an answer…",
    done: "Answered",
  },
  {
    key: "read",
    opens: ["graph.building"],
    closes: ["graph.ready"],
    active: "Reading the codebase…",
    done: "Read the codebase",
    fact: (d) =>
      typeof d.files === "number" && typeof d.symbols === "number"
        ? `${d.files} files, ${d.symbols} definitions`
        : undefined,
  },
  {
    key: "understand",
    opens: ["understand.started"],
    closes: ["understand.done"],
    active: "Understanding the request…",
    done: "Understood the request",
    fact: (d) =>
      typeof d.terms === "number" && d.terms > 0 ? `${d.terms} key terms` : undefined,
  },
  {
    key: "search",
    opens: ["search.started", "retrieval.started"],
    closes: ["candidates.found"],
    active: "Searching for related code…",
    done: "Searched the code",
    fact: (d) =>
      typeof d.count === "number" ? `${d.count} possible locations` : undefined,
  },
  {
    key: "narrow",
    opens: ["rank.started"],
    closes: ["engine.finished", "model.finished"],
    active: "Narrowing to the most likely places…",
    done: "Picked the most likely places",
  },
  {
    key: "fix",
    opens: ["fix.started"],
    closes: ["fix.ready"],
    active: "Writing the fix…",
    done: "Proposed a fix",
    fact: (d) =>
      typeof d.additions === "number" && typeof d.deletions === "number"
        ? `+${d.additions} −${d.deletions}`
        : undefined,
  },
  {
    key: "apply",
    opens: ["apply.started"],
    closes: ["apply.done"],
    active: "Applying the fix…",
    done: "Applied the fix",
    fact: (d) => (typeof d.branch === "string" ? `branch ${d.branch}` : undefined),
  },
  {
    key: "env",
    opens: ["env.started"],
    closes: ["env.ready"],
    active: "Setting up the test environment…",
    done: "Test environment ready",
  },
  {
    key: "test",
    opens: ["test.started"],
    closes: ["test.done"],
    active: "Running the tests…",
    done: "Tests finished",
  },
];

export function narrate(state: ActivityState): FeedLine[] {
  const lines: FeedLine[] = [];
  let open: FeedLine | null = null;

  const close = (beatDone?: string, fact?: string) => {
    if (!open) return;
    open.state = "done";
    if (beatDone) open.label = beatDone;
    if (fact) open.fact = fact;
    open = null;
  };

  for (const entry of state.timeline) {
    const opens = BEATS.find((b) => b.opens.includes(entry.type));
    const closesOpen =
      open && BEATS.find((b) => b.key === open!.key && b.closes.includes(entry.type));

    if (closesOpen) {
      close(closesOpen.done, closesOpen.fact?.(entry.data ?? {}));
      continue;
    }
    if (opens) {
      // The pipeline is sequential: a new beat starting means the previous one finished,
      // even if its close event never arrived (legacy recordings).
      if (open && open.key !== opens.key) close(BEATS.find((b) => b.key === open!.key)?.done);
      if (!open || open.key !== opens.key) {
        open = { key: opens.key, state: "active", label: opens.active };
        lines.push(open);
      }
      continue;
    }
    if (entry.type === "localization.ready") {
      close(); // whatever was open is finished if the results exist
      const count = entry.data?.count;
      lines.push({
        key: "found",
        state: "done",
        label: typeof count === "number" ? `Found ${count} place${count === 1 ? "" : "s"} to look` : "Found the places to look",
      });
    }
    if (entry.type === "fix.failed") {
      if (open && open.key === "fix") {
        open.state = "failed";
        open.label = "Couldn't write a safe fix";
        open.fact = typeof entry.data?.reason === "string" ? entry.data.reason : undefined;
        open = null;
      }
      continue;
    }
    if (entry.type === "fix.skipped") {
      lines.push({ key: "fix", state: "done", label: "No single function to fix here" });
      continue;
    }
    if (entry.type === "test.done" && lines.at(-1)?.key === "test") {
      const last = lines.at(-1)!;
      const passed = Number(entry.data?.passed ?? 0);
      const failed = Number(entry.data?.failed ?? 0);
      last.state = failed > 0 ? "failed" : "done";
      last.label = failed > 0 ? `Tests · ${passed} passed, ${failed} failed` : `Tests · ${passed} passed`;
      open = null;
      continue;
    }
    if (entry.type === "job.failed" && open) {
      open.state = "failed";
      open = null;
    }
  }

  // A REST record can finish a session whose stream missed the tail.
  if (open) {
    if (state.outcome.kind === "done") close(BEATS.find((b) => b.key === (open as FeedLine).key)?.done);
    else if (state.outcome.kind === "failed") {
      (open as FeedLine).state = "failed";
    }
  }
  return lines;
}

/** The terminal summary — a line of its own, never a beat. */
export function doneSummary(state: ActivityState): string | null {
  if (state.outcome.kind !== "done") return null;
  const secs = state.outcome.wallMs !== undefined ? ` · ${(state.outcome.wallMs / 1000).toFixed(1)}s` : "";
  return `Done${secs}`;
}

/** One sentence per failure class, with the redacted detail kept behind a disclosure. */
export function failureCopy(errorText: string): { headline: string; detail: string } {
  const detail = firstLine(redact(errorText));
  const kind = classifyJobError(errorText);
  if (kind === "model_unavailable") {
    return { headline: "The analysis engine isn't responding right now. Try again in a moment.", detail };
  }
  const name = errorText.split(":", 1)[0].trim();
  if (["FileNotFoundError", "NotADirectoryError", "IsADirectoryError", "PermissionError"].includes(name)) {
    return { headline: "We couldn't read this repository. Re-import it and try again.", detail };
  }
  return { headline: "Something went wrong on our side and this run didn't finish. Please try again.", detail };
}

const ELAPSED_AFTER_MS = 3000;

/** Client-clock elapsed for the active beat, shown only once the silence is long enough to
 * need acknowledging — and never in a replay, where a wall clock would lie about compressed
 * pauses. */
export function activeElapsedMs(state: ActivityState): number | undefined {
  if (state.origin.mode === "replay") return undefined;
  if (state.outcome.kind !== "pending") return undefined;
  const last = state.timeline.at(-1);
  if (!last) return undefined;
  const gap = state.now - last.at;
  return gap >= ELAPSED_AFTER_MS ? gap : undefined;
}
