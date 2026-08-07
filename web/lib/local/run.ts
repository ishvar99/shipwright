import type { Job, Location } from "@/lib/contracts";
import { bm25Rank, rrf, tokenize } from "@/lib/local/bm25";
import type { LocalSymbol } from "@/lib/local/index-repo";
import { getLocalJob, getLocalRepo, newLocalId, saveLocalJob } from "@/lib/local/store";
import { capHistory, retrievalQuery } from "@/lib/turns";
import type { Frame } from "@/lib/stream/frames";
import type { JobStream } from "@/lib/stream/transport";

/**
 * A session run entirely in the browser.
 *
 * It implements `JobStream` — the same three-method interface the network and replay sources
 * implement — so `session-view`, the reducer and the results list need no offline branch. The
 * event names below are the ones the reducer already knows; this is a third source of the
 * same protocol, not a parallel one.
 *
 * The pipeline mirrors the backend's: retrieve deterministically, let the model rerank and
 * answer. What is missing is the call-graph channel (no tree-sitter here) and verification
 * (no git, no pytest) — both stated in the UI rather than papered over.
 */

const TOP_K = 10;
const RERANK_POOL = 30;
/** Matches the backend's corpus shape: path, name weighted ×3, parent, and the body head. */
const BODY_HEAD = 4000;

function corpus(symbols: LocalSymbol[]) {
  return symbols.map((s) => ({
    id: s.id,
    text: `${s.path} ${s.name} ${s.name} ${s.name} ${s.parent} ${s.text.slice(0, BODY_HEAD)}`,
  }));
}

/** Tests match a bug report's words as well as the implementation does — they describe the same
 * behaviour. The backend is rescued by its call graph, which pulls the implementation in via
 * call edges; without that channel, BM25 alone put five test methods above the function the
 * question was about. Demoting tests is the honest compensation, and it is skipped when the
 * question is itself about tests. Conventions across languages: tests/, __tests__/, spec/,
 * test_*.py, *_test.go, *.test.ts, *.spec.js, conftest. */
const TEST_FILE =
  /(^|\/)(tests?|__tests__|spec)\/|(^|\/)test_[^/]*$|_test\.\w+$|\.(test|spec)\.\w+$|conftest\.py$/;

function demoteTests(ids: string[], byId: Map<string, LocalSymbol>, issue: string): string[] {
  if (/\btests?\b|\bspecs?\b|pytest|conftest/i.test(issue)) return ids;
  const impl = ids.filter((id) => !TEST_FILE.test(byId.get(id)?.path ?? ""));
  const tests = ids.filter((id) => TEST_FILE.test(byId.get(id)?.path ?? ""));
  return [...impl, ...tests];
}

/** Changelogs and READMEs narrate the same behaviour the code implements, in the same words,
 * and a long History.md yields dozens of sections that can bury the implementation. Demoted
 * to the end — unless the question is about the docs themselves. */
const DOC_FILE = /\.(md|mdx|rst|txt|adoc)$/i;

function demoteDocs(ids: string[], byId: Map<string, LocalSymbol>, issue: string): string[] {
  // Asking about the docs by topic or by filename both count — naming CHANGES.md and then
  // burying it would defeat the path channel that just promoted it.
  if (/\b(readme|docs?|documentation|changelog|history|guide|tutorial)\b/i.test(issue)) return ids;
  if (/\.(md|mdx|rst|txt|adoc)\b/i.test(issue)) return ids;
  const code = ids.filter((id) => !DOC_FILE.test(byId.get(id)?.path ?? ""));
  const docs = ids.filter((id) => DOC_FILE.test(byId.get(id)?.path ?? ""));
  return [...code, ...docs];
}

/** The backend's `path` channel: a filename in the question promotes everything in that file.
 * Any extension counts — "the bug is in router.ts" names a file as surely as a .py ever did.
 * The trailing word-boundary keeps "requests.Session" from reading as a file called
 * "requests.Se…"; a version number like "2.0" still slips through and simply matches nothing. */
function pathChannel(symbols: LocalSymbol[], issue: string): string[] {
  const named = issue.match(/[\w/\\.-]+\.[A-Za-z][A-Za-z0-9]{0,7}(?![\w.])/g);
  if (!named?.length) return [];
  const want = new Set(named.map((p) => p.replace(/\\/g, "/")));
  return symbols.filter((s) => [...want].some((w) => s.path.endsWith(w))).map((s) => s.id);
}

