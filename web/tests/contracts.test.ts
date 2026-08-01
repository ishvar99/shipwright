import { describe, expect, it } from "vitest";
import {
  AnalyticsSchema,
  JobSchema,
  LocationSchema,
  RepoSchema,
  SourceSchema,
  parseOrThrow,
} from "@/lib/contracts";

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
