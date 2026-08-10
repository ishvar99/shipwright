import { describe, expect, it } from "vitest";
import fixture from "@/fixtures/msal-extract-rerank.json";
import { JobSchema, SourceSchema, type Job } from "@/lib/contracts";
import { ApiError } from "@/lib/errors";
import { createDecoder, feed } from "@/lib/stream/frames";
import { redact } from "@/lib/stream/redact";
import { activeElapsedMs, doneSummary, failureCopy, narrate } from "@/lib/stream/narrative";
import { relativeTime, sessionTitle } from "@/lib/sessions";
import { TOUR_STEPS, tourStep } from "@/lib/tour";
import { localFrame } from "@/lib/local/run";
import {
  MAX_RECONNECTS,
  activeStage,
  backoffMs,
  elapsedInStageMs,
  initialState,
  jobLabel,
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
    expect(expected).toHaveLength(RAWS.length);

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
    expect(s.contiguousMax).toBe(RAWS.length);
    expect(s.quarantined).toEqual([]);
  });

  it("labels the combined span as retrieval + model when a model ran", () => {
    expect(traceStages(s).map((t) => t.label)).toEqual(["graph", "retrieval + model", "results"]);
  });

  // The session now spends most of its wall time writing the fix, which sits outside the
  // three locate stages — so the invariant is bounded-above, and each span is checked against
  // its own event boundaries in the timeline.
  it("stage durations are real spans bounded by the wall time", () => {
    const total = traceStages(s).reduce((n, t) => n + (t.durationMs ?? 0), 0);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThanOrEqual(fixture.job.wall_ms);
    const at = (type: string) => s.timeline.find((t) => t.type === type)?.ts ?? NaN;
    expect(traceStages(s)[0].durationMs).toBe(at("graph.ready") - at("graph.building"));
    expect(traceStages(s)[1].durationMs).toBe(at("engine.finished") - at("understand.started"));
  });

  it("carries the graph and retrieval facts through — and no usage, which no longer travels", () => {
    expect(s.graph).toEqual({ files: 33, symbols: 463, callEdges: 2308, importEdges: 246 });
    // Token counts are not a field on the state at all now: /api/jobs blanks them on every
    // JSON route, and the events stream is a byte pass-through, so the schema is the scrub.
    expect("usage" in s).toBe(false);
    expect(s.retrievalConfig).toBe("hybrid");
    expect(s.candidateCount).toBe(30);
    expect(s.locationCount).toBe(10);
  });
});

describe("replay is idempotent", () => {
  it("folding the same stream twice changes nothing but the duplicate count", () => {
    const once = fold(RAWS);
    const twice = fold(RAWS, once);
    expect({ ...twice, duplicates: 0 }).toEqual({ ...once, duplicates: 0 });
    expect(twice.duplicates).toBe(RAWS.length);
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
    const s = fold(RAWS.slice(0, -2));
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
    const after = fold(
      [frame(RAWS.length + 1, "job.started", { repo: "x", mode: "m", base: "b" }, TS)],
      done,
    );
    expect(after.quarantined).toHaveLength(1);
    expect(after.stages.graph.state).toBe("done"); // not reopened
    expect(after.repo).toBe(done.repo);
  });
});

