import { describe, expect, it } from "vitest";
import fixture from "@/fixtures/msal-extract-rerank.json";
import { JobSchema, SourceSchema, type Job } from "@/lib/contracts";
import { ApiError } from "@/lib/errors";
import { createDecoder, feed } from "@/lib/stream/frames";
import {
  MAX_RECONNECTS,
  backoffMs,
  initialState,
  parseFrame,
  reduce,
  resumeFrom,
  streamLabel,
  traceStages,
  type ActivityState,
  type StreamOrigin,
} from "@/lib/stream/reduce";

const RAWS = fixture.frames.map((f) => f.raw);

function frame(seq: number, type: string, payload: Record<string, unknown>, ts?: string): string {
  return `id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify({ ...payload, seq, type, ...(ts ? { ts } : {}) })}`;
}

function opened(origin: StreamOrigin = { mode: "network" }, from = 0): ActivityState {
  let s = initialState("job-1", origin, 0);
  s = reduce(s, { kind: "opening", from }).state;
  return reduce(s, { kind: "open", historyOnly: false, at: 0 }).state;
}

/** Feeds raw frames through the real decoder, exactly as a transport would. */
function fold(
  raws: string[],
  start = opened(),
  at: (i: number) => number = () => 0,
): ActivityState {
  let s = start;
  raws.forEach((raw, i) => {
    const { frames } = feed("", raw + "\n\n");
    for (const f of frames) s = reduce(s, { kind: "frame", frame: f, at: at(i) }).state;
  });
  return s;
}

const TS = "2026-07-29T21:32:55.000000";
const restJob = (over: Partial<Job> = {}): Job => JobSchema.parse({ ...fixture.job, ...over });

describe("feed", () => {
  it("emits identical frames no matter where the chunk boundary falls", () => {
    const whole = RAWS.join("\n\n") + "\n\n";
    const expected = feed("", whole).frames.map((f) => f.raw);
    expect(expected).toHaveLength(8);

    for (let split = 0; split <= whole.length; split += 1) {
      const a = feed("", whole.slice(0, split));
      const b = feed(a.remainder, whole.slice(split));
      expect([...a.frames, ...b.frames].map((f) => f.raw)).toEqual(expected);
    }
  });

  it("treats a comment-only frame as a heartbeat, not an event", () => {
    const { frames } = feed("", ":\n\n: hb\n\n");
    expect(frames).toHaveLength(2);
    expect(frames.every((f) => f.comment)).toBe(true);
  });

  it("tolerates CRLF line endings", () => {
    const { frames } = feed("", "id: 1\r\nevent: job.done\r\ndata: {}\r\n\r\n");
    expect(frames[0].event).toBe("job.done");
  });

  it("strips exactly one space after the colon", () => {
    const { frames } = feed("", "data:  two spaces\n\n");
    expect(frames[0].data).toBe(" two spaces");
  });
});

describe("createDecoder", () => {
  it("reassembles a multi-byte character split across chunks", () => {
    const bytes = new TextEncoder().encode('data: {"error":"café — ✓"}');
    const decode = createDecoder();
    let out = "";
    for (let i = 0; i < bytes.length; i += 1) out += decode(bytes.slice(i, i + 1));
    expect(out).toBe('data: {"error":"café — ✓"}');
  });
});

describe("parseFrame", () => {
  it("quarantines a frame whose event line disagrees with its body", () => {
    const [f] = feed("", `id: 1\nevent: graph.ready\ndata: {"seq":1,"type":"job.done","wall_ms":1,"locations":0}\n\n`).frames;
    const r = parseFrame(f);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/disagree/);
  });

  it("quarantines a frame whose id disagrees with its body seq", () => {
    const [f] = feed("", `id: 9\nevent: localization.ready\ndata: {"seq":7,"type":"localization.ready","count":10}\n\n`).frames;
    expect(parseFrame(f).ok).toBe(false);
  });

  it("quarantines unparseable json without throwing", () => {
    const [f] = feed("", "id: 1\nevent: job.done\ndata: {nope\n\n").frames;
    expect(parseFrame(f).ok).toBe(false);
  });

  it("accepts every frame in the committed fixture", () => {
    for (const raw of RAWS) {
      const [f] = feed("", raw + "\n\n").frames;
      expect(parseFrame(f).ok).toBe(true);
    }
  });
});

