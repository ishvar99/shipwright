import type { Metadata } from "next";
import { RunTable } from "@/components/evals/run-table";
import { AnalyticsSchema, parseOrThrow } from "@/lib/contracts";
import snapshot from "@/fixtures/analytics.json";

export const metadata: Metadata = {
  title: "Benchmarks · Shipwright",
  description: "Benchmark runs, with the band each sample size cannot resolve.",
};

/**
 * Rendered from a committed snapshot, not fetched. The numbers are historical and do not change
 * between deploys, and the live route uses cache: "no-store" — which would make this page
 * dynamic and 500 on a deployment with no backend. On the one surface whose purpose is not
 * overstating things, that is the wrong failure.
 */
export default function EvalsPage() {
  const data = parseOrThrow(AnalyticsSchema, snapshot, "fixtures/analytics.json");
  const runs = [...data.runs].sort((a, b) => b.n - a.n || b.file5 - a.file5);

  return (
    <main className="register-dense sw-shell py-12">
      <h1 className="text-title text-fg">Benchmarks</h1>
      <p id="scoring" className="mt-2 max-w-[68ch] text-muted">
        Every run is a full configuration on Loc-Bench, scored strictly: a task counts only
        when <em>every</em> known-correct location lands inside the top k — &ldquo;right file
        in its top 5&rdquo; and &ldquo;right function in its top 10&rdquo;. Pick any row as the
        reference; the shaded range is what that comparison&rsquo;s sample size cannot resolve,
        so differences inside it are not results.
      </p>
      <p className="mt-1 font-mono text-[11px] text-subtle">
        snapshot {snapshot.meta.snapshotCommit} · captured {snapshot.meta.capturedAt.slice(0, 10)}{" "}
        · {runs.length} runs
      </p>

      <div className="mt-8">
        <RunTable runs={runs} />
      </div>

      <p className="mt-8 max-w-[68ch] text-subtle">
        The band is not a confidence interval. It is the smallest difference the sample can
        express — one task is {(100 / 30).toFixed(1)} points at n=30 — widened to the run-to-run
        spread actually observed for identical configurations. A run marked{" "}
        <span className="text-evidence-path">!</span> is too small to separate anything a reader
        would call a difference.
      </p>
    </main>
  );
}