// Opening a link to a job that finished hours ago: REST answers first and says "done", then
// the stream replays the whole history. That history must still build the trace.
describe("cold-loading an already-finished job", () => {
  const s = fold(RAWS, reduce(opened(), { kind: "job", job: restJob({ status: "done" }) }).state);

  it("folds the replayed history instead of quarantining it as post-terminal", () => {
    expect(s.quarantined).toEqual([]);
    expect(traceStages(s)).toHaveLength(3);
    expect(traceStages(s).map((t) => t.state)).toEqual(["done", "done", "done"]);
  });

  it("still reports the real stage durations", () => {
    const total = traceStages(s).reduce((n, t) => n + (t.durationMs ?? 0), 0);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThanOrEqual(fixture.job.wall_ms);
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

describe("the clock only ticks when something is timing", () => {
  it("returns the identical state when no stage is open, so nothing re-renders", () => {
    const done = fold(RAWS);
    const { state } = reduce(done, { kind: "tick", now: 999_999 });
    expect(state).toBe(done); // reference equality is the point
  });

  it("advances elapsed time while a stage is open", () => {
    const mid = fold(RAWS.slice(0, 5), opened(), () => 1000); // search stage is active
    expect(activeStage(mid)).toBe("search");
    const { state } = reduce(mid, { kind: "tick", now: 4000 });
    expect(state).not.toBe(mid);
    expect(elapsedInStageMs(state)).toBe(3000);
  });
});

describe("timeline", () => {
  it("records every accepted event in order, with its display facts", () => {
    const s = fold(RAWS);
    expect(s.timeline).toHaveLength(RAWS.length);
    expect(s.timeline.map((t) => t.type)).toContain("understand.started");
    const found = s.timeline.find((t) => t.type === "candidates.found");
    expect(found?.data?.count).toBe(30);
    // Server timestamps ride along so the feed can show real durations.
    expect(s.timeline.every((t) => typeof t.ts === "number")).toBe(true);
  });

  it("does not grow on duplicates or quarantined frames", () => {
    const once = fold(RAWS);
    const twice = fold(RAWS, once);
    expect(twice.timeline).toHaveLength(RAWS.length);
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
    const s = fold(RAWS.slice(0, -1));
    const [f] = feed("", RAWS.at(-1)! + "\n\n").frames;
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

  it("describes the connection, not the job, when a real stream ends", () => {
    const s = fold(RAWS);
    expect(streamLabel(s).text).toBe("stream closed");
    expect(jobLabel(s).text).toBe("complete");
  });
});

// M4 puts these two side by side in the status bar. If they can print the same word they are
// not "visibly separate", so the vocabularies are asserted disjoint rather than eyeballed.
describe("the job and stream axes never share vocabulary", () => {
  const job = restJob;
  const jobStates: ActivityState[] = [
    initialState("j", { mode: "network" }),
    reduce(opened(), { kind: "job", job: job({ status: "queued" }) }).state,
    reduce(opened(), { kind: "job", job: job({ status: "running" }) }).state,
    fold(RAWS),
    fold([
      frame(1, "job.started", { repo: "r", mode: "m", base: "b" }, TS),
      frame(2, "job.failed", { error: "boom" }, TS),
    ]),
  ];
  const streamStates: ActivityState[] = [
    initialState("j", { mode: "network" }),
    reduce(initialState("j", { mode: "network" }), { kind: "opening", from: 0 }).state,
    opened(),
    reduce(opened(), { kind: "ended", at: 1 }).state,
    reduce(opened(), {
      kind: "failure",
      error: new ApiError("not_found", "job not found"),
      retryable: false,
      at: 1,
    }).state,
    reduce(opened(), { kind: "dispose" }).state,
    fold(RAWS),
    fold(RAWS.slice(0, 5), opened({ mode: "replay", capturedAt: "x" })),
  ];

  it("produces two disjoint sets of words", () => {
    const jobWords = new Set(jobStates.map((s) => jobLabel(s).text));
    const streamWords = new Set(streamStates.map((s) => streamLabel(s).text));
    expect([...jobWords].filter((w) => streamWords.has(w))).toEqual([]);
  });

  it("keeps an unbounded backend message out of the label itself", () => {
    const s = reduce(opened(), {
      kind: "failure",
      error: new ApiError("backend_error", "x".repeat(400)),
      retryable: true,
      at: 1,
    }).state;
    const failed = reduce(
      { ...s, reconnects: MAX_RECONNECTS },
      { kind: "failure", error: new ApiError("backend_error", "y".repeat(400)), retryable: true, at: 2 },
    ).state;
    expect(streamLabel(failed).text.length).toBeLessThan(24);
    expect(streamLabel(failed).detail).toBeTruthy();
  });

  it("never regresses to 'no job' once the job has started", () => {
    let s = opened();
    const labels: string[] = [];
    for (const raw of RAWS) {
      const { frames } = feed("", raw + "\n\n");
      for (const f of frames) s = reduce(s, { kind: "frame", frame: f, at: 0 }).state;
      labels.push(jobLabel(s).text);
    }
    // The gaps between stages must not read as the job disappearing.
    expect(labels).toEqual([...RAWS.slice(1).map(() => "running"), "complete"]);
  });

  it("reports a job as queued from the REST record", () => {
    const s = reduce(opened(), { kind: "job", job: restJob({ status: "queued" }) }).state;
    expect(jobLabel(s).text).toBe("queued");
  });
});

describe("a half-open connection is not reported as live", () => {
  it("degrades to quiet once bytes stop arriving", () => {
    const s = fold(RAWS.slice(0, 5), opened(), () => 1000);
    expect(streamLabel(s).text).toBe("live");
    const later = reduce(s, { kind: "tick", now: 1000 + 11_000 }).state;
    expect(streamLabel(later).text).toBe("quiet 11s");
    expect(streamLabel(later).tone).toBe("warn");
  });

  it("stays live while heartbeats keep arriving", () => {
    let s = fold(RAWS.slice(0, 5), opened(), () => 1000);
    const [hb] = feed("", ":\n\n").frames;
    s = reduce(s, { kind: "frame", frame: hb, at: 11_000 }).state;
    s = reduce(s, { kind: "tick", now: 12_000 }).state;
    expect(streamLabel(s).text).toBe("live");
  });
});

describe("redaction covers the shapes that actually reach the UI", () => {
  const cases: [string, string, string][] = [
    ["provider key", "AuthenticationError: {'x-api-key': 'sk-ant-api03-AbCdEfGhIjKlMnOp'}", "sk-ant"],
    ["github token", "fatal: could not read Password for ghp_AbCdEfGhIjKlMnOpQrSt", "ghp_"],
    ["bearer header", "401 with Authorization: Bearer eyJhbGciOiJIUzI1NiJ9", "eyJhbGci"],
    ["password containing @", "postgresql://user:p@ssw0rd@db.internal/shipwright", "ssw0rd"],
    ["nested bound parameters", "[parameters: ('a', [1, 2], 'hunter2')]", "hunter2"],
    ["home directory", "File \"/Users/somebody/projects/app/db.py\", line 3", "somebody"],
  ];

  for (const [name, input, leak] of cases) {
    it(`removes the ${name}`, () => {
      expect(redact(input)).not.toContain(leak);
    });
  }

  it("redacts a stream failure message, not just job.failed", () => {
    const s = reduce(
      { ...opened(), reconnects: MAX_RECONNECTS },
      {
        kind: "failure",
        error: new ApiError("not_found", "boom at /Users/somebody/app/x.py"),
        retryable: false,
        at: 1,
      },
    ).state;
    expect(s.error?.message).not.toContain("/Users/");
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

// The customer copy is the contract now: these strings are what a user reads, so they are
// asserted exactly rather than eyeballed.
describe("narrative feed", () => {
  it("tells the recorded run as checked-off beats with facts", () => {
    const s = fold(RAWS);
    const lines = narrate(s);
    expect(lines.map((l) => [l.key, l.state, l.label])).toEqual([
      ["read", "done", "Read the codebase"],
      ["understand", "done", "Understood the request"],
      ["search", "done", "Searched the code"],
      ["narrow", "done", "Picked the most likely places"],
      ["found", "done", "Found 10 places to look"],
      ["fix", "done", "Proposed a fix"],
    ]);
    expect(lines[0].fact).toBe("33 files, 463 symbols");
    expect(lines[2].fact).toBe("30 possible locations");
    const fx = fixture.job.result.fix!;
    expect(lines[5].fact).toBe(`+${fx.additions} −${fx.deletions}`);
    expect(doneSummary(s)).toBe(`Done · ${(fixture.job.wall_ms / 1000).toFixed(1)}s`);
  });

  it("shows exactly one active beat mid-run", () => {
    const mid = fold(RAWS.slice(0, 5)); // through understand.started
    const lines = narrate(mid);
    expect(lines.filter((l) => l.state === "active")).toHaveLength(1);
    expect(lines.at(-1)).toMatchObject({ state: "active", label: "Understanding the request…" });
    expect(doneSummary(mid)).toBeNull();
  });

  it("never mentions the machinery", () => {
    const text = JSON.stringify(narrate(fold(RAWS)));
    for (const word of ["model", "token", "hybrid", "bm25", "rerank", "qwen"]) {
      expect(text.toLowerCase()).not.toContain(word);
    }
  });

  it("flips the active beat to failed and keeps the detail behind the disclosure", () => {
    const s = fold([
      frame(1, "job.started", { repo: "r", mode: "m", base: "b" }, TS),
      frame(2, "graph.building", {}, TS),
      frame(3, "job.failed", { error: "ConnectError: [Errno 61] Connection refused" }, TS),
    ]);
    expect(narrate(s).at(-1)).toMatchObject({ state: "failed" });
    const copy = failureCopy("ConnectError: [Errno 61] Connection refused");
    expect(copy.headline).toBe("The analysis engine isn't responding right now. Try again in a moment.");
    expect(failureCopy("FileNotFoundError: gone.py").headline).toBe(
      "We couldn't read this repository. Re-import it and try again.",
    );
    expect(failureCopy("ValueError: whatever").headline).toBe(
      "Something went wrong on our side and this run didn't finish. Please try again.",
    );
  });

  it("narrates opening a pull request, and says so plainly when it is refused", () => {
    const opened = fold([
      frame(1, "pr.started", { branch: "shipwright/fix-c2fee3f9", slug: "psf/requests" }, TS),
      frame(2, "pr.ready", { url: "https://github.com/psf/requests/pull/42", number: 42 }, TS),
    ]);
    expect(narrate(opened)).toMatchObject([
      { key: "pr", state: "done", label: "Opened a pull request", fact: "#42" },
    ]);

    const refused = fold([
      frame(1, "pr.started", { branch: "shipwright/fix-c2fee3f9", slug: "psf/requests" }, TS),
      frame(2, "pr.failed", { reason: "You don't have push access to psf/requests." }, TS),
    ]);
    expect(narrate(refused)).toMatchObject([
      {
        state: "failed",
        label: "Couldn't open the pull request",
        fact: "You don't have push access to psf/requests.",
      },
    ]);
    // The banner must not contradict the beat with generic copy.
    expect(failureCopy("PullRequestError: You don't have push access to psf/requests.").headline)
      .toBe("You don't have push access to psf/requests.");
  });

  it("narrates a legacy recording through the fallback closes", () => {
    const legacy = [
      frame(1, "job.started", { repo: "r", mode: "extract_rerank", base: "hybrid" }, TS),
      frame(2, "graph.building", {}, TS),
      frame(3, "graph.ready", { files: 10, symbols: 20 }, TS),
      frame(4, "retrieval.started", { channels: "hybrid" }, TS),
      frame(5, "model.finished", { calls: 2, input_tokens: 1, output_tokens: 1, parse_failures: 0 }, TS),
      frame(6, "localization.ready", { count: 4 }, TS),
      frame(7, "job.done", { wall_ms: 900, locations: 4 }, TS),
    ];
    const lines = narrate(fold(legacy));
    expect(lines.every((l) => l.state === "done")).toBe(true);
    expect(lines.map((l) => l.key)).toEqual(["read", "search", "found"]);
  });

  it("suppresses the elapsed counter in replays, where a wall clock would lie", () => {
    const live = fold(RAWS.slice(0, 5), opened(), () => 0);
    const later = reduce(live, { kind: "tick", now: 5000 }).state;
    expect(activeElapsedMs(later)).toBe(5000);
    const replay = fold(RAWS.slice(0, 5), opened({ mode: "replay", capturedAt: "x" }), () => 0);
    const rLater = reduce(replay, { kind: "tick", now: 5000 }).state;
    expect(activeElapsedMs(rLater)).toBeUndefined();
  });
});

describe("session presentation", () => {
  it("titles a session from the first line of the issue", () => {
    expect(sessionTitle("Fix the cache\n\nlong body...")).toBe("Fix the cache");
    expect(sessionTitle("## Fix the cache")).toBe("Fix the cache");
    expect(sessionTitle("  ")).toBe("Untitled session");
    const long = sessionTitle("word ".repeat(30));
    expect(long.length).toBeLessThanOrEqual(65);
    expect(long.endsWith("…")).toBe(true);
  });

  it("renders relative times without timezone drift on naive timestamps", () => {
    const now = Date.parse("2026-07-31T12:00:00Z");
    expect(relativeTime("2026-07-31T11:59:30", now)).toBe("just now");
    expect(relativeTime("2026-07-31T11:20:00", now)).toBe("40m ago");
    expect(relativeTime("2026-07-31T03:00:00", now)).toBe("9h ago");
    expect(relativeTime("2026-07-28T12:00:00", now)).toBe("3d ago");
  });
});

describe("guided tour sequencing", () => {
  it("walks the recorded run's real order: issue, fix, then evidence at the end", () => {
    // Results render only when the run completes, and the fix streams in mid-run — the
    // steps must follow what is on screen, not the abstract pipeline order.
    expect(tourStep({ fixStarted: false, terminal: false })).toBe(0);
    expect(tourStep({ fixStarted: true, terminal: false })).toBe(1);
    expect(tourStep({ fixStarted: true, terminal: true })).toBe(3);
  });

  it("lets terminal win even if the fix fact was never seen", () => {
    // A replay resumed near the end may fold every frame in one batch.
    expect(tourStep({ fixStarted: false, terminal: true })).toBe(3);
  });

  it("never regresses across a monotonic fact sequence", () => {
    const seq = [
      { fixStarted: false, terminal: false },
      { fixStarted: true, terminal: false },
      { fixStarted: true, terminal: true },
    ];
    const steps = seq.map(tourStep);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
  });

  it("earns only steps that exist, and every step names a target the page renders", () => {
    expect(tourStep({ fixStarted: true, terminal: true })).toBeLessThan(TOUR_STEPS.length);
    const targets = TOUR_STEPS.map((s) => s.target);
    expect(targets.slice(0, -1).every(Boolean)).toBe(true); // narrated steps point somewhere
    expect(targets[targets.length - 1]).toBeNull(); // the closing card points at the CTA
  });
});

describe("local run frames", () => {
  // Every shape the browser pipeline emits, exactly as run.ts emits it. Frames the schema
  // rejects are quarantined wholesale — which showed as an empty feed and, worse, as the
  // reducer "reconnecting" a stream that was never broken, re-running the model each time.
  const SHAPES: [string, Record<string, unknown>][] = [
    ["job.started", { repo: "o/n", mode: "local", base: "bm25" }],
    ["intent.ready", { intent: "question" }],
    ["graph.building", {}],
    ["graph.ready", { files: 2, symbols: 4, call_edges: 0, import_edges: 0 }],
    ["search.started", { channels: "bm25" }],
    ["candidates.found", { count: 7 }],
    ["rank.started", { pool: 7 }],
    ["localization.ready", { count: 5 }],
    ["answer.started", {}],
    ["answer.delta", { text: "The" }],
    ["answer.ready", {}],
    ["job.done", { wall_ms: 1200, locations: 5 }],
    ["job.failed", { error: "nothing matched" }],
  ];

  it("emits only frames the wire schema accepts", () => {
    SHAPES.forEach(([type, payload], i) => {
      const r = parseFrame(localFrame(i + 1, type, payload));
      expect(r.ok, `${type}: ${r.ok ? "" : r.reason}`).toBe(true);
    });
  });

  it("numbers frames so a replayed duplicate is recognisable", () => {
    const r = parseFrame(localFrame(3, "answer.delta", { text: "x" }));
    expect(r.ok && r.event.seq).toBe(3);
  });
});

describe("redaction of provider identity", () => {
  it("strips the endpoint an httpx failure prints", () => {
    // Real string, reproduced from the project venv: port 11434 plus /api/chat names the
    // provider as plainly as the `model` field every JSON route blanks.
    const raw = "HTTPStatusError: Client error '404 Not Found' for url 'http://localhost:11434/api/chat'";
    const out = redact(raw);
    expect(out).not.toContain("11434");
    expect(out).not.toContain("localhost");
    expect(out).toContain("HTTPStatusError"); // the kind survives; errors.ts classifies on it
  });

  it("still redacts credentials inside a URL before the host goes", () => {
    expect(redact("postgresql://user:hunter2@db.internal:5432/sw")).not.toContain("hunter2");
  });
});

describe("feed lines are uniquely keyed", () => {
  // The assisted engine emits search.started twice — a wide pass, then the ranked one
  // (codegraph/assisted.py:171,177) — so two lines legitimately share the `search` beat.
  // Keying the list by beat gave React duplicate keys and it reused the first line's DOM.
  it("gives a repeated beat two lines with distinct ids", () => {
    const s = fold(
      [
        frame(1, "search.started", { channels: "hybrid" }),
        frame(2, "candidates.found", { count: 120 }),
        frame(3, "search.started", { channels: "hybrid" }),
        frame(4, "candidates.found", { count: 30 }),
      ],
      opened(),
      () => 0,
    );
    const search = narrate(s).filter((l) => l.key === "search");
    expect(search).toHaveLength(2);
    expect(new Set(search.map((l) => l.id)).size).toBe(2);
    // Each keeps its own number: the second used to overwrite the first.
    expect(search.map((l) => l.fact)).toEqual(["120 possible locations", "30 possible locations"]);
  });
});