describe("happy path", () => {
  const s = fold(RAWS);

  it("closes all three stages and reports the job done", () => {
    expect(s.outcome).toEqual({ kind: "done", wallMs: fixture.job.wall_ms });
    expect(traceStages(s).map((t) => t.state)).toEqual(["done", "done", "done"]);
    expect(s.contiguousMax).toBe(8);
    expect(s.quarantined).toEqual([]);
  });

  it("labels the combined span as retrieval + model when a model ran", () => {
    expect(traceStages(s).map((t) => t.label)).toEqual(["graph", "retrieval + model", "results"]);
  });

  it("stage durations sum to within 20ms of the server-measured wall time", () => {
    const total = traceStages(s).reduce((n, t) => n + (t.durationMs ?? 0), 0);
    expect(Math.abs(total - fixture.job.wall_ms)).toBeLessThan(20);
  });

  it("carries the graph, usage and retrieval facts through", () => {
    expect(s.graph).toEqual({ files: 33, symbols: 463, callEdges: 2308, importEdges: 246 });
    expect(s.usage?.calls).toBe(2);
    expect(s.retrievalConfig).toBe("hybrid");
    expect(s.locationCount).toBe(10);
  });
});

describe("replay is idempotent", () => {
  it("folding the same stream twice changes nothing but the duplicate count", () => {
    const once = fold(RAWS);
    const twice = fold(RAWS, once);
    expect({ ...twice, duplicates: 0 }).toEqual({ ...once, duplicates: 0 });
    expect(twice.duplicates).toBe(8);
  });

  it("a full replay over an advanced cursor lands on the same state", () => {
    const partial = fold(RAWS.slice(0, 5));
    const resumed = fold(RAWS, partial); // server re-sent from seq 1
    const direct = fold(RAWS);
    expect({ ...resumed, duplicates: 0 }).toEqual({ ...direct, duplicates: 0 });
  });

  // Not order independence: the backend delivers ORDER BY seq, so an out-of-order fold is not
  // a state the reducer can reach. What must hold is that every prefix is self-consistent.
  it("leaves every prefix of the stream in a coherent state", () => {
    for (let n = 0; n <= RAWS.length; n += 1) {
      const s = fold(RAWS.slice(0, n));
      expect(s.contiguousMax).toBe(n);
      expect(s.quarantined).toEqual([]);
      // At most one stage open at a time, and none open once the job has ended.
      const active = Object.values(s.stages).filter((st) => st.state === "active");
      expect(active.length).toBeLessThanOrEqual(1);
      if (s.outcome.kind !== "pending") expect(active).toHaveLength(0);
    }
  });
});

