/**
 * Benchmarks the pipeline that actually deploys.
 *
 * Every number on /evals until now came from the backend retriever. The browser pipeline —
 * BM25 over regex-extracted symbols, no call graph, no embeddings — is what runs on Vercel
 * and what most visitors will ever see, and it was measured nowhere.
 *
 * Two rules make the result honest rather than flattering:
 *  - it imports the REAL `indexRepo`/`locateLocal`, never a re-implementation, so a change to
 *    the product changes the score;
 *  - it feeds them only files the browser importer would have admitted (extension allowlist,
 *    no dotfiles, per-file size cap), because scoring a superset the product cannot see would
 *    measure a pipeline that does not exist.
 *
 * Scoring copies evals/locbench.py exactly, including its strictness: a hit needs EVERY
 * ground-truth location inside the top k, not one of them.
 *
 * Usage: npx vite-node scripts/eval-local.ts -- --limit 100 --seed 7 [--write]
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { indexRepo } from "@/lib/local/index-repo";
import { locateLocal } from "@/lib/local/run";
import { isTextFile } from "@/lib/local/unzip";
import { MAX_FILE_CHARS } from "@/lib/local/languages";

const ROOT = resolve(import.meta.dirname, "../..");
const DATA = join(ROOT, "evals/locbench/data/test.jsonl");
const REPOS = join(ROOT, "evals/locbench/repos");
const SNAPSHOT = join(ROOT, "web/fixtures/analytics.json");

/** The product's own limits: 10 ranked results, 5 files considered. */
const TOP_K = 10;

type Task = {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  edit_functions: string[];
};

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}
const has = (name: string) => process.argv.includes(`--${name}`);

/** Mulberry32: a seeded shuffle, so a sample is reproducible without a dependency. */
function shuffled<T>(items: T[], seed: number): T[] {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function tasks(): { chosen: Task[]; total: number; available: number } {
  const all = readFileSync(DATA, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Task)
    // Same filter as the Python harness: a task with no ground truth cannot be scored.
    .filter((t) => t.edit_functions?.length);
  // Only repositories already on disk. Cloning the rest would be the honest alternative, but
  // the cloned set IS the population the backend runs were scored on, so sampling from it
  // compares like with like — and a run that silently skipped a third of its sample was
  // reporting an average over an unstated subset.
  const available = all.filter((t) =>
    existsSync(join(REPOS, t.repo.replace("/", "__"), ".git")),
  );
  available.sort((a, b) => a.instance_id.localeCompare(b.instance_id));
  const seed = Number(arg("seed", "0"));
  // Alphabetical order is a prefix, not a sample — `--seed` makes a limited run representative.
  const ordered = seed ? shuffled(available, seed) : available;
  const limit = Number(arg("limit", "0"));
  return {
    chosen: limit ? ordered.slice(0, limit) : ordered,
    total: all.length,
    available: available.length,
  };
}

/** Exactly what the browser would hold after an import: the same admission rules, and the
 * same walk order is irrelevant because ranking is by score, not by discovery. */
function readRepo(dir: string): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = [];
  const walk = (abs: string) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      // `.git` and every other dotfile: the browser importer excludes them by the same rule.
      if (entry.name.startsWith(".")) continue;
      // A zip carries no symlinks into the tree, so following one here would index files the
      // product never sees — and a dangling one (openlibrary has some) throws on stat.
      if (entry.isSymbolicLink()) continue;
      const full = join(abs, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const rel = relative(dir, full);
      if (!isTextFile(rel)) continue;
      try {
        // The zip path refuses a file over 50MB outright; the indexer then yields nothing
        // above MAX_FILE_CHARS. Reading a 200MB file just to discard it wastes the run.
        if (statSync(full).size > MAX_FILE_CHARS * 4) continue;
        out.push({ path: rel, content: readFileSync(full, "utf8") });
      } catch {
        // Vanished mid-walk or undecodable bytes: the importer drops these too.
      }
    }
  };
  walk(dir);
  return out;
}

