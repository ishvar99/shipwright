import { describe, expect, it } from "vitest";
import {
  AnalyticsSchema,
  JobSchema,
  LocationSchema,
  RepoSchema,
  SourceSchema,
  parseOrThrow,
} from "@/lib/contracts";
import { checklist, checklistComplete, nextStep } from "@/lib/checklist";
import { sessionFact } from "@/lib/sessions";
import { pickLiteContext } from "@/lib/lite-context";
import { parseWorkspacePath, repoFiles, repoHome, repoSession } from "@/lib/repo-routes";

// Fixtures copied from live responses, including the naive (no-offset) timestamps
// FastAPI emits — a schema that only accepts ISO-with-zone would break on real data.
const repo = {
  id: "2455b4e0-61d3-49a0-860f-e0207c0cb2e6",
  slug: "local:AzureAD__microsoft-authentication-library-for-python",
  source: "local",
  status: "ready",
  symbols: 463,
  files: 33,
  ref: "66a1c5a",
  error: "",
  created_at: "2026-07-29T13:03:40.076913",
};

const location = {
  rank: 1,
  symbol: "msal/authority.py:Authority",
  path: "msal/authority.py",
  name: "Authority",
  kind: "class",
  start_line: 53,
  end_line: 136,
  score: 0.026974,
  channels: ["bm25", "graph"],
  signature: "class Authority(object):",
};

const job = {
  id: "7295b0dc-222d-4a64-9ac5-d91f1761ba32",
  repo_id: repo.id,
  kind: "localize",
  status: "done",
  mode: "extract_rerank",
  base_mode: "hybrid",
  model: "qwen2.5-coder-7b-16k",
  issue: "Instance metadata caching",
  result: {
    locations: [location],
    graph: { files: 33, symbols: 463, call_edges: 2308, import_edges: 246 },
  },
  error: "",
  input_tokens: 1740,
  output_tokens: 153,
  wall_ms: 6770,
  created_at: "2026-07-29T13:05:00.000000",
};

describe("RepoSchema", () => {
  it("parses a live repo object", () => {
    expect(RepoSchema.parse(repo).symbols).toBe(463);
  });

  it("rejects an unknown status rather than passing it through", () => {
    expect(() => RepoSchema.parse({ ...repo, status: "wat" })).toThrow();
  });

  it("accepts a zip-sourced repo", () => {
    // Uploaded repos carry source "zip"; the enum omitting it would fail every repos poll
    // once a single archive had been imported.
    expect(RepoSchema.parse({ ...repo, source: "zip", slug: "zip:demoproj" }).source).toBe("zip");
  });
});

describe("LocationSchema", () => {
  it("parses channels as a known union", () => {
    expect(LocationSchema.parse(location).channels).toEqual(["bm25", "graph"]);
  });

  it("drops an unrecognised channel instead of failing the whole location", () => {
    const parsed = LocationSchema.parse({ ...location, channels: ["bm25", "quantum"] });
    expect(parsed.channels).toEqual(["bm25"]);
  });
});

describe("JobSchema", () => {
  it("parses a completed job with results", () => {
    const parsed = JobSchema.parse(job);
    expect(parsed.status).toBe("done");
    expect(parsed.result.locations).toHaveLength(1);
    expect(parsed.result.graph.call_edges).toBe(2308);
  });

  it("tolerates a queued job whose result is an empty object", () => {
    const parsed = JobSchema.parse({ ...job, status: "queued", result: {} });
    expect(parsed.result.locations).toEqual([]);
  });

  it("rejects a missing required field", () => {
    const { status, ...withoutStatus } = job;
    void status;
    expect(() => JobSchema.parse(withoutStatus)).toThrow();
  });

  it("carries repo_slug, defaulting for jobs recorded before it existed", () => {
    expect(JobSchema.parse({ ...job, repo_slug: "zip:demoproj" }).repo_slug).toBe("zip:demoproj");
    const { repo_slug, ...without } = { ...job, repo_slug: "x" };
    void repo_slug;
    expect(JobSchema.parse(without).repo_slug).toBe("");
  });
});

