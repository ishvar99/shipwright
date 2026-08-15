import { describe, expect, it } from "vitest";
import { FindingSchema, JobEventSchema, JobResultSchema } from "@/lib/contracts";
import { repoReview } from "@/lib/repo-routes";
import { narrate } from "@/lib/stream/narrative";
import { initialState, type TimelineEntry } from "@/lib/stream/reduce";
import { severityLabel, severityTone } from "@/lib/review";

describe("review wire contract", () => {
  it("accepts a review.fetched frame", () => {
    const r = JobEventSchema.safeParse({ seq: 1, type: "review.fetched", files: 9 });
    expect(r.success).toBe(true);
  });

  it("accepts a degraded stage frame", () => {
    const r = JobEventSchema.safeParse({
      seq: 3, type: "review.stage.degraded", stage: "security", error: "ReadTimeout",
    });
    expect(r.success).toBe(true);
  });

  it("strips a model name from a review frame", () => {
    // The events route is a byte pass-through, so zod is the only scrub point.
    const r = JobEventSchema.parse({ seq: 2, type: "review.ready", findings: 3, model: "qwen" });
    expect("model" in r).toBe(false);
  });

  it("declares no token counts on review frames", () => {
    const r = JobEventSchema.parse({
      seq: 4, type: "review.chunked", units: 2, input_tokens: 900,
    });
    expect("input_tokens" in r).toBe(false);
  });

  it("accepts a progress frame", () => {
    const r = JobEventSchema.safeParse({ seq: 9, type: "review.progress", done: 4, total: 9 });
    expect(r.success).toBe(true);
  });

  it("strips undeclared fields from a progress frame", () => {
    const r = JobEventSchema.parse({
      seq: 9, type: "review.progress", done: 4, total: 9, model: "qwen",
    });
    expect("model" in r).toBe(false);
  });
});

describe("JobResultSchema", () => {
  it("leaves review fields absent on a session that was never reviewed", () => {
    // Absent and empty are different claims: defaulting would assert complete:true and a
    // coverage tier about a localize job nobody reviewed.
    const r = JobResultSchema.parse({});
    expect(r.findings).toBeUndefined();
    expect(r.coverage).toBeUndefined();
    expect(r.complete).toBeUndefined();
  });

  it("parses review fields when they are present", () => {
    const r = JobResultSchema.parse({
      findings: [{ path: "a.py", line: 2, category: "quality", severity: "low", title: "t" }],
      coverage: { files: 1, reviewed: 1, tier: "graph" },
      complete: true,
    });
    expect(r.findings).toHaveLength(1);
    expect(r.coverage?.tier).toBe("graph");
    expect(r.coverage?.degraded).toEqual([]);
  });

  it("parses triage and supersede bookkeeping", () => {
    const r = JobResultSchema.parse({
      triage: { "a.py:2:security": { state: "kept" } },
      superseded_by: "job-2",
    });
    expect(r.triage?.["a.py:2:security"].state).toBe("kept");
    expect(r.triage?.["a.py:2:security"].reason).toBe("");
    expect(r.superseded_by).toBe("job-2");
  });

  it("parses a finding with its anchor", () => {
    const f = FindingSchema.parse({
      path: "a.py", line: 12, category: "security", severity: "high", title: "t",
    });
    expect(f.side).toBe("RIGHT");
    expect(f.agreed).toBe(false);
  });

  it("carries the hunk when present and defaults it when absent", () => {
    const absent = FindingSchema.parse({
      path: "a.py", line: 2, category: "quality", severity: "low", title: "t",
    });
    expect(absent.hunk).toBe("");
    const present = FindingSchema.parse({
      path: "a.py", line: 2, category: "quality", severity: "low", title: "t",
      hunk: "@@ hunk at line 1 @@\n+x",
    });
    expect(present.hunk).toContain("+x");
  });
});

describe("repoReview", () => {
  it("builds the route under the repo segment", () => {
    expect(repoReview("abc")).toBe("/app/repo/abc/review");
  });
});

describe("severity presentation", () => {
  it("maps severity onto the existing outcome vocabulary only", () => {
    expect(severityTone("high")).toBe("bg-danger-soft text-danger");
    expect(severityTone("medium")).toBe("bg-warn-soft text-warn");
    expect(severityTone("low")).toBe("bg-soft text-subtle");
  });

  it("never returns an evidence hue", () => {
    for (const s of ["high", "medium", "low"] as const) {
      expect(severityTone(s)).not.toContain("evidence");
    }
  });

  it("claims only what the analysis knows", () => {
    // The matchTier rule: never promote a heuristic to a probability.
    for (const s of ["high", "medium", "low"] as const) {
      expect(severityLabel(s)).not.toMatch(/\d|%|confiden/i);
    }
  });
});

describe("review narration over the real event sequence", () => {
  // The production order: service.py emits review.fetched, then review_diff emits
  // review.chunked, per-chunk review.progress, and review.ready.
  const frames = [
    { seq: 1, type: "review.fetched", files: 9, truncated: false },
    { seq: 2, type: "review.chunked", units: 9, skipped: 0 },
    { seq: 3, type: "review.progress", done: 4, total: 9 },
    { seq: 4, type: "review.ready", findings: 3 },
  ];

  function narrateFrames(upTo: number) {
    const state = {
      ...initialState("j", { mode: "network" }),
      timeline: frames.slice(0, upTo).map((f) => ({
        type: f.type,
        at: 0,
        data: Object.fromEntries(
          Object.entries(f).filter(([k]) => k !== "seq" && k !== "type"),
        ),
      })) as TimelineEntry[],
    };
    return narrate(state);
  }

  it("opens the checking beat on the same event that closes the reading beat", () => {
    // review.chunked is both review-read's close and review-check's open. Handling only
    // the close left the checking line nonexistent and its progress suffix unreachable.
    const lines = narrateFrames(2);
    expect(lines.map((l) => l.key)).toEqual(["review-read", "review-check"]);
    expect(lines[0].state).toBe("done");
    expect(lines[1].state).toBe("active");
  });

  it("reports the file count from the closing event's own payload", () => {
    // The fact is computed at close time from review.chunked, which carries `units` —
    // reading review.fetched's `files` here silently yielded undefined.
    expect(narrateFrames(2)[0].fact).toBe("9 files");
  });

  it("names skipped files rather than hiding them", () => {
    const state = {
      ...initialState("j", { mode: "network" }),
      timeline: [
        { type: "review.fetched", at: 0, data: { files: 9 } },
        { type: "review.chunked", at: 0, data: { units: 7, skipped: 2 } },
      ] as TimelineEntry[],
    };
    expect(narrate(state)[0].fact).toBe("7 files, 2 skipped");
  });

  it("closes the checking beat with its finding count", () => {
    const lines = narrateFrames(4);
    const check = lines.find((l) => l.key === "review-check");
    expect(check?.state).toBe("done");
    expect(check?.fact).toBe("3 findings");
  });
});
