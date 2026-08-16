import { describe, expect, it } from "vitest";
import { FindingSchema, JobEventSchema, JobResultSchema } from "@/lib/contracts";
import { resolveIssueRef } from "@/lib/github-ref";
import { repoReview } from "@/lib/repo-routes";
import { narrate } from "@/lib/stream/narrative";
import { initialState, type TimelineEntry } from "@/lib/stream/reduce";
import {
  DISMISS_REASONS,
  fillUndecided,
  findingKey,
  hunkLines,
  keptCount,
  offerTargetsOpenRepo,
  receiptMarkdown,
  severityLabel,
  severityTone,
} from "@/lib/review";

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

  it("leaves target absent on a session that never had one, and parses it when present", () => {
    const absent = JobResultSchema.parse({});
    expect(absent.target).toBeUndefined();
    const present = JobResultSchema.parse({
      target: { number: 42, head_sha: "abc123" },
    });
    expect(present.target?.number).toBe(42);
    expect(present.target?.head_sha).toBe("abc123");
    expect(present.target?.slug).toBeUndefined();
    expect(present.target?.title).toBeUndefined();
  });

  it("defaults coverage.checks and parses it when the backend names them", () => {
    const defaulted = JobResultSchema.parse({
      coverage: { files: 1, reviewed: 1, tier: "graph" },
    });
    expect(defaulted.coverage?.checks).toEqual([]);
    const named = JobResultSchema.parse({
      coverage: { files: 1, reviewed: 1, tier: "graph", checks: ["security", "static analysis"] },
    });
    expect(named.coverage?.checks).toEqual(["security", "static analysis"]);
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

describe("pull-request detection contract", () => {
  it("the issue route's PR rejection carries a machine-readable flag", async () => {
    // The composer routes on `pull_request`, not on the sentence — copy edits to the
    // detail string must never silently turn the offer back into a dead end.
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../app/api/github/issue/route.ts", import.meta.url), "utf8"),
    );
    expect(src).toContain("pull_request: true");
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

describe("triage helpers", () => {
  const f = { path: "a.py", line: 2, category: "security" } as never;

  it("findingKey matches the backend identity exactly", () => {
    // Same string render.py's finding_key builds; the endpoint validates against it.
    expect(findingKey(f)).toBe("a.py:2:security");
  });

  it("hunkLines maps diff prefixes onto the existing sw-diff vocabulary", () => {
    expect(hunkLines("@@ hunk at line 1 @@\n ctx\n+added\n-removed")).toEqual([
      { kind: "ctx", text: "ctx" },
      { kind: "add", text: "added" },
      { kind: "del", text: "removed" },
    ]);
  });

  it("hunkLines drops the header and tolerates an empty hunk", () => {
    expect(hunkLines("")).toEqual([]);
    expect(hunkLines("@@ hunk at line 9, clipped @@")).toEqual([]);
  });

  it("keptCount counts only kept", () => {
    expect(
      keptCount({
        a: { state: "kept", reason: "" },
        b: { state: "dismissed", reason: "not_real" },
      }),
    ).toBe(1);
  });

  it("exposes exactly the four backend reasons, in triage order", () => {
    // Drift here silently produces a 400 from the endpoint's regex.
    expect(Object.keys(DISMISS_REASONS)).toEqual([
      "not_real",
      "not_worth_posting",
      "duplicate",
      "pre_existing",
    ]);
  });

  it("fillUndecided keeps only the undecided keys — an existing dismissal wins", () => {
    // "Keep all" reads as "finish the rest", not "discard my triage": a finding already
    // dismissed (or kept) must survive the fill untouched.
    const triage = { b: { state: "dismissed" as const, reason: "duplicate" } };
    const next = fillUndecided(["a", "b", "c"], triage);
    expect(next).toEqual({
      a: { state: "kept", reason: "" },
      b: { state: "dismissed", reason: "duplicate" },
      c: { state: "kept", reason: "" },
    });
  });
});

describe("the PR offer only targets the open repository", () => {
  const openRepo = { source: "github", slug: "me/myapp" };

  it("offers for a reference to the open repo", () => {
    expect(offerTargetsOpenRepo({ owner: "me", name: "myapp" }, openRepo)).toBe(true);
  });

  it("refuses a cross-repo reference", () => {
    // The bug this exists for: offering here would review me/myapp#123, a different PR.
    expect(offerTargetsOpenRepo({ owner: "facebook", name: "react" }, openRepo)).toBe(false);
  });

  it("refuses when no reference resolved, or the repo is not from GitHub", () => {
    expect(offerTargetsOpenRepo(null, openRepo)).toBe(false);
    expect(offerTargetsOpenRepo({ owner: "me", name: "myapp" }, { source: "zip", slug: "me/myapp" })).toBe(false);
    expect(offerTargetsOpenRepo({ owner: "me", name: "myapp" }, null)).toBe(false);
  });
});

describe("receiptMarkdown", () => {
  it("states what the row proves and nothing it does not", () => {
    const md = receiptMarkdown({
      title: "fix: race",
      number: 42,
      headSha: "9f3ab2100",
      coverage: {
        files: 9,
        reviewed: 9,
        unreviewed: [],
        degraded: [],
        tier: "graph",
        checks: ["security", "static analysis"],
      },
      findings: 8,
      kept: 3,
      dismissed: { not_real: 4, pre_existing: 1 },
      reviewUrl: "https://github.com/o/r/pull/42#pullrequestreview-1",
    });
    expect(md).toContain("#42");
    expect(md).toContain("9f3ab21"); // short sha
    expect(md).toContain("3 kept");
    expect(md).toContain("4 not a real issue");
    // Data-posture claims are deliberately out of scope: the hosted deploy's model tier
    // differs from local, so a sometimes-true sentence here would be worse than none.
    expect(md).not.toMatch(/retain|training|not used/i);
  });

  it("omits the GitHub link when the review was never posted", () => {
    const md = receiptMarkdown({
      title: "fix: race",
      number: 42,
      headSha: "9f3ab2100",
      coverage: { files: 1, reviewed: 1, unreviewed: [], degraded: [], tier: "graph", checks: [] },
      findings: 0,
      kept: 0,
      dismissed: {},
      reviewUrl: "",
    });
    expect(md).not.toContain("posted to GitHub");
  });
});

describe("resolveIssueRef cross-repo behaviour the gate depends on", () => {
  it("resolves a qualified reference to another repository", () => {
    const openRepo = {
      id: "r1", slug: "me/myapp", source: "github", status: "ready",
      symbols: 1, files: 1, ref: "", error: "", created_at: "",
    } as never;
    const ref = resolveIssueRef("facebook/react#123", openRepo);
    // If this ever stopped resolving cross-repo, the gate above could be simplified.
    expect(ref).toEqual({ owner: "facebook", name: "react", number: 123 });
  });
});

describe("receiptMarkdown states only what it knows", () => {
  const base = {
    title: "fix: race", number: 42, headSha: "9f3ab2100",
    findings: 8, kept: 3, dismissed: { not_real: 4, pre_existing: 1 },
    reviewUrl: "https://github.com/o/r/pull/42#pullrequestreview-1",
  };
  const cov = (checks: string[]) => ({
    files: 9, reviewed: 9, unreviewed: [], degraded: [], tier: "graph" as const, checks,
  });

  it("names the checks that ran", () => {
    const md = receiptMarkdown({ ...base, coverage: cov(["security", "static analysis"]) });
    expect(md).toContain("#42");
    expect(md).toContain("9f3ab21");
    expect(md).toContain("3 kept");
    expect(md).toContain("4 not a real issue");
    expect(md).toContain("checks run: security, static analysis");
  });

  it("says so rather than printing a blank when checks were never recorded", () => {
    // A row written before coverage.checks existed. "checks run:  ·" is a claim with
    // nothing behind it, on the one surface whose value is that every word is true.
    const md = receiptMarkdown({ ...base, coverage: cov([]) });
    expect(md).toContain("checks run: not recorded");
    expect(md).not.toContain("checks run:  ");
  });

  it("accounts for undecided findings rather than dropping them", () => {
    // 8 findings, 3 kept, 0 dismissed leaves five unaccounted for behind an arrow that
    // reads as a partition.
    const md = receiptMarkdown({
      ...base, dismissed: {}, coverage: cov(["security"]),
    });
    expect(md).toContain("5 undecided");
  });

  it("omits the undecided clause when triage is complete", () => {
    const md = receiptMarkdown({
      ...base, kept: 3, dismissed: { not_real: 5 }, coverage: cov(["security"]),
    });
    expect(md).not.toContain("undecided");
  });

  it("makes no data-posture claim", () => {
    // Posture belongs to the org/trust sub-project; the hosted model tier differs from
    // local, so a sometimes-true sentence is worse than none.
    const md = receiptMarkdown({ ...base, coverage: cov(["security"]) });
    expect(md).not.toMatch(/retain|training|not used|private/i);
  });
});
