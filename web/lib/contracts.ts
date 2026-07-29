import { z } from "zod";
import { ApiError } from "@/lib/errors";

export const CHANNELS = ["bm25", "graph", "dense", "path"] as const;
export type Channel = (typeof CHANNELS)[number];

export const RepoStatusSchema = z.enum(["importing", "ready", "failed"]);
export const JobStatusSchema = z.enum(["queued", "running", "done", "errored"]);

export const RepoSchema = z.object({
  id: z.string(),
  slug: z.string(),
  source: z.enum(["github", "local"]),
  status: RepoStatusSchema,
  symbols: z.number(),
  files: z.number(),
  ref: z.string(),
  error: z.string(),
  created_at: z.string(),
});

export const LocationSchema = z.object({
  rank: z.number(),
  symbol: z.string(),
  path: z.string(),
  name: z.string(),
  kind: z.string(),
  start_line: z.number(),
  end_line: z.number(),
  score: z.number(),
  // A channel we don't know about is dropped, not fatal: adding a retrieval channel
  // to the backend should degrade the evidence strip, not blank the results pane.
  channels: z.array(z.string()).transform((cs) => cs.filter(isChannel)),
  signature: z.string(),
});

export const GraphStatsSchema = z.object({
  files: z.number().optional(),
  symbols: z.number().optional(),
  call_edges: z.number().optional(),
  import_edges: z.number().optional(),
});

export const JobResultSchema = z.object({
  locations: z.array(LocationSchema).default([]),
  graph: GraphStatsSchema.default({}),
});

export const JobSchema = z.object({
  id: z.string(),
  repo_id: z.string(),
  kind: z.string(),
  status: JobStatusSchema,
  mode: z.string(),
  base_mode: z.string(),
  model: z.string(),
  issue: z.string(),
  result: JobResultSchema,
  error: z.string(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  wall_ms: z.number(),
  created_at: z.string(),
});

export const SourceSchema = z.object({
  path: z.string(),
  start: z.number(),
  lines: z.array(z.string()),
});

export const AnalyticsRunSchema = z.object({
  run: z.string(),
  scaffold: z.string(),
  model: z.string(), // "—" for retrieval-only runs
  n: z.number(),
  file5: z.number(),
  func10: z.number(),
  commit: z.string(),
  date: z.string(),
});

export const AnalyticsSchema = z.object({
  runs: z.array(AnalyticsRunSchema),
  noise_floor_pp: z.number(),
});

export const RepoListSchema = z.array(RepoSchema);
export const JobListSchema = z.array(JobSchema);

export type Repo = z.infer<typeof RepoSchema>;
export type Location = z.infer<typeof LocationSchema>;
export type Job = z.infer<typeof JobSchema>;
export type Source = z.infer<typeof SourceSchema>;
export type Analytics = z.infer<typeof AnalyticsSchema>;
export type AnalyticsRun = z.infer<typeof AnalyticsRunSchema>;

function isChannel(value: string): value is Channel {
  return (CHANNELS as readonly string[]).includes(value);
}

/** Validate at the boundary so drift surfaces here, named, rather than as `undefined`
 * three components deep. */
export function parseOrThrow<T>(schema: z.ZodType<T>, data: unknown, endpoint: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new ApiError(
      "contract_mismatch",
      `${endpoint} returned an unexpected shape`,
      first ? `${first.path.join(".") || "<root>"}: ${first.message}` : undefined,
    );
  }
  return result.data;
}
