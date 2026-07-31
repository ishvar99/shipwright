// Snapshots the benchmark table so /evals renders statically.
//
//   npm run capture:evals
//
// The numbers are historical and do not change between deploys, and the live route uses
// cache: "no-store" — which marks the page dynamic and would 500 on a deployment with no
// backend, on the one surface whose whole purpose is not overstating things.

import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";

const BASE = process.env.BACKEND_URL ?? "http://localhost:8000";
const OUT = process.argv[2] ?? "fixtures/analytics.json";

const res = await fetch(`${BASE}/api/analytics/summary`);
if (!res.ok) throw new Error(`GET /api/analytics/summary -> ${res.status}`);
const summary = await res.json();

let commit = "unknown";
try {
  commit = execSync("git rev-parse --short HEAD", { cwd: "..", encoding: "utf8" }).trim();
} catch {
  // not a git checkout
}

const bundle = {
  meta: { capturedAt: new Date().toISOString(), snapshotCommit: commit },
  ...summary,
};

mkdirSync("fixtures", { recursive: true });
writeFileSync(OUT, JSON.stringify(bundle, null, 1) + "\n");
console.log(`wrote ${OUT} — ${summary.runs.length} runs, noise floor ${summary.noise_floor_pp}pp`);
