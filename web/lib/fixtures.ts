import bundle from "@/fixtures/msal-extract-rerank.json";
import { JobSchema, parseOrThrow } from "@/lib/contracts";

/** The committed recording of a real run. Statically imported, so it works with no backend —
 * which is the only thing the deployed site has. */
export const demoRun = bundle;

/** Parsed once, here, so replay and live share one `Job` type. Otherwise the deployed site is
 * the one surface whose data never passes through the contract. */
export const demoJob = parseOrThrow(JobSchema, bundle.job, "fixtures/msal-extract-rerank.json");

export type RunFixture = typeof bundle;
