import bundle from "@/fixtures/msal-extract-rerank.json";
import { JobSchema, parseOrThrow } from "@/lib/contracts";

/** The committed recording of a real run. Statically imported, so it works with no backend —
 * which is the only thing the deployed site has. */
export const demoRun = bundle;

/** Parsed once, here, so replay and live share one `Job` type. Otherwise the deployed site is
 * the one surface whose data never passes through the contract.
 * repo_slug is taken from the recording's meta: the run predates the field, and without it
 * every demo session row renders a blank repo subtitle. */
/**
 * The recorded ids are re-prefixed, and that is load-bearing rather than cosmetic. The bundle
 * came from a real run, so `job.id` and `job.repo_id` ARE live row ids in the database it was
 * captured from — on that machine, testing demo-ness by bare id equality flagged the user's own
 * repository as the recording and locked its page into replay. A prefix no UUID can produce
 * makes the two populations disjoint by construction.
 */
const DEMO_PREFIX = "demo-";
export const demoRepoId = `${DEMO_PREFIX}${bundle.job.repo_id}`;
export const demoJobId = `${DEMO_PREFIX}${bundle.job.id}`;

export const demoJob = parseOrThrow(
  JobSchema,
  { repo_slug: bundle.meta.repo, ...bundle.job, id: demoJobId, repo_id: demoRepoId },
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

/** Having a backend and having anything to look at are different questions. Once the recording
 * can appear alongside real rows, "is this replayed?" has to be asked per session and per
 * repository rather than once for the whole app. Prefix, not equality — see DEMO_PREFIX. */
export const isDemoJob = (jobId: string) => jobId.startsWith(DEMO_PREFIX);
export const isDemoRepo = (repoId: string | null | undefined) =>
  Boolean(repoId?.startsWith(DEMO_PREFIX));

/** 188KB of tree and file bodies — loaded only when the repo workspace opens, never by the
 * landing page, which statically imports this module. */
export async function loadDemoWorkspace() {
  const mod = await import("@/fixtures/msal-workspace.json");
  return mod.default;
}
