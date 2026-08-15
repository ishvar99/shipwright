import { describe, expect, it } from "vitest";
import { FindingSchema, JobEventSchema, JobResultSchema } from "@/lib/contracts";
import { repoReview } from "@/lib/repo-routes";
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
