// Records a real run into a fixture bundle. Plain ESM so no TypeScript runner enters the tree
// for a dev-only tool.
//
//   npm run capture -- --path /abs/repo --issue ./issue.txt --out fixtures/name.json
//   npm run capture -- --url https://github.com/owner/name --issue ./issue.txt
//
// A fixture is a BUNDLE, not an event log: `localization.ready` carries only a count, so the
// ranked locations live in the Job record. Frames-only would replay a perfect trace into an
// empty results panel.

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const BASE = process.env.BACKEND_URL ?? "http://localhost:8000";
// Every returned location: on the deployed site the fixture IS the product, so a row
// whose source was not captured is a dead end for the one visitor who explores.
const SOURCES_TO_CAPTURE = 10;
// The pane answers "is this the right function?", not "read me this class", so a bounded window
// is enough. Uncapped, a 240-line class body pushed the bundle past 100 KB — and the landing
// hero imports this same file statically.
const SOURCE_WINDOW_LINES = 40;

const args = parseArgs(process.argv.slice(2));
if (!args.issue || (!args.path && !args.url)) {
  console.error("usage: --issue <file> (--path <dir> | --url <github url>) [--out <file>]");
  process.exit(1);
}

const issue = readFileSync(args.issue, "utf8").trim();
const out = args.out ?? "fixtures/capture.json";

const repo = await importRepo();
console.log(`repo ${repo.slug} (${repo.status}, ${repo.symbols} symbols)`);

const job = await post("/api/jobs", {
  repo_id: repo.id,
  issue,
  mode: args.mode ?? "extract_rerank",
  base_mode: args.base ?? "hybrid",
});
console.log(`job ${job.id}`);

const frames = await recordStream(job.id);
console.log(`recorded ${frames.length} event frames`);

const finished = await get(`/api/jobs/${job.id}`);
if (finished.status !== "done") {
  console.error(`job ended ${finished.status}: ${finished.error}`);
  process.exit(1);
}

const sources = {};
for (const loc of finished.result.locations.slice(0, SOURCES_TO_CAPTURE)) {
  const end = Math.min(loc.end_line || loc.start_line, loc.start_line + SOURCE_WINDOW_LINES);
  const q = new URLSearchParams({ path: loc.path, start: loc.start_line, end });
  sources[`${loc.path}:${loc.start_line}`] = await get(`/api/jobs/${job.id}/source?${q}`);
}

const bundle = {
  meta: {
    fixtureVersion: 1,
    capturedAt: new Date().toISOString(),
    repo: repo.slug,
    ref: repo.ref,
    mode: finished.mode,
    baseMode: finished.base_mode,
    model: finished.model,
    wallMs: finished.wall_ms,
    backendCommit: gitCommit(),
    // Pacing comes from server timestamps, so it is independent of capture-time jitter.
    timingSource: "server-ts",
    // Heartbeats are liveness only and carry no information; the replay's own timer provides
    // pacing. Excluded to keep the committed JSON readable.
    heartbeatsExcluded: true,
  },
  issue,
  frames,
  job: finished,
  sources,
};

assertClean(bundle);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(bundle, null, 1) + "\n");
console.log(`wrote ${out} (${(JSON.stringify(bundle).length / 1024).toFixed(1)} KB)`);

/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 2) o[argv[i].replace(/^--/, "")] = argv[i + 1];
  return o;
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

async function importRepo() {
  const created = await post("/api/repos/import", args.url ? { url: args.url } : { path: args.path });
  for (let i = 0; i < 600; i += 1) {
    const all = await get("/api/repos");
    const found = all.find((r) => r.id === created.id);
    if (found?.status === "ready") return found;
    if (found?.status === "failed") throw new Error(`import failed: ${found.error}`);
    await sleep(1000);
  }
  throw new Error("import did not become ready");
}

/** Records raw SSE frame text, with `t` as a millisecond offset derived from the server clock. */
async function recordStream(jobId) {
  const res = await fetch(`${BASE}/api/jobs/${jobId}/events`, {
    headers: { accept: "text/event-stream" },
  });
  if (!res.ok) throw new Error(`stream -> ${res.status}`);

  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  const recorded = [];
  let buffer = "";
  let firstTs = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const raw of parts) {
      if (!raw.trim() || raw.trimStart().startsWith(":")) continue; // heartbeat
      const data = raw.match(/^data: (.*)$/m)?.[1];
      const ts = data ? Date.parse(JSON.parse(data).ts) : NaN;
      if (firstTs === null && !Number.isNaN(ts)) firstTs = ts;
      recorded.push({ t: Number.isNaN(ts) ? 0 : ts - firstTs, raw });
      process.stdout.write(`  ${raw.match(/^event: (\S+)$/m)?.[1]}\n`);
    }
  }
  return recorded;
}

function gitCommit() {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: "..", encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/** Tripwire, not the fix: structured leaks are removed at the backend. If this ever fires, a
 * new leak was introduced upstream. */
function assertClean(bundle) {
  const text = JSON.stringify(bundle);
  const leaks = [/\/Users\//, /\/home\/[a-z]/, /\/\/[^/\s:@]+:[^/\s@]+@/];
  for (const re of leaks) {
    const hit = text.match(re);
    if (hit) throw new Error(`refusing to write: fixture contains ${hit[0]}`);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
