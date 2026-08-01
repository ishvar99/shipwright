import bundle from "@/fixtures/msal-extract-rerank.json";
import { JobSchema, parseOrThrow } from "@/lib/contracts";

/** The committed recording of a real run. Statically imported, so it works with no backend —
 * which is the only thing the deployed site has. */
export const demoRun = bundle;

/** Parsed once, here, so replay and live share one `Job` type. Otherwise the deployed site is
 * the one surface whose data never passes through the contract.
 * repo_slug is taken from the recording's meta: the run predates the field, and without it
 * every demo session row renders a blank repo subtitle. */
export const demoJob = parseOrThrow(
  JobSchema,
  { repo_slug: bundle.meta.repo, ...bundle.job },
  "fixtures/msal-extract-rerank.json",
);

export type RunFixture = typeof bundle;

/** The demo repo as a Repo row, so the hosted demo has something to open. Its id matches the
 * recorded job's repo_id, which is what links a session to its workspace. */
export const demoRepo = {
  id: demoJob.repo_id,
  slug: bundle.meta.repo,
  source: "local" as const,
  status: "ready" as const,
  symbols: bundle.job.result.graph?.symbols ?? 0,
  files: 0,
  ref: bundle.meta.ref,
  error: "",
  created_at: bundle.meta.capturedAt,
};

/** 188KB of tree and file bodies — loaded only when the repo workspace opens, never by the
 * landing page, which statically imports this module. */
export async function loadDemoWorkspace() {
  const mod = await import("@/fixtures/msal-workspace.json");
  return mod.default;
}
