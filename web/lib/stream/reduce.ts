import type { TraceStage } from "@/components/ui/trace";
import { JobEventSchema, TERMINAL_EVENTS, type Job, type JobEvent } from "@/lib/contracts";
import type { ApiError, ErrorKind } from "@/lib/errors";
import type { Frame } from "@/lib/stream/frames";
import { redact } from "@/lib/stream/redact";

/* Three stages, not five. `model.selected` precedes `retrieval.started` by ~2ms and is a
 * selection, not a start; and retrieval overlaps the model calls inside one backend call with
 * no `retrieval.finished` event. These three are each bounded by two real events, so their
 * durations sum to `wall_ms` and a fabricated boundary is detectable. */
export const STAGE_KEYS = ["graph", "search", "results"] as const;
export type StageKey = (typeof STAGE_KEYS)[number];
export type StageState = "pending" | "active" | "done" | "failed" | "skipped";

export type Stage = {
  state: StageState;
  /** Server clock. Durations are server-minus-server only. */
  startedTs?: number;
  endedTs?: number;
  /** Client arrival. Live elapsed is client-minus-client only. The two clocks never mix. */
  startedAt?: number;
};

export type StreamOrigin =
  | { mode: "network" }
  | { mode: "replay"; capturedAt: string; note?: string };

export type StreamPhase =
  | "idle"
  | "connecting"
  | "replaying"
  | "live"
  | "reconnecting"
  | "failed"
  | "closed";

export const MAX_RECONNECTS = 8;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8000;

export type ActivityState = {
  jobId: string;
  origin: StreamOrigin;
  phase: StreamPhase;
  /** Absolute budget, never reset by a successful open: accept-then-drop cannot loop forever,
   * and a healthy silent build is never reported as failed. */
  reconnects: number;
  askedFrom: number;
  historyOnly: boolean;
  error?: { kind: ErrorKind; message: string };
  closedReason?: "terminal" | "disposed";

  now: number;
  lastByteAt?: number;

  repo?: string;
  mode?: string;
  base?: string;
  model?: string;
  retrievalConfig?: string;
  graph?: { files: number; symbols: number; callEdges?: number; importEdges?: number };
  usage?: { calls: number; inputTokens: number; outputTokens: number; parseFailures: number };
  locationCount?: number;

  stages: Record<StageKey, Stage>;
  outcome: { kind: "pending" | "done" | "failed"; wallMs?: number; error?: string };

  seen: Set<number>;
  contiguousMax: number;
  duplicates: number;
  quarantined: { seq?: number; type?: string; reason: string }[];
};

export type Action =
  | { kind: "opening"; from: number }
  | { kind: "open"; historyOnly: boolean; at: number }
  | { kind: "frame"; frame: Frame; at: number }
  | { kind: "ended"; at: number }
  | { kind: "failure"; error: ApiError; retryable: boolean; at: number }
  | { kind: "job"; job: Job }
  | { kind: "tick"; now: number }
  | { kind: "dispose" }
  | { kind: "reset" };

export type Effect =
  | { kind: "connect"; from: number }
  | { kind: "wait"; ms: number }
  | { kind: "fetchJob" }
  | { kind: "stop" };

export function initialState(jobId: string, origin: StreamOrigin, now = 0): ActivityState {
  return {
    jobId,
    origin,
    phase: "idle",
    reconnects: 0,
    askedFrom: 0,
    historyOnly: false,
    now,
    stages: {
      graph: { state: "pending" },
      search: { state: "pending" },
      results: { state: "pending" },
    },
    outcome: { kind: "pending" },
    seen: new Set(),
    contiguousMax: 0,
    duplicates: 0,
    quarantined: [],
  };
}

/** Naive ISO from the backend. Only differences are used, so the assumed zone cancels out. */
function tsMs(iso?: string): number | undefined {
  if (!iso) return undefined;
  const v = Date.parse(iso);
  return Number.isNaN(v) ? undefined : v;
}

export function backoffMs(reconnects: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, reconnects - 1));
}

function isTerminal(s: ActivityState): boolean {
  return s.outcome.kind !== "pending";
}