describe("SourceSchema", () => {
  it("parses a source snippet", () => {
    const parsed = SourceSchema.parse({ path: "a.py", start: 45, lines: ["x = 1", "y = 2"] });
    expect(parsed.lines).toHaveLength(2);
  });
});

describe("AnalyticsSchema", () => {
  it("accepts the em-dash placeholder the backend uses for retrieval-only runs", () => {
    const parsed = AnalyticsSchema.parse({
      runs: [
        {
          run: "2f324a23",
          scaffold: "hybrid",
          model: "—",
          n: 353,
          file5: 59.8,
          func10: 28.6,
          commit: "ab14a53",
          date: "2026-07-29",
        },
      ],
      noise_floor_pp: 3.3,
    });
    expect(parsed.runs[0].model).toBe("—");
  });
});

describe("parseOrThrow", () => {
  it("raises a contract_mismatch ApiError naming the endpoint and the field", () => {
    try {
      parseOrThrow(RepoSchema, { nope: true }, "GET /api/repos");
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as { kind?: string; message: string; detail?: string };
      expect(err.kind).toBe("contract_mismatch");
      expect(err.message).toContain("GET /api/repos");
      expect(err.detail).toBeTruthy();
    }
  });

  it("returns the parsed value on success", () => {
    expect(parseOrThrow(SourceSchema, { path: "a.py", start: 1, lines: [] }, "x").path).toBe("a.py");
  });
});

describe("workspace routes", () => {
  it("nests a session inside its repository", () => {
    expect(repoSession("r1", "j2")).toBe("/app/repo/r1/s/j2");
  });

  it("builds the editor URL with only the parts it was given", () => {
    expect(repoFiles("r1")).toBe("/app/repo/r1/files");
    expect(repoFiles("r1", { file: "a/b.py", line: 12, symbol: "f" })).toBe(
      "/app/repo/r1/files?file=a%2Fb.py&line=12&symbol=f",
    );
  });

  // A zip import's slug is "zip:My App", which is a path separator away from a broken link.
  it("escapes ids that are not URL-safe", () => {
    expect(repoHome("a/b")).toBe("/app/repo/a%2Fb");
    expect(parseWorkspacePath(repoHome("a/b")).repoId).toBe("a/b");
  });

  it("reads the current repository and session back out of a path", () => {
    expect(parseWorkspacePath("/app/repo/r1/s/j2")).toEqual({ repoId: "r1", jobId: "j2" });
    expect(parseWorkspacePath("/app/repo/r1/files")).toEqual({ repoId: "r1", jobId: null });
    expect(parseWorkspacePath("/app/repo/r1")).toEqual({ repoId: "r1", jobId: null });
  });

  it("resolves the job on the legacy flat route but claims no repository", () => {
    expect(parseWorkspacePath("/app/session/j2")).toEqual({ repoId: null, jobId: "j2" });
  });

  it("treats the launcher and unrelated paths as scoping nothing", () => {
    expect(parseWorkspacePath("/app")).toEqual({ repoId: null, jobId: null });
    expect(parseWorkspacePath("/app/repos")).toEqual({ repoId: null, jobId: null });
    expect(parseWorkspacePath("/evals")).toEqual({ repoId: null, jobId: null });
  });
});