export function locateLocal(symbols: LocalSymbol[], issue: string): LocalSymbol[] {
  if (!symbols.length || !tokenize(issue).length) return [];
  const byId = new Map(symbols.map((s) => [s.id, s]));
  const rankings = [bm25Rank(corpus(symbols), issue, 100)];
  const paths = pathChannel(symbols, issue);
  if (paths.length) rankings.push(paths);
  // Tests first, then docs, both stable: implementation, then tests, then prose.
  return demoteDocs(demoteTests(rrf(rankings), byId, issue), byId, issue)
    .slice(0, RERANK_POOL)
    .map((id) => byId.get(id))
    .filter((s): s is LocalSymbol => Boolean(s));
}

function toLocation(s: LocalSymbol, rank: number, score: number): Location {
  return {
    rank,
    symbol: s.id,
    path: s.path,
    name: s.name,
    kind: s.kind,
    signature: s.text.split("\n", 1)[0].trim(),
    start_line: s.start_line,
    end_line: s.end_line,
    score,
    // "bm25" is the truth: there is no call graph and no embeddings in the browser, so the
    // evidence strip must not imply channels that never ran.
    channels: ["bm25"],
  };
}

/** One event, in the exact wire shape the reducer validates. `seq` is not decoration: the
 * envelope schema requires it, and frames without it were quarantined wholesale — the feed
 * stayed empty, and the "silent" stream was retried with a fresh model call each time. */
export const localFrame = (seq: number, type: string, payload: Record<string, unknown> = {}): Frame => {
  const data = JSON.stringify({ type, seq, ...payload });
  return { raw: `data: ${data}`, data, comment: false };
};

/**
 * Runs the pipeline and dispatches frames as each stage completes. Deterministic stages land
 * immediately; only the model call takes real time, which is the honest shape of the work.
 *
 * `issue` is THIS turn's question. Prior turns are read from the stored row, so a follow-up
 * re-runs the whole pipeline — fresh retrieval, fresh evidence — and the model additionally
 * receives the conversation so far.
 */
