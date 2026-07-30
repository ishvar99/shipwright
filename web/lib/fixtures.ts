import bundle from "@/fixtures/msal-extract-rerank.json";

/** The committed recording of a real run. Statically imported, so it works with no backend —
 * which is the only thing the deployed site has. */
export const demoRun = bundle;
export type RunFixture = typeof bundle;
