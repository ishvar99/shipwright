import { JobSchema } from "@/lib/contracts";
import { isDemoJob } from "@/lib/fixtures";
import { isLocalJob } from "@/lib/local/store";
import {
  initialState,
  reduce,
  resumeFrom,
  type Action,
  type ActivityState,
  type Effect,
} from "@/lib/stream/reduce";
import type { JobStream } from "@/lib/stream/transport";

const TICK_MS = 1000;

/** Full jitter, so a backend restart does not bring every open tab back in lockstep. */
function jitter(ms: number): number {
  return ms / 2 + Math.random() * (ms / 2);
}

export type Controller = {
  getState: () => ActivityState;
  subscribe: (listener: () => void) => () => void;
  start: () => void;
  /** The one recovery action a failed stream offers. Keeps the timeline already folded. */
  retry: () => void;
  dispose: () => void;
};

/**
 * Performs the effects `reduce` returns. Plain TypeScript on purpose: keeping the imperative
 * half outside React means no reducer runs twice under StrictMode and no mutable state hides
 * in a ref.
 *
 * Takes a stream FACTORY, not an instance. Both transports latch `stopped` on stop(), so a
 * reused instance can never reopen — and StrictMode runs start -> dispose -> start on the very
 * same controller, which would otherwise leave the stream permanently closed in development.
 */
export function createController(
  jobId: string,
  makeStream: () => JobStream,
  now = () => Date.now(),
): Controller {
  let stream = makeStream();
  let state = initialState(jobId, stream.origin, now());
  let active = false;
  const listeners = new Set<() => void>();
  let tick: ReturnType<typeof setInterval> | null = null;
  const waits = new Set<ReturnType<typeof setTimeout>>();

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const dispatch = (action: Action): void => {
    if (!active) return;
    const { state: next, effects } = reduce(state, action);
    const changed = next !== state;
    state = next;
    if (changed) notify();
    for (const effect of effects) perform(effect);
  };

  const perform = (effect: Effect): void => {
    if (!active) return;
    switch (effect.kind) {
      case "connect":
        stream.run(effect.from, dispatch);
        break;
      case "wait": {
        const t = setTimeout(() => {
          waits.delete(t);
          dispatch({ kind: "opening", from: resumeFrom(state) });
        }, jitter(effect.ms));
        waits.add(t);
        break;
      }
      case "fetchJob":
        void fetchJob();
        break;
      case "stop":
        stream.stop();
        if (tick) {
          clearInterval(tick); // nothing left to time; do not hold a 1Hz timer forever
          tick = null;
        }
        break;
    }
  };

  const fetchJob = async (): Promise<void> => {
    // Rows the backend has never heard of — a browser-run job or the recording. Their stream
    // is the only source of truth, and the refetch the reducer requests on job.done would be
    // a guaranteed error against the proxy.
    if (isLocalJob(jobId) || isDemoJob(jobId)) return;
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" });
      if (!res.ok) return;
      const parsed = JobSchema.safeParse(await res.json());
      if (parsed.success) dispatch({ kind: "job", job: parsed.data });
    } catch {
      // The stream is the primary channel; a failed refetch is not worth a banner.
    }
  };

  const open = () => {
    // Not sequenced behind REST: a replay has no backend to ask, and a slow one would hold
    // the stream at `idle` for the whole fetch timeout.
    if (stream.origin.mode === "network") void fetchJob();
    dispatch({ kind: "opening", from: resumeFrom(state) });
    if (!tick) tick = setInterval(() => dispatch({ kind: "tick", now: now() }), TICK_MS);
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      if (active) return;
      active = true;
      open();
    },
    retry() {
      if (!active) return;
      stream = makeStream(); // the old one latched `stopped` and can never reopen
      open();
    },
    dispose() {
      if (!active) return;
      const { state: next } = reduce(state, { kind: "dispose" });
      state = next;
      active = false;
      if (tick) clearInterval(tick);
      tick = null;
      for (const t of waits) clearTimeout(t);
      waits.clear();
      stream.stop();
      stream = makeStream(); // ready for a StrictMode re-start on this same instance
      // Listeners belong to React's subscription lifecycle, not ours: it unsubscribes itself.
      notify();
    },
  };
}
