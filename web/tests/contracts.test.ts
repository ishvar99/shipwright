import { describe, expect, it } from "vitest";
import {
  AnalyticsSchema,
  JobSchema,
  LocationSchema,
  RepoSchema,
  SourceSchema,
  parseOrThrow,
} from "@/lib/contracts";
import { sessionFact } from "@/lib/sessions";
import { indexPython, indexRepo } from "@/lib/local/index-repo";
import { bm25Rank, rrf, tokenize } from "@/lib/local/bm25";
import { locateLocal } from "@/lib/local/run";
import { unzip } from "@/lib/local/unzip";
import { prefilter } from "@/lib/intent";
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

describe("JobSchema turns", () => {
  it("defaults turns for every pre-feature and backend row", () => {
    expect(JobSchema.parse(job).result.turns).toEqual([]);
  });

  it("round-trips a conversation", () => {
    const parsed = JobSchema.parse({
      ...job,
      result: {
        ...job.result,
        answer: "second answer",
        turns: [
          { issue: "first?", answer: "first answer", locations: [location] },
          { issue: "second?", answer: "second answer" },
        ],
      },
    });
    expect(parsed.result.turns).toHaveLength(2);
    expect(parsed.result.turns[0].locations).toHaveLength(1);
    expect(parsed.result.turns[1].locations).toEqual([]); // defaulted per turn
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

describe("local index (browser port of the tree-sitter pass)", () => {
  const src = [
    "import os",
    "",
    "@decorator",
    "def top_level(a, b):",
    "    return a + b",
    "",
    "class Cache:",
    "    def __init__(self):",
    "        self._d = {}",
    "",
    "    async def evict(self, key):",
    "        del self._d[key]",
    "",
    "def after(x):",
    "    return x",
  ].join("\n");

  it("qualifies methods with their class, like the backend does", () => {
    const names = indexPython("m/cache.py", src).map((s) => s.name);
    expect(names).toEqual(["top_level", "Cache", "Cache.__init__", "Cache.evict", "after"]);
  });

  it("starts a decorated symbol at the def, not the decorator", () => {
    const top = indexPython("m/cache.py", src).find((s) => s.name === "top_level");
    expect(top?.start_line).toBe(4);
  });

  it("ends a symbol where its indented block ends", () => {
    const init = indexPython("m/cache.py", src).find((s) => s.name === "Cache.__init__");
    expect(init?.start_line).toBe(8);
    expect(init?.end_line).toBe(9);
  });

  it("uses the backend's id convention and never throws on junk", () => {
    expect(indexPython("a.py", src)[0].id).toBe("a.py:top_level");
    expect(() => indexPython("a.py", "def (((\n\tnope")).not.toThrow();
  });
});

describe("local index across languages", () => {
  it("extracts JS/TS functions, arrow consts and qualified class methods", () => {
    const src = [
      "export async function fetchUser(id) {",
      "  return get(`/u/${id}`);",
      "}",
      "export const parseToken = (raw) => {",
      "  return raw.split('.');",
      "};",
      "class AuthService {",
      "  constructor(store) { this.store = store; }",
      "  async login(user, pass) {",
      "    const t = this.store.get(user); // brace in comment {",
      "    return sign('{literal brace}', t);",
      "  }",
      "}",
    ].join("\n");
    const got = indexRepo([{ path: "src/auth.ts", content: src }]);
    const names = got.map((s) => s.name);
    expect(names).toContain("fetchUser");
    expect(names).toContain("parseToken");
    expect(names).toContain("AuthService");
    expect(names).toContain("AuthService.login");
    // Braces inside the string and the comment must not stretch the extent.
    const login = got.find((s) => s.name === "AuthService.login")!;
    expect(login.start_line).toBe(9);
    expect(login.end_line).toBe(12);
  });

  it("qualifies Go receiver methods like a class would", () => {
    const src = [
      "package server",
      "",
      "func (s *Server) Handle(w http.ResponseWriter) {",
      "\ts.mu.Lock()",
      "}",
      "",
      "func New() *Server {",
      "\treturn &Server{}",
      "}",
    ].join("\n");
    const names = indexRepo([{ path: "main.go", content: src }]).map((s) => s.name);
    expect(names).toContain("Server.Handle");
    expect(names).toContain("New");
  });

  it("reads Rust impl blocks and Java methods without control flow noise", () => {
    const rust = [
      "impl Parser {",
      "    pub fn parse(&self) -> Ast {",
      "        if self.done { return Ast::Empty; }",
      "        Ast::Node",
      "    }",
      "}",
    ].join("\n");
    const rustNames = indexRepo([{ path: "lib.rs", content: rust }]).map((s) => s.name);
    expect(rustNames).toContain("Parser");
    expect(rustNames).toContain("Parser.parse");
    expect(rustNames).not.toContain("Parser.if");

    const java = [
      "public class Billing {",
      "    public BigDecimal total(List<Item> items) {",
      "        for (Item i : items) { add(i); }",
      "        return sum;",
      "    }",
      "}",
    ].join("\n");
    const javaNames = indexRepo([{ path: "Billing.java", content: java }]).map((s) => s.name);
    expect(javaNames).toContain("Billing");
    expect(javaNames).toContain("Billing.total");
    expect(javaNames).not.toContain("Billing.for");
  });

  it("reads Ruby def…end by indentation, like Python", () => {
    const src = [
      "class Invoice",
      "  def total(items)",
      "    items.sum(&:price)",
      "  end",
      "end",
    ].join("\n");
    const names = indexRepo([{ path: "invoice.rb", content: src }]).map((s) => s.name);
    expect(names).toContain("Invoice");
    expect(names).toContain("Invoice.total");
  });

  it("chunks what it cannot parse, so every text file stays searchable", () => {
    const readme = indexRepo([{ path: "readme.md", content: "# not python" }]);
    expect(readme).toHaveLength(1);
    expect(readme[0].kind).toBe("section");
    expect(readme[0].name).toBe("readme.md"); // whole small file: named for itself

    const long = Array.from({ length: 150 }, (_, i) => `key${i}: value${i}`).join("\n");
    const sections = indexRepo([{ path: "config/app.yaml", content: long }]);
    expect(sections).toHaveLength(3);
    // Line-qualified ids: two sections may share a first line, ids may not collide.
    expect(new Set(sections.map((s) => s.id)).size).toBe(3);
    expect(sections[1].start_line).toBe(61);
  });

  it("reads Allman-brace C# where the class brace sits on its own line", () => {
    const src = [
      "public class OrderService",
      "{",
      "    public decimal Total(Order order)",
      "    {",
      "        return order.Sum();",
      "    }",
      "}",
    ].join("\n");
    const names = indexRepo([{ path: "OrderService.cs", content: src }]).map((s) => s.name);
    expect(names).toContain("OrderService");
    expect(names).toContain("OrderService.Total");
  });

  it("does not let a brace inside a regex literal corrupt later extents", () => {
    const src = [
      "class Lexer {",
      "  tokenize(s) {",
      "    return s.match(/\\{/g);",
      "  }",
      "  next() {",
      "    return this.pos += 1;",
      "  }",
      "}",
    ].join("\n");
    const got = indexRepo([{ path: "lexer.js", content: src }]);
    const next = got.find((s) => s.name === "Lexer.next");
    expect(next).toBeTruthy();
    expect(next!.end_line).toBe(7);
  });

  it("survives Rust lifetimes, which are unpaired apostrophes", () => {
    const src = [
      "impl<'a> Parser<'a> {",
      "    pub fn parse(&'a self) -> Ast<'a> {",
      "        Ast::Node",
      "    }",
      "}",
    ].join("\n");
    const names = indexRepo([{ path: "parse.rs", content: src }]).map((s) => s.name);
    expect(names.some((n) => n.endsWith(".parse"))).toBe(true);
  });

  it("extracts free C functions, which live at file scope with no class", () => {
    const src = [
      "static int parse_header(struct buf *b)",
      "{",
      "    return b->len;",
      "}",
      "",
      "int main(void) {",
      "    return 0;",
      "}",
    ].join("\n");
    const names = indexRepo([{ path: "parse.c", content: src }]).map((s) => s.name);
    expect(names).toContain("parse_header");
    expect(names).toContain("main");
  });

  it("reads Go generics and TS interfaces/typed arrows", () => {
    const go = "func Map[T any](xs []T) []T {\n\treturn xs\n}\n";
    expect(indexRepo([{ path: "m.go", content: go }]).map((s) => s.name)).toContain("Map");

    const ts = [
      "export interface Props {",
      "  title: string;",
      "}",
      "export const handler: Handler = (req) => {",
      "  return respond(req);",
      "};",
    ].join("\n");
    const names = indexRepo([{ path: "h.ts", content: ts }]).map((s) => s.name);
    expect(names).toContain("Props");
    expect(names).toContain("handler");
  });

  it("falls back to sections when a recognised extension has no declarations", () => {
    const got = indexRepo([{ path: "flags.ts", content: "export default { a: 1, b: 2 };" }]);
    expect(got).toHaveLength(1);
    expect(got[0].kind).toBe("section");
  });
});

describe("local retrieval (browser port of retrieve.py)", () => {
  it("splits snake_case and camelCase, as the backend tokenizer does", () => {
    expect(tokenize("get_accounts fooBar")).toEqual(
      expect.arrayContaining(["get", "accounts", "foo", "bar"]),
    );
  });

  it("ranks the document that actually matches first", () => {
    const docs = [
      { id: "a", text: "unrelated helper for parsing dates" },
      { id: "b", text: "token cache eviction removes expired tokens from the cache" },
      { id: "c", text: "http client retry logic" },
    ];
    expect(bm25Rank(docs, "how does token cache eviction work")[0]).toBe("b");
  });

  it("excludes non-matching documents rather than ranking them last", () => {
    const docs = [{ id: "a", text: "alpha" }, { id: "b", text: "beta" }];
    expect(bm25Rank(docs, "gamma")).toEqual([]);
  });

  // RRF is what makes two weak signals beat one strong one, exactly as in the backend.
  it("fuses rankings by reciprocal rank and is deterministic", () => {
    const fused = rrf([["a", "b", "c"], ["c", "a"]]);
    expect(fused[0]).toBe("a");
    expect(fused).toEqual(rrf([["a", "b", "c"], ["c", "a"]]));
  });

  it("handles empty input without throwing", () => {
    expect(bm25Rank([], "x")).toEqual([]);
    expect(rrf([])).toEqual([]);
  });
});

describe("local retrieval demotes docs", () => {
  const files = [
    { path: "History.md", content: "## router\nmiddleware route register handler apply use" },
    { path: "lib/application.js", content: "function use(fn) { // middleware route register apply\n  this.router.use(fn);\n}" },
  ];
  const symbols = indexRepo(files);

  it("puts code above changelog prose for a code question", () => {
    const got = locateLocal(symbols, "where does middleware apply to a route");
    expect(got[0].path).toBe("lib/application.js");
  });

  it("leaves docs alone when the question is about the docs", () => {
    const got = locateLocal(symbols, "what does the changelog say about middleware");
    expect(got[0].path).toBe("History.md");
  });
});

describe("local retrieval demotes tests", () => {
  const sym = (path: string, name: string) => ({
    id: `${path}:${name}`, path, name, kind: "function",
    start_line: 1, end_line: 2, text: `def ${name}(): pass  # token cache eviction`, parent: "",
  });
  const symbols = [
    sym("tests/test_cache.py", "test_eviction"),
    sym("msal/cache.py", "evict"),
  ];

  // Without the call graph, BM25 alone ranked five test methods above the function the
  // question was about. This is the compensation, and it must not fire on test questions.
  it("puts implementation above tests for a bug report", () => {
    expect(locateLocal(symbols, "token cache eviction is broken")[0].path).toBe("msal/cache.py");
  });

  it("leaves the order alone when the question is about tests", () => {
    const got = locateLocal(symbols, "which tests cover token cache eviction");
    expect(got.map((s) => s.path)).toContain("tests/test_cache.py");
    expect(got[0].path).toBe("tests/test_cache.py");
  });
});

describe("unzip", () => {
  // Minimal stored-only ZIP writer: real bytes, so these exercise the parser, not a mock.
  function zip(files: { path: string; body: string }[], mangle?: (b: Uint8Array) => void) {
    const enc = new TextEncoder();
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c >>> 0;
    }
    const crcOf = (b: Uint8Array) => {
      let c = 0xffffffff;
      for (const byte of b) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
      return (c ^ 0xffffffff) >>> 0;
    };
    const locals: Uint8Array[] = [];
    const centrals: Uint8Array[] = [];
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.path);
      const body = enc.encode(f.body);
      const crc = crcOf(body);
      const lh = new Uint8Array(30 + name.length + body.length);
      const lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, body.length, true);
      lv.setUint32(22, body.length, true);
      lv.setUint16(26, name.length, true);
      lh.set(name, 30);
      lh.set(body, 30 + name.length);
      const ch = new Uint8Array(46 + name.length);
      const cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, body.length, true);
      cv.setUint32(24, body.length, true);
      cv.setUint16(28, name.length, true);
      cv.setUint32(42, offset, true);
      ch.set(name, 46);
      locals.push(lh);
      centrals.push(ch);
      offset += lh.length;
    }
    const cdSize = centrals.reduce((n, c) => n + c.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);
    const out = new Uint8Array(offset + cdSize + 22);
    let at = 0;
    for (const b of [...locals, ...centrals, eocd]) {
      out.set(b, at);
      at += b.length;
    }
    mangle?.(out);
    return out.buffer;
  }

  // A repo zipped with its .git had the wrapper prefix computed from the surviving entries,
  // which deleted a real top-level source directory from every path.
  it("decides the wrapper directory from the whole archive, not the survivors", async () => {
    const got = await unzip(
      zip([
        { path: ".git/config", body: "[core]" },
        { path: "src/a.py", body: "def a(): pass" },
        { path: "src/b.py", body: "def b(): pass" },
      ]),
    );
    expect(got.map((e) => e.path)).toEqual(["src/a.py", "src/b.py"]);
  });

  it("still hoists a genuine single wrapper", async () => {
    const got = await unzip(
      zip([
        { path: "repo-main/a.py", body: "x = 1" },
        { path: "repo-main/b.py", body: "y = 2" },
      ]),
    );
    expect(got.map((e) => e.path)).toEqual(["a.py", "b.py"]);
  });

  // Stripping "proj/" off "proj//a.py" yields "/a.py", which the pre-strip guard never saw.
  it("rejects a path that only becomes absolute after stripping", async () => {
    await expect(
      unzip(zip([{ path: "proj//a.py", body: "x" }, { path: "proj/b.py", body: "y" }])),
    ).rejects.toThrow(/unsafe/i);
  });

  it("rejects content that does not match its checksum", async () => {
    const clean = zip([{ path: "conf.py", body: "DEBUG = False" }]);
    const tampered = zip([{ path: "conf.py", body: "DEBUG = False" }], (b) => {
      const i = new TextDecoder().decode(b).indexOf("DEBUG = False");
      b.set(new TextEncoder().encode("DEBUG = True_"), i);
    });
    expect((await unzip(clean))[0].content).toBe("DEBUG = False");
    await expect(unzip(tampered)).rejects.toThrow();
  });

  it("keeps every .env variant out of the browser store", async () => {
    const got = await unzip(
      zip([
        { path: "app/.env", body: "AWS_SECRET=x" },
        { path: "app/.env.production", body: "AWS_SECRET=x" },
        { path: "app/config.env", body: "AWS_SECRET=x" },
        { path: "app/credentials.csv", body: "AKIA,secret" },
        { path: "app/main.go", body: "package main" },
      ]),
    );
    expect(got.map((e) => e.path)).toEqual(["main.go"]);
  });

  it("refuses path traversal and skips non-text files", async () => {
    await expect(unzip(zip([{ path: "../escape.py", body: "x" }]))).rejects.toThrow(/unsafe/i);
    const got = await unzip(zip([{ path: "a.py", body: "x" }, { path: "logo.png", body: " " }]));
    expect(got.map((e) => e.path)).toEqual(["a.py"]);
  });
});