describe("durations are omitted, never fabricated", () => {
  it("yields no duration when the server sent no timestamp", () => {
    const noTs = RAWS.map((raw) => raw.replace(/, "ts": "[^"]*"/, ""));
    expect(noTs.every((r) => !r.includes('"ts"'))).toBe(true);
    const s = fold(noTs);
    expect(traceStages(s).every((t) => t.durationMs === undefined)).toBe(true);
    // The authoritative total still comes from the server.
    expect(s.outcome.wallMs).toBe(fixture.job.wall_ms);
  });

  it("gives identical durations whether frames arrive together or one per second", () => {
    const batched = traceStages(fold(RAWS, opened(), () => 0));
    const spread = traceStages(fold(RAWS, opened(), (i) => i * 1000));
    expect(spread.map((t) => t.durationMs)).toEqual(batched.map((t) => t.durationMs));
  });
});

describe("retrieval-only mode", () => {
  const raws = [
    frame(1, "job.started", { repo: "r", mode: "hybrid", base: "hybrid" }, TS),
    frame(2, "graph.building", {}, TS),
    frame(3, "graph.ready", { files: 10, symbols: 20 }, TS),
    frame(4, "retrieval.started", { channels: "bm25" }, TS),
    frame(5, "localization.ready", { count: 4 }, "2026-07-29T21:32:56.000000"),
    frame(6, "job.done", { wall_ms: 1000, locations: 4 }, "2026-07-29T21:32:56.000000"),
  ];
  const s = fold(raws);

  it("closes the search span on localization.ready when no model ran", () => {
    expect(s.model).toBeUndefined();
    expect(traceStages(s).map((t) => t.label)).toEqual(["graph", "retrieval", "results"]);
    expect(traceStages(s)[1].durationMs).toBe(1000);
  });

  it("leaves nothing active or pending after the job ends", () => {
    expect(Object.values(s.stages).every((st) => st.state === "done")).toBe(true);
  });

  it("keeps `channels` as the mode string rather than filtering it as a channel list", () => {
    expect(s.retrievalConfig).toBe("bm25");
  });
});

describe("failure", () => {
  const s = fold([
    frame(1, "job.started", { repo: "r", mode: "hybrid", base: "hybrid" }, TS),
    frame(2, "graph.building", {}, TS),
    frame(3, "job.failed", {
      error:
        "OperationalError: (psycopg.OperationalError) connection failed " +
        "postgresql+psycopg://shipwright:shipwright@localhost:55432/shipwright " +
        "at /Users/somebody/projects/shipwright/src/db.py [parameters: ('secret',)]",
    }, TS),
  ]);

  it("marks the open stage failed and shows no phantom pending tail", () => {
    expect(traceStages(s)).toHaveLength(1);
    expect(traceStages(s)[0].state).toBe("failed");
  });

  it("redacts credentials, home directories and bound parameters", () => {
    const err = s.outcome.error ?? "";
    expect(err).not.toContain("shipwright:shipwright@");
    expect(err).not.toContain("/Users/");
    expect(err).not.toContain("'secret'");
    expect(err).toContain("OperationalError"); // the useful part survives
  });
});

describe("terminal state is monotone and absorbing", () => {
  it("takes terminal from the REST record when no job.done event arrives", () => {
    const s = fold(RAWS.slice(0, 7));
    expect(s.outcome.kind).toBe("pending");
    const after = reduce(s, { kind: "job", job: restJob({ status: "done", wall_ms: 999 }) }).state;
    expect(after.outcome).toEqual({ kind: "done", wallMs: 999, error: undefined });
    expect(Object.values(after.stages).every((st) => st.state !== "pending")).toBe(true);
  });

  it("never demotes a finished job because a REST snapshot still says running", () => {
    const done = fold(RAWS);
    const after = reduce(done, { kind: "job", job: restJob({ status: "running" }) }).state;
    expect(after.outcome.kind).toBe("done");
  });

  it("quarantines frames that arrive after the terminal event", () => {
    const done = fold(RAWS);
    const after = fold([frame(9, "job.started", { repo: "x", mode: "m", base: "b" }, TS)], done);
    expect(after.quarantined).toHaveLength(1);
    expect(after.stages.graph.state).toBe("done"); // not reopened
    expect(after.repo).toBe(done.repo);
  });
});

describe("quarantine never wedges the stream", () => {
  it("advances the cursor past an unrecognised event type", () => {
    const s = fold([
      RAWS[0],
      frame(2, "cosmic.ray", { whatever: true }, TS),
      RAWS[2].replace(/"seq": 3/, '"seq": 3').replace(/^id: 3/, "id: 3"),
    ]);
    expect(s.quarantined).toHaveLength(1);
    expect(resumeFrom(s)).toBe(3);
  });

  it("advances past a known type missing a required field", () => {
    const s = fold([RAWS[0], frame(2, "graph.ready", { files: 1 }, TS)]);
    expect(s.quarantined).toHaveLength(1);
    expect(resumeFrom(s)).toBe(2);
  });
});

describe("resumeFrom", () => {
  it("is zero on a fresh reducer", () => {
    expect(resumeFrom(initialState("j", { mode: "network" }))).toBe(0);
  });

  it("is the highest contiguous seq, so a gap can still heal", () => {
    const withGap = fold([RAWS[0], RAWS[1], RAWS[2], RAWS[3], RAWS[4], RAWS[6], RAWS[7]]);
    expect(resumeFrom(withGap)).toBe(5);
  });

  it("returns to zero after a reset", () => {
    const s = reduce(fold(RAWS), { kind: "reset" }).state;
    expect(resumeFrom(s)).toBe(0);
    expect(s.outcome.kind).toBe("pending");
  });
});

describe("heartbeats", () => {
  it("prove liveness without touching the cursor or any stage", () => {
    const before = fold(RAWS.slice(0, 5));
    const [hb] = feed("", ":\n\n").frames;
    const after = reduce(before, { kind: "frame", frame: hb, at: 5000 }).state;
    expect(after.lastByteAt).toBe(5000);
    expect(after.contiguousMax).toBe(before.contiguousMax);
    expect(after.seen).toEqual(before.seen);
    expect(after.stages).toEqual(before.stages);
  });
});

describe("stream machine", () => {
  it("treats a body that ends with no terminal event as a reconnect, not a finish", () => {
    const s = fold(RAWS.slice(0, 5));
    const { state, effects } = reduce(s, { kind: "ended", at: 1 });
    expect(state.phase).toBe("reconnecting");
    expect(state.outcome.kind).toBe("pending");
    expect(effects).toEqual([{ kind: "wait", ms: backoffMs(1) }]);
  });

  it("closes on a terminal event and asks for the job record once", () => {
    const s = fold(RAWS.slice(0, 7));
    const [f] = feed("", RAWS[7] + "\n\n").frames;
    const { state, effects } = reduce(s, { kind: "frame", frame: f, at: 1 });
    expect(state.phase).toBe("closed");
    expect(state.closedReason).toBe("terminal");
    expect(effects).toEqual([{ kind: "fetchJob" }, { kind: "stop" }]);
  });

  it("fails immediately on a non-retryable error, with no reconnect", () => {
    const { state, effects } = reduce(opened(), {
      kind: "failure",
      error: new ApiError("not_found", "job not found"),
      retryable: false,
      at: 1,
    });
    expect(state.phase).toBe("failed");
    expect(state.error?.kind).toBe("not_found");
    expect(effects).toEqual([{ kind: "stop" }]);
  });

  it("spends an absolute reconnect budget that a successful open cannot refill", () => {
    let s = opened();
    for (let i = 0; i < MAX_RECONNECTS; i += 1) {
      s = reduce(s, { kind: "ended", at: i }).state;
      expect(s.phase).toBe("reconnecting");
      s = reduce(s, { kind: "open", historyOnly: false, at: i }).state; // accept-then-drop
    }
    const { state } = reduce(s, { kind: "ended", at: 99 });
    expect(state.phase).toBe("failed");
    expect(state.reconnects).toBe(MAX_RECONNECTS + 1);
  });

  it("backs off monotonically up to a cap", () => {
    const delays = [1, 2, 3, 4, 5, 6, 7, 8].map(backoffMs);
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 8000, 8000, 8000]);
  });

  it("is idempotent on dispose", () => {
    const first = reduce(opened(), { kind: "dispose" });
    expect(first.state.closedReason).toBe("disposed");
    const second = reduce(first.state, { kind: "dispose" });
    expect(second.effects).toEqual([]);
  });
});