/** Strict, like `_acc_at_k`: every ground-truth location must appear in the top k. */
const accAtK = (predicted: string[], truth: Set<string>, k: number): boolean =>
  truth.size > 0 && [...truth].every((t) => predicted.slice(0, k).includes(t));

function checkout(task: Task): string | null {
  const dir = join(REPOS, task.repo.replace("/", "__"));
  if (!existsSync(join(dir, ".git"))) return null;
  try {
    execFileSync("git", ["checkout", "--force", task.base_commit], {
      cwd: dir,
      stdio: "ignore",
      timeout: 120_000,
    });
    return dir;
  } catch {
    return null; // commit not fetched locally; counted as skipped, never as a miss
  }
}

function main() {
  const { chosen, total, available } = tasks();
  let scored = 0;
  let file5 = 0;
  let func10 = 0;
  let anyHit = 0;
  const skipped: Record<string, number> = {};
  const started = Date.now();

  for (const [i, task] of chosen.entries()) {
    const dir = checkout(task);
    if (!dir) {
      skipped.checkout_failed = (skipped.checkout_failed ?? 0) + 1;
      console.log(`[${i + 1}/${chosen.length}] ${task.instance_id} SKIP checkout`);
      continue;
    }
    let files: { path: string; content: string }[];
    let symbols: ReturnType<typeof indexRepo>;
    let ranked: ReturnType<typeof locateLocal>;
    try {
      files = readRepo(dir);
      symbols = indexRepo(files);
      ranked = locateLocal(symbols, task.problem_statement).slice(0, TOP_K);
    } catch (e) {
      // One unreadable repository must not end a 353-task run — count it and say so, so the
      // reported n is never quietly smaller than the sample.
      skipped.read_failed = (skipped.read_failed ?? 0) + 1;
      console.log(`[${i + 1}/${chosen.length}] ${task.instance_id} SKIP read (${String(e).slice(0, 60)})`);
      continue;
    }
    const predFuncs = ranked.map((s) => s.id);
    const predFiles = [...new Set(predFuncs.map((p) => p.split(":", 1)[0]))];
    const truthFuncs = new Set(task.edit_functions);
    const truthFiles = new Set(task.edit_functions.map((f) => f.split(":", 1)[0]));

    const f5 = accAtK(predFiles, truthFiles, 5);
    const f10 = accAtK(predFuncs, truthFuncs, 10);
    scored += 1;
    if (f5) file5 += 1;
    if (f10) func10 += 1;
    if (predFuncs.some((p) => truthFuncs.has(p))) anyHit += 1;
    console.log(
      `[${i + 1}/${chosen.length}] ${task.instance_id} file@5=${f5 ? "1" : "0"} ` +
        `func@10=${f10 ? "1" : "0"} (${files.length} files, ${symbols.length} symbols)`,
    );
  }

  const pct = (n: number) => (scored ? Number(((n / scored) * 100).toFixed(1)) : 0);
  const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT })
    .toString()
    .trim();
  const row = {
    run: `browser-${commit}`,
    scaffold: "browser_bm25",
    model: "—",
    n: scored,
    file5: pct(file5),
    func10: pct(func10),
    parse_failures: 0,
    commit,
    date: new Date().toISOString().slice(0, 10),
  };

  console.log(
    "\n" +
      JSON.stringify(
        {
          ...row,
          any_hit: pct(anyHit),
          skipped,
          population: { locbench_total: total, repos_on_disk: available, sampled: chosen.length },
        },
        null,
        1,
      ),
  );
  console.log(`${Math.round((Date.now() - started) / 1000)}s`);

  if (has("write")) {
    const snap = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as {
      runs: Record<string, unknown>[];
    };
    // One row per scaffold: a re-run replaces its own result rather than stacking history.
    snap.runs = [row, ...snap.runs.filter((r) => r.scaffold !== "browser_bm25")];
    writeFileSync(SNAPSHOT, `${JSON.stringify(snap, null, 1)}\n`);
    console.log(`wrote ${relative(ROOT, SNAPSHOT)}`);
  }
}

main();
