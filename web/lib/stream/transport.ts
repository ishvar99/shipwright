import { ApiError, type ErrorKind } from "@/lib/errors";
import { createDecoder, feed } from "@/lib/stream/frames";
import type { Action, StreamOrigin } from "@/lib/stream/reduce";

/** The seam. Both implementations push the same bytes through the same `feed()`, so a framing
 * or parsing bug cannot exist in one and not the other — which is the whole point of having a
 * recorded implementation at all. */
export type JobStream = {
  origin: StreamOrigin;
  /** Opens the stream from `from` and dispatches actions until it ends or is stopped. */
  run: (from: number, dispatch: (a: Action) => void) => void;
  stop: () => void;
};

export type CapturedFrame = { t: number; raw: string };

const RETRYABLE: ReadonlySet<ErrorKind> = new Set([
  "backend_unreachable",
  "backend_error",
  "timeout",
]);

export function networkEvents(jobId: string, now: () => number): JobStream {
  let controller: AbortController | null = null;
  let stopped = false;

  return {
    origin: { mode: "network" },
    stop() {
      stopped = true;
      controller?.abort();
    },
    run(from, dispatch) {
      if (stopped) return;
      controller = new AbortController();
      void (async () => {
        try {
          const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/events?after=${from}`, {
            headers: { accept: "text/event-stream" },
            signal: controller.signal,
            cache: "no-store",
          });
          if (!res.ok || !res.body) {
            const body: unknown = await res.json().catch(() => null);
            const kind = (
              body && typeof body === "object" && "kind" in body
                ? String((body as { kind: unknown }).kind)
                : "backend_error"
            ) as ErrorKind;
            const message =
              body && typeof body === "object" && "message" in body
                ? String((body as { message: unknown }).message)
                : `Stream failed (${res.status})`;
            dispatch({
              kind: "failure",
              error: new ApiError(kind, message),
              retryable: RETRYABLE.has(kind),
              at: now(),
            });
            return;
          }

          dispatch({ kind: "open", historyOnly: false, at: now() });
          const decode = createDecoder();
          const reader = res.body.getReader();
          let buffer = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const { frames, remainder } = feed(buffer, decode(value));
            buffer = remainder;
            for (const frame of frames) dispatch({ kind: "frame", frame, at: now() });
          }
          if (!stopped) dispatch({ kind: "ended", at: now() });
        } catch (e) {
          if (stopped || (e instanceof Error && e.name === "AbortError")) return;
          dispatch({
            kind: "failure",
            error: new ApiError("backend_unreachable", "Lost the connection to the stream"),
            retryable: true,
            at: now(),
          });
        }
      })();
    },
  };
}

export type FixtureOptions = {
  /** Replay speed. Affects pacing only; printed durations always come from the frame data. */
  speed?: number;
  /** Compress dead air without touching the numbers on screen. */
  maxGapMs?: number;
  loop?: boolean;
};

export function fixtureEvents(
  frames: CapturedFrame[],
  origin: Extract<StreamOrigin, { mode: "replay" }>,
  now: () => number,
  opts: FixtureOptions = {},
): JobStream {
  const { speed = 1, maxGapMs = Infinity, loop = false } = opts;
  const timers: ReturnType<typeof setTimeout>[] = [];
  let stopped = false;

  return {
    origin,
    stop() {
      stopped = true;
      for (const t of timers) clearTimeout(t);
      timers.length = 0;
    },
    run(from, dispatch) {
      if (stopped) return;
      dispatch({ kind: "open", historyOnly: false, at: now() });

      // Schedule on cumulative capped gaps so a 15s silence can be compressed for the demo
      // without altering the durations the trace prints.
      let clock = 0;
      let prev = frames[0]?.t ?? 0;
      const schedule = frames.map((f) => {
        clock += Math.min(maxGapMs, Math.max(0, f.t - prev)) / speed;
        prev = f.t;
        return { at: clock, raw: f.raw };
      });

      for (const item of schedule) {
        timers.push(
          setTimeout(() => {
            if (stopped) return;
            const { frames: parsed } = feed("", item.raw + "\n\n");
            for (const frame of parsed) dispatch({ kind: "frame", frame, at: now() });
          }, item.at),
        );
      }

      if (loop) {
        const total = schedule.at(-1)?.at ?? 0;
        timers.push(
          setTimeout(() => {
            if (stopped) return;
            dispatch({ kind: "reset" });
            this.run(from, dispatch);
          }, total + 2000),
        );
      }
    },
  };
}