describe("provenance is independent of connectivity", () => {
  it("never labels a replayed stream live, whatever the phase", () => {
    const replay: StreamOrigin = { mode: "replay", capturedAt: fixture.meta.capturedAt };
    const s = fold(RAWS.slice(0, 5), opened(replay));
    expect(s.phase).toBe("live"); // events really are arriving at their recorded rate
    expect(streamLabel(s).text).toBe("replaying recorded run");
    expect(streamLabel(s).text).not.toMatch(/live/i);
  });

  it("labels a real finished stream complete", () => {
    expect(streamLabel(fold(RAWS)).text).toBe("complete");
  });
});

describe("committed fixture integrity", () => {
  it("parses as a whole: job, sources and every frame", () => {
    expect(() => JobSchema.parse(fixture.job)).not.toThrow();
    for (const src of Object.values(fixture.sources)) {
      expect(() => SourceSchema.parse(src)).not.toThrow();
    }
    expect(fold(RAWS).quarantined).toEqual([]);
  });

  it("was captured with server timestamps and is monotonic", () => {
    expect(fixture.meta.timingSource).toBe("server-ts");
    const ts = fixture.frames.map((f) => f.t);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
  });

  it("leaks no host path or credential", () => {
    const text = JSON.stringify(fixture);
    expect(text).not.toMatch(/\/Users\//);
    expect(text).not.toMatch(/\/home\/[a-z]/);
    expect(text).not.toMatch(/\/\/[^/\s:@]+:[^/\s@]+@/);
  });
});