describe("first-run checklist", () => {
  const base = { exampleVisible: true, ownRepos: 0, ownSessions: 0, exampleHref: "/x" };

  it("arrives with the first step already complete", () => {
    const [first, ...rest] = checklist(base);
    expect(first.done).toBe(true);
    expect(rest.map((i) => i.done)).toEqual([false, false]);
  });

  // Someone who imported before the recording was ever on screen has still seen enough.
  it("counts the example as seen once the user has a repository of their own", () => {
    expect(checklist({ ...base, exampleVisible: false, ownRepos: 1 })[0].done).toBe(true);
    expect(checklist({ ...base, exampleVisible: false })[0].done).toBe(false);
  });

  it("points at the first unfinished step", () => {
    expect(nextStep(checklist(base))?.id).toBe("import");
    expect(nextStep(checklist({ ...base, ownRepos: 2 }))?.id).toBe("ship");
  });

  it("is complete, and so hidden, once a session of the user's own exists", () => {
    const done = checklist({ ...base, ownRepos: 1, ownSessions: 1 });
    expect(checklistComplete(done)).toBe(true);
    expect(nextStep(done)).toBeNull();
  });

  it("is not complete on the strength of the pre-completed step alone", () => {
    expect(checklistComplete(checklist(base))).toBe(false);
  });
});

describe("sessionFact", () => {
  const base = {
    id: "j", repo_id: "r", repo_slug: "o/n", kind: "localize", status: "done",
    mode: "extract_rerank", base_mode: "hybrid", client: "web", model: "", issue: "x",
    result: { locations: [], graph: {}, fix: null, intent: null, answer: "" },
    error: "", input_tokens: 0, output_tokens: 0, wall_ms: 21000,
    created_at: "2026-08-01T10:00:00",
  };
  const loc = {
    rank: 1, symbol: "m.f", path: "a.py", name: "f", kind: "function", signature: "def f()", channels: [],
    start_line: 1, end_line: 2, score: 1,
  };
  const job = (over: object) => parseOrThrow(JobSchema, { ...base, ...over }, "t");

  it("states the outcome per intent, with the wall time", () => {
    expect(sessionFact(job({ result: { ...base.result, intent: "question" } }))).toBe("answered · 21s");
    expect(sessionFact(job({ result: { ...base.result, intent: "change", locations: [loc, loc] } })))
      .toBe("2 places found · 21s");
    expect(sessionFact(job({ result: { ...base.result, intent: "other" } }))).toBe("no code work needed");
  });

  it("says running while there is no outcome, and never invents one on failure", () => {
    expect(sessionFact(job({ status: "running" }))).toBe("running");
    expect(sessionFact(job({ status: "errored" }))).toBe("didn't finish");
  });

  // Sessions recorded before intent routing existed have no intent and may have no wall time.
  it("degrades to plain facts on old rows", () => {
    expect(sessionFact(job({ wall_ms: 0, result: { ...base.result, locations: [loc] } }))).toBe("1 places found");
    expect(sessionFact(job({ wall_ms: 0 }))).toBe("done");
  });
});

describe("lite context selection", () => {
  const files = [
    { path: "msal/token_cache.py", content: "class TokenCache:\n  def evict(self): pass\n" },
    { path: "msal/application.py", content: "class ClientApplication:\n  def acquire(self): pass\n" },
    { path: "README.md", content: "# msal\nA library.\n" },
  ];

  it("picks only files the question actually names", () => {
    const got = pickLiteContext(files, "how does the token cache evict entries?");
    expect(got.map((f) => f.path)).toEqual(["msal/token_cache.py"]);
  });

  it("ranks a path match above a body mention", () => {
    const got = pickLiteContext(files, "what does application do");
    expect(got[0].path).toBe("msal/application.py");
  });

  // A free tier meters tokens, so an unbounded prompt is a failed request, not a slow one.
  it("truncates to the budget and marks what it cut", () => {
    const big = [{ path: "big.py", content: `cache ${"x".repeat(50_000)}` }];
    const [got] = pickLiteContext(big, "cache", { maxTotal: 900, maxPerFile: 900 });
    expect(got.content.length).toBeLessThan(1_000);
    expect(got.content).toContain("truncated");
  });

  it("sends nothing rather than noise when no file relates", () => {
    expect(pickLiteContext(files, "how do I bake sourdough bread")).toEqual([]);
    expect(pickLiteContext(files, "?!")).toEqual([]);
  });
});