/** Parse a data frame into an event, or explain why it cannot be trusted. Never throws: one
 * unrecognised event must not wedge the stream. */
export function parseFrame(
  frame: Frame,
): { ok: true; event: JobEvent } | { ok: false; seq?: number; type?: string; reason: string } {
  const seqFromId = frame.id !== undefined && /^\d+$/.test(frame.id) ? Number(frame.id) : undefined;
  let body: unknown;
  try {
    body = JSON.parse(frame.data);
  } catch {
    return { ok: false, seq: seqFromId, type: frame.event, reason: "unparseable json" };
  }
  const bodyType =
    body && typeof body === "object" && "type" in body
      ? String((body as { type: unknown }).type)
      : undefined;
  // The `event:` line and the body must agree, or we cannot say which one to trust.
  if (frame.event !== undefined && bodyType !== undefined && frame.event !== bodyType) {
    return { ok: false, seq: seqFromId, type: frame.event, reason: "event line disagrees with body" };
  }
  const parsed = JobEventSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, seq: seqFromId, type: bodyType, reason: parsed.error.issues[0]?.message ?? "invalid" };
  }
  if (seqFromId !== undefined && seqFromId !== parsed.data.seq) {
    return { ok: false, seq: seqFromId, type: bodyType, reason: "id line disagrees with body seq" };
  }
  return { ok: true, event: parsed.data };
}

function quarantine(
  s: ActivityState,
  entry: { seq?: number; type?: string; reason: string },
): ActivityState {
  // Still advance the cursor: otherwise one unrecognised event blocks resume forever.
  const seen = entry.seq === undefined ? s.seen : new Set(s.seen).add(entry.seq);
  return {
    ...s,
    seen,
    contiguousMax: grow(seen, s.contiguousMax),
    quarantined: [...s.quarantined, entry],
  };
}

function grow(seen: Set<number>, from: number): number {
  let n = from;
  while (seen.has(n + 1)) n += 1;
  return n;
}

function stage(s: ActivityState, key: StageKey, patch: Partial<Stage>): ActivityState {
  return { ...s, stages: { ...s.stages, [key]: { ...s.stages[key], ...patch } } };
}

/** Nothing may be left `active` or `pending` once the job ends: a phantom pending tail reads as
 * work still to come. */
function settle(s: ActivityState, ended: StageState, ts?: number, at?: number): ActivityState {
  const stages = { ...s.stages };
  for (const key of STAGE_KEYS) {
    const cur = stages[key];
    if (cur.state === "active") stages[key] = { ...cur, state: ended, endedTs: ts ?? cur.endedTs };
    else if (cur.state === "pending") stages[key] = { ...cur, state: "skipped" };
  }
  void at;
  return { ...s, stages };
}

function fold(s: ActivityState, e: JobEvent, at: number): ActivityState {
  const ts = tsMs(e.ts);
  switch (e.type) {
    case "job.started":
      return { ...s, repo: e.repo, mode: e.mode, base: e.base };
    case "graph.building":
      return stage(s, "graph", { state: "active", startedTs: ts, startedAt: at });
    case "graph.ready":
      return stage(
        {
          ...s,
          graph: {
            files: e.files,
            symbols: e.symbols,
            callEdges: e.call_edges,
            importEdges: e.import_edges,
          },
        },
        "graph",
        { state: "done", endedTs: ts },
      );
    case "model.selected":
      return { ...s, model: e.model };
    case "retrieval.started":
      return stage({ ...s, retrievalConfig: e.channels }, "search", {
        state: "active",
        startedTs: ts,
        startedAt: at,
      });
    case "model.finished": {
      // Closes retrieval and model together: the backend measured them as one span.
      const withUsage: ActivityState = {
        ...s,
        usage: {
          calls: e.calls,
          inputTokens: e.input_tokens,
          outputTokens: e.output_tokens,
          parseFailures: e.parse_failures,
        },
      };
      return stage(stage(withUsage, "search", { state: "done", endedTs: ts }), "results", {
        state: "active",
        startedTs: ts,
        startedAt: at,
      });
    }
    case "localization.ready": {
      // Retrieval-only mode never emits model.finished, so this is what closes `search`.
      const searchClosed =
        s.stages.search.state === "active"
          ? stage(s, "search", { state: "done", endedTs: ts })
          : s;
      return stage({ ...searchClosed, locationCount: e.count }, "results", {
        state: "done",
        endedTs: ts,
      });
    }
    case "job.done":
      return settle(
        { ...s, outcome: { kind: "done", wallMs: e.wall_ms }, locationCount: e.locations },
        "done",
        ts,
      );
    case "job.failed":
      return settle({ ...s, outcome: { kind: "failed", error: redact(e.error) } }, "failed", ts);
  }
}

