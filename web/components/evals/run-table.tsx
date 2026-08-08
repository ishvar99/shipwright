"use client";

import { useState } from "react";
import { Band, type BandPoint } from "@/components/ui/band";
import type { AnalyticsRun } from "@/lib/contracts";
import { cn } from "@/lib/cn";
import { bandPp, isWithinBand, pairwiseN } from "@/lib/evals/band";

type Metric = "file5" | "func10";

/** Scaffold ids are lab notation; the table speaks product. The raw id stays in a title
 * attribute so a technical reader can still pin the exact configuration. */
function prettyScaffold(id: string): string {
  const pool = id.match(/_p(\d+)$/)?.[1];
  const base = id.replace(/_p\d+$/, "");
  const names: Record<string, string> = {
    hybrid: "Retrieval · text + graph",
    hybrid3: "Retrieval · 3 signals",
    hybrid4: "Retrieval · 4 signals",
    hybrid_path: "Retrieval · text + graph + paths",
    bm25: "Retrieval · text only",
    // The browser engine: what the hosted app runs, with no graph and no embeddings. Named
    // for where it runs, because that is the comparison a reader is actually making.
    browser_bm25: "Browser · text only (no backend)",
    graph: "Retrieval · graph only",
    dense: "Retrieval · similarity only",
    path: "Retrieval · paths only",
    extract: "Extract terms",
    rerank: "Rerank",
    extract_rerank: "Extract + rerank",
    extract_rerank_hybrid: "Extract + rerank",
    extract_rerank_hybrid4: "Extract + rerank · 4 signals",
    s2_minimal: "End-to-end attempt",
  };
  const label = names[base] ?? base.replaceAll("_", " ");
  return pool ? `${label} · top ${pool}` : label;
}
const METRIC_LABEL: Record<Metric, string> = { file5: "file@5", func10: "func@10" };

/** Below this a run cannot separate anything a reader would call a difference: one task moves
 * the number by more than three points. */
const UNDERPOWERED_N = 30;