export function localEvents(
  jobId: string,
  repoId: string,
  issue: string,
  now: () => number,
): JobStream {
  let stopped = false;

  return {
    // Not "replay": nothing was recorded. The UI reads this as a live run, which it is.
    origin: { mode: "network" },
    stop() {
      stopped = true;
    },
    run(_from, dispatch) {
      let seq = 0;
      const frame = (type: string, payload: Record<string, unknown> = {}): Frame =>
        localFrame((seq += 1), type, payload);
      const emit = (f: Frame) => {
        if (!stopped) dispatch({ kind: "frame", frame: f, at: now() });
      };

      void (async () => {
        dispatch({ kind: "open", historyOnly: false, at: now() });
        const started = now();
        try {
          const repo = await getLocalRepo(repoId);
          if (!repo) throw new Error("That repository is no longer stored in this browser.");
          const row = await getLocalJob(jobId);
          // Prior turns; a completed pre-feature row becomes turn one retroactively.
          const prior =
            row?.result.turns?.length
              ? row.result.turns
              : row?.result.answer
                ? [{ issue: row.issue, answer: row.result.answer, locations: row.result.locations }]
                : [];
          if (stopped) return;

          // Reopening a finished conversation is a read, not a run: everything below would
          // re-search and re-spend a model call to recompute what the row already holds —
          // and with turns, append the re-answer as a duplicate. Narrate the stored facts
          // and hand the row over.
          if (row && row.status === "done" && prior.length && issue === row.issue) {
            const repoStats = { files: repo.files, symbols: repo.symbols_index.length };
            emit(frame("job.started", { repo: repo.slug, mode: "local", base: "bm25" }));
            emit(frame("intent.ready", { intent: "question" }));
            emit(frame("graph.building"));
            emit(frame("graph.ready", { ...repoStats, call_edges: 0, import_edges: 0 }));
            emit(frame("search.started", { channels: "bm25" }));
            emit(frame("candidates.found", { count: row.result.locations.length }));
            emit(frame("localization.ready", { count: row.result.locations.length }));
            emit(frame("job.done", { wall_ms: row.wall_ms, locations: row.result.locations.length }));
            dispatch({ kind: "job", job: row });
            dispatch({ kind: "ended", at: now() });
            return;
          }

          emit(frame("job.started", { repo: repo.slug, mode: "local", base: "bm25" }));
          // Declared up front — the local pipeline always answers. Without this the reducer
          // never learns the intent mid-run, so the answer card (and its "Reading the
          // code…" beat) could not mount until the whole run had finished.
          emit(frame("intent.ready", { intent: "question" }));
          emit(frame("graph.building"));
          const symbols = repo.symbols_index;
          emit(
            frame("graph.ready", {
              files: repo.files,
              symbols: symbols.length,
              call_edges: 0,
              import_edges: 0,
            }),
          );

          // Payloads the schema requires, truthfully: BM25 is the only channel here.
          emit(frame("search.started", { channels: "bm25" }));
          // The previous question rides along: a follow-up's pronouns have no BM25 tokens.
          let pool = locateLocal(symbols, retrievalQuery(issue, prior.at(-1)?.issue));
          // Some follow-ups are about the conversation, not the codebase — "which of these
          // would you change first?" tokenises to nothing searchable. Carrying the previous
          // turn's evidence beats failing the thread: the question is about what was already
          // found, and the answer must still be grounded in real code.
          if (!pool.length && prior.length) {
            const byId = new Map(symbols.map((s) => [s.id, s]));
            pool = (prior[prior.length - 1].locations ?? [])
              .map((l) => byId.get(l.symbol))
              .filter((s): s is LocalSymbol => Boolean(s));
          }
          emit(frame("candidates.found", { count: pool.length }));
          if (!pool.length) {
            emit(frame("job.failed", { error: "Nothing in this repository matched that." }));
            dispatch({ kind: "ended", at: now() });
            return;
          }

          emit(frame("rank.started", { pool: pool.length }));
          const locations = pool
            .slice(0, TOP_K)
            .map((s, i) => toLocation(s, i + 1, 1 / (1 + i)));
          emit(frame("localization.ready", { count: locations.length }));

          // The model sees only the ranked heads — a free tier meters tokens, and the whole
          // point of retrieving first is not to ship the repository.
          emit(frame("answer.started"));
          const context = pool.slice(0, 5).map((s) => ({
            path: `${s.path}:${s.start_line}`,
            content: s.text.slice(0, 6000),
          }));
          const res = await fetch("/api/lite/ask", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              issue,
              context,
              history: capHistory(prior.map((t) => ({ q: t.issue, a: t.answer }))),
            }),
          });
          if (!res.ok || !res.body) {
            const d = (await res.json().catch(() => null)) as { detail?: string } | null;
            throw new Error(d?.detail ?? "The answering service is not reachable.");
          }

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let answer = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done || stopped) break;
            const delta = decoder.decode(value, { stream: true });
            answer += delta;
            emit(frame("answer.delta", { text: delta }));
          }
          emit(frame("answer.ready"));

          const wall = Math.round(now() - started);
          const turns = [...prior, { issue, answer, locations }];
          const job: Job = {
            id: jobId,
            repo_id: repoId,
            repo_slug: repo.slug,
            kind: "localize",
            status: "done",
            mode: "local",
            base_mode: "bm25",
            client: "web",
            model: "",
            // The FIRST question stays the session's name; this turn's lives in its entry.
            issue: row?.issue ?? issue,
            result: {
              // Latest turn mirrored at the top level, so single-turn consumers never change.
              locations,
              graph: { files: repo.files, symbols: symbols.length },
              fix: null,
              intent: "question",
              reason: "",
              answer,
              turns,
            },
            error: "",
            input_tokens: 0,
            output_tokens: 0,
            wall_ms: wall,
            created_at: row?.created_at ?? new Date().toISOString(),
          };
          await saveLocalJob(job);
          emit(frame("job.done", { wall_ms: wall, locations: locations.length }));
          dispatch({ kind: "job", job });
          dispatch({ kind: "ended", at: now() });
        } catch (e) {
          emit(frame("job.failed", { error: e instanceof Error ? e.message : "Local run failed." }));
          dispatch({ kind: "ended", at: now() });
        }
      })();
    },
  };
}

/** Creates the row a local session is about to fill, so the sidebar can show it immediately. */
export function newLocalJob(repoId: string, repoSlug: string, issue: string): Job {
  return {
    id: newLocalId(),
    repo_id: repoId,
    repo_slug: repoSlug,
    kind: "localize",
    status: "running",
    mode: "local",
    base_mode: "bm25",
    client: "web",
    model: "",
    issue,
    result: { locations: [], graph: {}, fix: null, intent: null, reason: "", answer: "", turns: [] },
    error: "",
    input_tokens: 0,
    output_tokens: 0,
    wall_ms: 0,
    created_at: new Date().toISOString(),
  };
}