export function reduce(state: ActivityState, action: Action): { state: ActivityState; effects: Effect[] } {
  switch (action.kind) {
    case "reset":
      return { state: initialState(state.jobId, state.origin, state.now), effects: [] };

    case "tick":
      return { state: { ...state, now: action.now }, effects: [] };

    case "dispose":
      if (state.phase === "closed") return { state, effects: [] };
      return {
        state: { ...state, phase: "closed", closedReason: "disposed" },
        effects: [{ kind: "stop" }],
      };

    case "opening":
      return {
        state: { ...state, phase: "connecting", askedFrom: action.from, error: undefined },
        effects: [{ kind: "connect", from: action.from }],
      };

    case "open":
      return {
        state: {
          ...state,
          phase: action.historyOnly ? "replaying" : "live",
          historyOnly: action.historyOnly,
          lastByteAt: action.at,
        },
        effects: [],
      };

    case "job": {
      const terminalByRest = action.job.status === "done" || action.job.status === "errored";
      // Terminal is monotone: a REST snapshot may promote to terminal but never demote. The
      // worker commits DONE in a different session than the one that emits job.done, so REST
      // is sometimes the only witness.
      const outcome = isTerminal(state)
        ? state.outcome
        : terminalByRest
          ? {
              kind: action.job.status === "done" ? ("done" as const) : ("failed" as const),
              wallMs: action.job.wall_ms || undefined,
              error: action.job.error ? redact(action.job.error) : undefined,
            }
          : state.outcome;
      const promoted = outcome !== state.outcome;
      // No `repo` here: the Job record carries repo_id, not the slug. Only job.started has it.
      const next: ActivityState = {
        ...state,
        mode: state.mode ?? action.job.mode,
        base: state.base ?? action.job.base_mode,
        model: state.model ?? (action.job.model || undefined),
        locationCount: state.locationCount ?? action.job.result.locations.length,
        outcome,
      };
      return {
        state: promoted ? settle(next, outcome.kind === "done" ? "done" : "failed") : next,
        effects: [],
      };
    }

    case "frame": {
      const s = { ...state, lastByteAt: action.at };
      if (action.frame.comment) return { state: s, effects: [] }; // heartbeat: liveness only

      const parsed = parseFrame(action.frame);
      if (!parsed.ok) {
        return {
          state: quarantine(s, { seq: parsed.seq, type: parsed.type, reason: parsed.reason }),
          effects: [],
        };
      }
      const e = parsed.event;

      // Dedupe before the terminal check: a reconnect legitimately replays seqs we already
      // have, and that is benign. Quarantine is reserved for genuine anomalies.
      if (s.seen.has(e.seq)) {
        return { state: { ...s, duplicates: s.duplicates + 1 }, effects: [] };
      }
      if (isTerminal(s) || s.phase === "closed") {
        return {
          state: quarantine(s, { seq: e.seq, type: e.type, reason: "after terminal" }),
          effects: [],
        };
      }

      const seen = new Set(s.seen).add(e.seq);
      let next: ActivityState = {
        ...fold(s, e, action.at),
        seen,
        contiguousMax: grow(seen, s.contiguousMax),
      };

      if (TERMINAL_EVENTS.has(e.type)) {
        next = { ...next, phase: "closed", closedReason: "terminal" };
        // Refetch only on job.done: localization.ready is emitted before the job's result is
        // committed, so refetching there can render "no locations" beside a full trace.
        const effects: Effect[] =
          e.type === "job.done" ? [{ kind: "fetchJob" }, { kind: "stop" }] : [{ kind: "stop" }];
        return { state: next, effects };
      }
      return { state: next, effects: [] };
    }

    case "ended":
    case "failure": {
      const s = { ...state, lastByteAt: action.at };
      if (s.phase === "closed") return { state: s, effects: [] };

      const fatal = action.kind === "failure" && !action.retryable;
      if (fatal) {
        return {
          state: {
            ...s,
            phase: "failed",
            error: { kind: action.error.kind, message: action.error.message },
          },
          effects: [{ kind: "stop" }],
        };
      }
      // A body that ends with no terminal event means the transport died, not the job. Calling
      // a running job finished is a permanently wrong terminal state.
      const reconnects = s.reconnects + 1;
      if (reconnects > MAX_RECONNECTS) {
        return {
          state: {
            ...s,
            phase: "failed",
            reconnects,
            error: {
              kind: action.kind === "failure" ? action.error.kind : "backend_unreachable",
              message: `Lost the stream after ${MAX_RECONNECTS} attempts`,
            },
          },
          effects: [{ kind: "stop" }],
        };
      }
      return {
        state: { ...s, phase: "reconnecting", reconnects },
        effects: [{ kind: "wait", ms: backoffMs(reconnects) }],
      };
    }
  }
}