export function RunTable({ runs }: { runs: AnalyticsRun[] }) {
  const [metric, setMetric] = useState<Metric>("file5");
  // Default reference is the largest sample — the run best able to resolve a difference.
  const [referenceId, setReferenceId] = useState(
    () => [...runs].sort((a, b) => b.n - a.n)[0]?.run ?? "",
  );

  const reference = runs.find((r) => r.run === referenceId) ?? runs[0];
  const others = runs.filter((r) => r.run !== reference?.run);

  // Degenerate case: with one run there is nothing to compare, so no band is drawn. An empty
  // band around a single point would imply a comparison that does not exist.
  const comparable = Boolean(reference) && others.length > 0;

  const points: BandPoint[] = comparable
    ? others.map((r) => ({
        id: r.run,
        label: `${prettyScaffold(r.scaffold)} · ${r.model}`,
        deltaPp: Number((r[metric] - reference[metric]).toFixed(1)),
        n: pairwiseN(r.n, reference.n),
      }))
    : [];
  // Shading is the REFERENCE's own resolution, not the coarsest pair on screen: one 3-task
  // smoke run would otherwise set the band to ±66.7pp and swamp every real comparison. Points
  // are still judged pairwise, so a point from a coarser run can be hollow outside the shading —
  // which is the honest reading, and the legend says so.
  const scalePp = comparable
    ? Math.max(10, Math.ceil(Math.max(...points.map((p) => Math.abs(p.deltaPp))) / 5) * 5)
    : 10;

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center gap-4">
        <span role="group" aria-label="Metric" className="flex items-center gap-3">
          {(["file5", "func10"] as const).map((m) => (
            <label key={m} className="flex items-center gap-1">
              <input
                type="radio"
                name="metric"
                checked={metric === m}
                onChange={() => setMetric(m)}
              />
              <span>{METRIC_LABEL[m]}</span>
            </label>
          ))}
        </span>
        <span className="text-subtle">
          {comparable
            ? `compared against ${prettyScaffold(reference.scaffold)} (n=${reference.n})`
            : "one run — nothing to compare against"}
        </span>
      </div>

      {comparable ? (
        <Band points={points} n={reference.n} scalePp={scalePp} />
      ) : (
        <p className="text-subtle">
          A single run has no comparison. {reference?.[metric]}% {METRIC_LABEL[metric]} at n=
          {reference?.n}, unresolvable below ±{bandPp(reference?.n ?? 0).toFixed(1)}pp.
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left">
          <caption className="sr-only">
            Benchmark runs. Select a row to use it as the comparison reference.
          </caption>
          <thead>
            <tr className="border-b border-hairline text-subtle">
              <th scope="col" className="py-2 pr-3 font-normal">reference</th>
              <th scope="col" className="py-2 pr-3 font-normal">scaffold</th>
              <th scope="col" className="py-2 pr-3 font-normal">model</th>
              <th scope="col" className="py-2 pr-3 text-right font-normal">n</th>
              <th scope="col" className="py-2 pr-3 text-right font-normal">file@5</th>
              <th scope="col" className="py-2 pr-3 text-right font-normal">func@10</th>
              <th scope="col" className="py-2 pr-3 text-right font-normal">parse fails</th>
              <th scope="col" className="py-2 pr-3 text-right font-normal">Δ {METRIC_LABEL[metric]}</th>
              <th scope="col" className="py-2 pr-3 font-normal">commit</th>
              <th scope="col" className="py-2 font-normal">date</th>
            </tr>
          </thead>
          <tbody className="font-mono tabular-nums">
            {runs.map((r) => {
              const isRef = r.run === reference?.run;
              const delta = isRef ? null : Number((r[metric] - reference[metric]).toFixed(1));
              const inconclusive =
                delta !== null && isWithinBand(delta, pairwiseN(r.n, reference.n));
              return (
                <tr
                  key={r.run}
                  className={cn("border-b border-hairline", isRef && "bg-accent-soft")}
                >
                  <td className="py-1.5 pr-3">
                    <label className="flex items-center gap-1">
                      <input
                        type="radio"
                        name="reference"
                        checked={isRef}
                        onChange={() => setReferenceId(r.run)}
                        aria-label={`Use ${r.scaffold} at n=${r.n} as the reference`}
                      />
                      <span className="sr-only">reference</span>
                    </label>
                  </td>
                  <td className="py-1.5 pr-3 text-fg" title={r.scaffold}>
                    {prettyScaffold(r.scaffold)}
                  </td>
                  <td className="py-1.5 pr-3 text-muted">{r.model}</td>
                  <td className="py-1.5 pr-3 text-right">
                    {r.n}
                    {r.n < UNDERPOWERED_N && (
                      <span className="ml-1 text-evidence-path" title="underpowered: one task moves this by more than 3 points">
                        !
                      </span>
                    )}
                  </td>
                  <td className={cn("py-1.5 pr-3 text-right", metric === "file5" && "text-fg")}>
                    {r.file5.toFixed(1)}
                  </td>
                  <td className={cn("py-1.5 pr-3 text-right", metric === "func10" && "text-fg")}>
                    {r.func10.toFixed(1)}
                  </td>
                  <td className="py-1.5 pr-3 text-right text-muted">
                    {r.parse_failures || "—"}
                  </td>
                  <td className="py-1.5 pr-3 text-right">
                    {delta === null ? (
                      <span className="text-subtle">—</span>
                    ) : (
                      <span
                        className={inconclusive ? "text-subtle" : "text-fg"}
                        title={
                          inconclusive
                            ? `inside the resolution of n=${pairwiseN(r.n, reference.n)}`
                            : undefined
                        }
                      >
                        {delta > 0 ? "+" : ""}
                        {delta.toFixed(1)}
                        {inconclusive && " ?"}
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3 text-subtle">{r.commit}</td>
                  <td className="py-1.5 text-subtle">{r.date}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
