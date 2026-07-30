import { JobSchema } from "@/lib/contracts";
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
  dispose: () => void;
};

/**
 * Performs the effects `reduce` returns. Plain TypeScript on purpose: keeping the imperative
 * half outside React means no reducer runs twice under StrictMode and no mutable state hides
 * in a ref.
 */
export function createController(jobId: string, stream: JobStream, now = () => Date.now()): Controller {
  let state = initialState(jobId, stream.origin, now());
  let disposed = false;
  const listeners = new Set<() => void>();
  const timers = new Set<ReturnType<typeof setInterval>>();

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const dispatch = (action: Action): void => {
    if (disposed) return;
    const { state: next, effects } = reduce(state, action);
    const changed = next !== state;
    state = next;
    if (changed) notify();
    for (const effect of effects) perform(effect);
  };

  const perform = (effect: Effect): void => {
    if (disposed) return;
    switch (effect.kind) {
      case "connect":
        stream.run(effect.from, dispatch);
        break;
      case "wait": {
        const t = setTimeout(() => {
          timers.delete(t);
          dispatch({ kind: "opening", from: resumeFrom(state) });
        }, jitter(effect.ms));
        timers.add(t);
        break;
      }
      case "fetchJob":
        void fetchJob();
        break;
      case "stop":
        stream.stop();
        break;
    }
  };

  const fetchJob = async (): Promise<void> => {
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" });
      if (!res.ok) return;
      const parsed = JobSchema.safeParse(await res.json());
      if (parsed.success) dispatch({ kind: "job", job: parsed.data });
    } catch {
      // The stream is the primary channel; a failed refetch is not worth a banner.
    }
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      // Ask REST first, so `queued` and an already-finished job come from the record rather
      // than being guessed from how densely events arrive.
      void fetchJob().then(() => {
        if (!disposed) dispatch({ kind: "opening", from: resumeFrom(state) });
      });
      const tick = setInterval(() => dispatch({ kind: "tick", now: now() }), TICK_MS);
      timers.add(tick);
    },
    dispose() {
      if (disposed) return;
      const { state: next } = reduce(state, { kind: "dispose" });
      state = next;
      disposed = true;
      for (const t of timers) clearTimeout(t as ReturnType<typeof setTimeout>);
      timers.clear();
      stream.stop();
      notify();
      listeners.clear();
    },
  };
}