describe("browser intent routing (port of intent.prefilter)", () => {
  // The deployed path used to answer everything. Each of these reached BM25 and came back as
  // a confident paragraph about whatever five files happened to rank.
  it("refuses what cannot be located, and names which rule fired", () => {
    expect(prefilter("please fix it")).toBe("vague");
    expect(prefilter("it's broken")).toBe("vague");
    expect(prefilter("what can you do?")).toBe("meta");
    expect(prefilter("hi")).toBe("chitchat");
    // Long enough to clear the length gate, so it reaches the no-words rule — under 12
    // characters everything unrecognised is "vague", which is what Python does too.
    expect(prefilter("?????? !!!!!! ...... ######")).toBe("nonsense");
    expect(prefilter("!!!! ?? ...")).toBe("vague"); // 11 chars: the length gate fires first
  });

  it("lets a real question through untouched", () => {
    expect(prefilter("get_accounts returns stale results after a cache write")).toBeNull();
    expect(prefilter("How does the token cache decide what to evict?")).toBeNull();
    // A greeting that carries a real question is a question.
    expect(prefilter("hi, where does the router register middleware handlers?")).toBeNull();
  });

  // Meta is checked before the length gate on purpose: these are short AND about the
  // assistant, and the capabilities reply beats "say more".
  it("prefers meta over the length gate", () => {
    expect(prefilter("who are you")).toBe("meta");
  });
});
