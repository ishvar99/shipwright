import Link from "next/link";
import { EvidenceStrip } from "@/components/ui/evidence-strip";
import { Reveal } from "@/components/landing/reveal";
import { Replay } from "@/components/landing/replay";
import { AnalyticsSchema, parseOrThrow } from "@/lib/contracts";
import snapshot from "@/fixtures/analytics.json";

const CHANNELS = [
  {
    channels: ["bm25"] as const,
    name: "text",
    body: "BM25 over symbol names, signatures and bodies. Strong when the issue quotes an identifier, useless when it describes a behaviour.",
  },
  {
    channels: ["graph"] as const,
    name: "call graph",
    body: "Neighbours of the text hits, weighted by how many suspicious callers reach them. Finds the function nobody named.",
  },
  {
    channels: ["dense"] as const,
    name: "embedding",
    body: "Local embeddings over the same symbols. Catches paraphrase, and pays for it in precision.",
  },
  {
    channels: ["path"] as const,
    name: "path in issue",
    body: "File paths the issue text mentions outright. Rare, and near-decisive when present.",
  },
];

export default function Home() {
  const { runs } = parseOrThrow(AnalyticsSchema, snapshot, "fixtures/analytics.json");
  const best = runs.filter((r) => r.n >= 100).sort((a, b) => b.file5 - a.file5)[0];
  const floor = runs.filter((r) => r.model === "—").sort((a, b) => b.n - a.n)[0];

  return (
    <main className="mx-auto max-w-5xl px-6 pb-24">
      {/* Beat 1 — the claim, with both numbers attached to it. */}
      <section className="sw-glow py-24">
        <p className="font-mono text-[length:var(--text-ui)] text-subtle">Shipwright</p>
        <h1 className="mt-4 max-w-[24ch] text-display font-display text-fg">
          Finds where to change code, and shows you why.
        </h1>
        <p className="mt-6 max-w-[58ch] text-lg text-muted">
          Point it at a Python repository and an issue. It returns ranked locations with the
          evidence for each one — which retrieval channel found it, and where the reranker moved
          it from.
        </p>
        <dl className="mt-10 flex flex-wrap gap-x-12 gap-y-4">
          <div>
            <dt className="text-subtle">file@5</dt>
            <dd className="font-mono text-title tabular-nums text-fg">{best.file5.toFixed(1)}%</dd>
          </div>
          <div>
            <dt className="text-subtle">func@10</dt>
            <dd className="font-mono text-title tabular-nums text-fg">{best.func10.toFixed(1)}%</dd>
          </div>
          <div className="max-w-[40ch] self-end text-subtle">
            Strict Acc@k on {best.n} Loc-Bench issues — a task counts only when every
            ground-truth location is inside the top k. Retrieval alone gets{" "}
            {floor.file5.toFixed(1)}% at n={floor.n}.
          </div>
        </dl>
        <div className="mt-10 flex flex-wrap items-center gap-6">
          <Link href="/app" className="text-accent underline">
            Open the workspace →
          </Link>
          <Link href="/evals" className="text-muted underline">
            Every measurement
          </Link>
        </div>
      </section>

      {/* Beat 2 — a real run, not a screenshot. */}
      <Reveal className="py-12">
        <h2 className="text-title text-fg">One real run</h2>
        <p className="mt-2 max-w-[58ch] text-muted">
          The same components the workspace uses, driven by a recorded stream through the same
          reducer. Nothing here is a mock-up.
        </p>
        <div className="mt-6">
          <Replay />
        </div>
      </Reveal>

      {/* Beat 3 — the channels, taught through the primitive that displays them. */}
      <Reveal className="py-12">
        <h2 className="text-title text-fg">Four ways to find a function</h2>
        <p className="mt-2 max-w-[58ch] text-muted">
          Every result carries the channels that surfaced it, in fixed slots — so across ten rows
          the shape of the evidence is readable as a column, not a sentence.
        </p>
        <ul className="mt-6 grid gap-4 sm:grid-cols-2">
          {CHANNELS.map((c) => (
            <li key={c.name} className="rounded-[var(--radius)] border border-hairline p-4">
              <div className="flex items-center gap-3">
                <EvidenceStrip channels={[...c.channels]} />
                <span className="text-fg">{c.name}</span>
              </div>
              <p className="mt-2 text-subtle">{c.body}</p>
            </li>
          ))}
        </ul>
        <p className="mt-4 max-w-[58ch] text-subtle">
          Fused with reciprocal rank fusion, then reranked by a local 7B. An ablation at n=30 put
          all four channels ahead of any subset — and showed the reranker, not the candidate
          supply, is what limits the pipeline.
        </p>
      </Reveal>

      {/* Beat 4 — the limits, stated plainly. This is the differentiator, not a disclaimer. */}
      <Reveal className="py-12">
        <h2 className="text-title text-fg">What it does not do</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="rounded-[var(--radius)] border border-hairline p-4">
            <p className="text-fg">It does not fix bugs.</p>
            <p className="mt-2 text-subtle">
              Two SWE-bench-Live tasks were attempted end to end and neither produced a scored
              patch — 0/2, generation only, not yet run through the harness. The failure was
              characterised (context truncation and a repetition loop), not hidden.
            </p>
          </div>
          <div className="rounded-[var(--radius)] border border-hairline p-4">
            <p className="text-fg">It does not claim small wins.</p>
            <p className="mt-2 text-subtle">
              At n=30 one task is worth 3.3 points, so most differences between configurations
              are inside the noise. The evals page shades that range and marks anything inside it
              inconclusive.
            </p>
          </div>
          <div className="rounded-[var(--radius)] border border-hairline p-4">
            <p className="text-fg">It only reads Python.</p>
            <p className="mt-2 text-subtle">
              The code graph is a tree-sitter pass over Python files. Other languages parse to
              nothing, which shows up as a repository with zero symbols rather than bad results.
            </p>
          </div>
          <div className="rounded-[var(--radius)] border border-hairline p-4">
            <p className="text-fg">It runs on one laptop.</p>
            <p className="mt-2 text-subtle">
              A local 7B through Ollama, no hosted API, nothing to pay for. The deployed site has
              no backend, so the workspace here replays a recording and says so.
            </p>
          </div>
        </div>
      </Reveal>
    </main>
  );
}
