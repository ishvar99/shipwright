import { Band } from "@/components/ui/band";
import { Button } from "@/components/ui/button";
import { EvidenceStrip, type Channel } from "@/components/ui/evidence-strip";
import { Panel } from "@/components/ui/panel";
import { RankDelta } from "@/components/ui/rank-delta";
import { ScoreBar } from "@/components/ui/score-bar";
import { StatusDot } from "@/components/ui/status-dot";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { Trace, type TraceStage } from "@/components/ui/trace";

type Row = { sym: string; ch: Channel[]; r: number; f: number; s: number };

// Shapes mirror a real job on the msal repo so the gallery reflects production data.
const ROWS: Row[] = [
  { sym: "msal/authority.py:Authority", ch: ["bm25", "graph"], r: 3, f: 0, s: 0.0163 },
  { sym: "msal/application.py:ClientApplication", ch: ["bm25"], r: 1, f: 1, s: 0.0159 },
  { sym: "msal/oauth2cli/oidc.py:Client", ch: ["graph", "dense"], r: 8, f: 2, s: 0.0154 },
  {
    sym: "msal/token_cache.py:TokenCache.add",
    ch: ["bm25", "graph", "dense", "path"],
    r: -1,
    f: 3,
    s: 0.0151,
  },
];

const STAGES: TraceStage[] = [
  { key: "graph", label: "graph", state: "done", durationMs: 3600, detail: "463 symbols" },
  { key: "retrieval", label: "retrieval", state: "done", durationMs: 210, detail: "hybrid" },
  { key: "model", label: "model", state: "done", durationMs: 2400, detail: "2 calls · 1,740 tok" },
  { key: "results", label: "results", state: "active", detail: "10 locations" },
  { key: "done", label: "complete", state: "pending" },
];

const POINTS = [
  { id: "a", label: "hybrid4", deltaPp: 3.3 },
  { id: "b", label: "extract+rerank", deltaPp: 13.3 },
];

function Register({ dense }: { dense: boolean }) {
  const top = ROWS[0].s;
  return (
    <div className={dense ? "register-dense" : undefined}>
      <h2 className="mb-3 text-xs uppercase tracking-wide text-subtle">
        {dense ? "dense register (workspace)" : "expressive register (landing)"}
      </h2>
      <div className="grid gap-4">
        <Panel title="controls">
          <div className="flex flex-wrap items-center gap-3 p-3">
            <Button variant="primary">Run</Button>
            <Button>Cancel</Button>
            <Button disabled>Disabled</Button>
            <ThemeToggle />
          </div>
        </Panel>

        <Panel title="job status vs stream status">
          <div className="flex flex-wrap gap-4 p-3">
            <StatusDot tone="active" label="running" />
            <StatusDot tone="idle" label="quiet 14s" />
            <StatusDot tone="good" label="live" />
            <StatusDot tone="warn" label="reconnecting (2)" />
            <StatusDot tone="bad" label="failed" />
          </div>
        </Panel>

        <Panel title="trace">
          <div className="p-3">
            <Trace stages={STAGES} />
          </div>
        </Panel>

        <Panel title="results">
          <ul className="divide-y divide-hairline">
            {ROWS.map((r) => {
              const [path, symbol] = r.sym.split(":");
              return (
                <li key={r.sym} className="flex items-center gap-3 px-3 py-2">
                  <RankDelta retrievalIndex={r.r} finalIndex={r.f} />
                  <EvidenceStrip channels={r.ch} />
                  <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--text-ui)]">
                    <span className="text-subtle">{path}:</span>
                    <span className="text-fg">{symbol}</span>
                  </span>
                  <ScoreBar score={r.s} top={top} />
                </li>
              );
            })}
          </ul>
        </Panel>

        <Panel title="noise band">
          <div className="space-y-4 p-3">
            <Band n={30} points={POINTS} />
            <Band n={353} points={POINTS} />
          </div>
        </Panel>
      </div>
    </div>
  );
}

export default function KitchenSink() {
  return (
    <main className="mx-auto grid max-w-6xl gap-10 px-6 py-12 lg:grid-cols-2">
      <Register dense={false} />
      <Register dense={true} />
    </main>
  );
}
