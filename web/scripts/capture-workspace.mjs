// Records a repo's file tree plus the bodies the demo needs into a workspace fixture.
//
//   npm run capture:workspace -- --repo <repo-id> --run fixtures/msal-extract-rerank.json
//
// Coverage is defined by the data, not a guess: every file the recorded run points at must be
// present, or the hosted demo has a result whose "Open in editor" leads nowhere.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const BASE = process.env.BACKEND_URL ?? "http://localhost:8000";
const EXTRAS = ["README.md", "setup.py", "pyproject.toml"];

const args = parseArgs(process.argv.slice(2));
if (!args.repo || !args.run) {
  console.error("usage: --repo <repo-id> --run <run fixture> [--out <file>]");
  process.exit(1);
}
const out = args.out ?? "fixtures/msal-workspace.json";
const run = JSON.parse(readFileSync(args.run, "utf8"));

const tree = await get(`/api/repos/${args.repo}/tree`);
console.log(`tree: ${tree.entries.length} files on ${tree.branch}`);

// Every file the run references, so no ranked row is a dead end.
const required = new Set(
  (run.job.result.locations ?? []).map((l) => l.path).concat(run.job.result.fix?.target?.path ?? []),
);
const present = new Set(tree.entries.map((e) => e.path));
const wanted = [...required, ...EXTRAS.filter((p) => present.has(p))];

const files = {};
for (const path of wanted) {
  if (!present.has(path)) {
    if (required.has(path)) throw new Error(`refusing to write: ${path} is in the run but not the tree`);
    continue;
  }
  const file = await get(`/api/repos/${args.repo}/file?path=${encodeURIComponent(path)}`);
  if (file.reason) continue;
  files[path] = { content: file.content, sha: file.sha };
}
for (const path of required) {
  if (!files[path]) throw new Error(`refusing to write: no body captured for ${path}`);
}

// The two fixtures must describe the same snapshot, or a deep link scrolls to the wrong line.
// Comparing shas would be wrong: `git init` on an identical tree yields a different commit
// every time it is materialised. Compare the content the recording actually asserts.
for (const [key, window] of Object.entries(run.sources ?? {})) {
  const path = key.slice(0, key.lastIndexOf(":"));
  const body = files[path];
  if (!body) continue;
  const lines = body.content.split("\n");
  const drifted = window.lines.some((line, i) => lines[window.start - 1 + i] !== line);
  if (drifted) {
    throw new Error(
      `refusing to write: ${path} has drifted from the recording at line ${window.start} — ` +
        `recapture the run fixture against this workspace`,
    );
  }
}

const bundle = {
  meta: { repo: run.meta.repo, ref: tree.head, branch: tree.branch, capturedAt: new Date().toISOString() },
  entries: tree.entries,
  truncated: tree.truncated,
  files,
};
assertClean(bundle);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(bundle, null, 2)}\n`);
console.log(`wrote ${out} — ${tree.entries.length} entries, ${Object.keys(files).length} bodies`);

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 2) o[argv[i].replace(/^--/, "")] = argv[i + 1];
  return o;
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

/** Same tripwire as the run capture: an absolute host path or an engine name must never ship. */
function assertClean(bundle) {
  const text = JSON.stringify(bundle);
  const leaks = [/\/Users\//, /\/home\/[a-z]/, /\/\/[^/\s:@]+:[^/\s@]+@/, /qwen|ollama|coder-\d+b/i];
  for (const re of leaks) {
    const hit = text.match(re);
    if (hit) throw new Error(`refusing to write: fixture contains ${hit[0]}`);
  }
}