/* --- selectors ----------------------------------------------------------- */

/** The cursor is derived, never stored: nothing to desync on a StrictMode remount or leak
 * across job ids, and a gap can still heal. */
export function resumeFrom(s: ActivityState): number {
  return Math.max(0, s.contiguousMax);
}

const STAGE_LABEL: Record<StageKey, string> = {
  graph: "graph",
  search: "retrieval",
  results: "results",
};

export function traceStages(s: ActivityState): TraceStage[] {
  const out: TraceStage[] = [];
  for (const key of STAGE_KEYS) {
    const st = s.stages[key];
    if (st.state === "skipped") continue;
    const label = key === "search" && s.model ? "retrieval + model" : STAGE_LABEL[key];
    const durationMs =
      st.startedTs !== undefined && st.endedTs !== undefined ? st.endedTs - st.startedTs : undefined;
    out.push({ key, label, state: st.state, durationMs, detail: stageDetail(s, key) });
  }
  return out;
}

function stageDetail(s: ActivityState, key: StageKey): string | undefined {
  if (key === "graph") return s.graph ? `${s.graph.symbols} symbols` : undefined;
  if (key === "search") {
    const parts = [s.retrievalConfig, s.usage ? `${s.usage.calls} calls` : undefined].filter(Boolean);
    return parts.length ? parts.join(" · ") : undefined;
  }
  return s.locationCount !== undefined ? `${s.locationCount} locations` : undefined;
}

export function activeStage(s: ActivityState): StageKey | null {
  return STAGE_KEYS.find((k) => s.stages[k].state === "active") ?? null;
}

/** Client-clock only: how long the open stage has been open. */
export function elapsedInStageMs(s: ActivityState): number | undefined {
  const key = activeStage(s);
  const startedAt = key ? s.stages[key].startedAt : undefined;
  return startedAt === undefined ? undefined : Math.max(0, s.now - startedAt);
}

/** A replayed stream can never be labelled live, whatever the phase says. Connectivity and
 * provenance are different axes. */
export function streamLabel(s: ActivityState): { text: string; tone: "active" | "idle" | "good" | "warn" | "bad" } {
  if (s.origin.mode === "replay") return { text: "replaying recorded run", tone: "idle" };
  switch (s.phase) {
    case "idle":
      return { text: "idle", tone: "idle" };
    case "connecting":
      return { text: "connecting", tone: "idle" };
    case "replaying":
      return { text: "loading timeline", tone: "idle" };
    case "live":
      return { text: "live", tone: "active" };
    case "reconnecting":
      return { text: `reconnecting (${s.reconnects})`, tone: "warn" };
    case "failed":
      return { text: s.error?.message ?? "stream failed", tone: "bad" };
    case "closed":
      return s.outcome.kind === "failed"
        ? { text: "failed", tone: "bad" }
        : { text: "complete", tone: "good" };
  }
}
