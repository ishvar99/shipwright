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
  // 1-based retrieval position before reranking. Optional: rows captured before the backend
  // recorded it still parse, and basisFor() downgrades the labels when it is missing.
  base_rank: z.number().int().positive().optional(),
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
  // Summed across the run's tasks. The fine-tune's headline was parse failures, not accuracy.
  parse_failures: z.number().default(0),
  commit: z.string(),
  date: z.string(),
});

export const AnalyticsSchema = z.object({
  runs: z.array(AnalyticsRunSchema),
  noise_floor_pp: z.number(),
});

export const RepoListSchema = z.array(RepoSchema);
export const JobListSchema = z.array(JobSchema);

// --- Activity stream -------------------------------------------------------
// The backend flattens {seq, type, ts, ...payload} into one object per frame. `ts` is the
// server clock; without it every duration would be an artifact of the 0.4s poll.

const envelope = { seq: z.number(), ts: z.string().optional() };

export const EVENT_TYPES = [
  "job.started",
  "graph.building",
  "graph.ready",
  "engine.started",
  "understand.started",
  "understand.done",
  "search.started",
  "candidates.found",
  "rank.started",
  "engine.finished",
  "model.selected", // legacy: replays of jobs recorded before the narrative events
  "retrieval.started", // legacy + retrieval-only mode
  "model.finished",
  "localization.ready",
  "job.done",
  "job.failed",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const JobEventSchema = z.discriminatedUnion("type", [
  z.object({ ...envelope, type: z.literal("job.started"), repo: z.string(), mode: z.string(), base: z.string() }),
  z.object({ ...envelope, type: z.literal("graph.building") }),
  z.object({
    ...envelope,
    type: z.literal("graph.ready"),
    files: z.number(),
    symbols: z.number(),
    call_edges: z.number().optional(),
    import_edges: z.number().optional(),
  }),
  z.object({ ...envelope, type: z.literal("engine.started") }),
  z.object({ ...envelope, type: z.literal("understand.started") }),
  z.object({ ...envelope, type: z.literal("understand.done"), terms: z.number() }),
  z.object({ ...envelope, type: z.literal("search.started"), channels: z.string() }),
  z.object({ ...envelope, type: z.literal("candidates.found"), count: z.number() }),
  z.object({ ...envelope, type: z.literal("rank.started"), pool: z.number() }),
  z.object({ ...envelope, type: z.literal("engine.finished") }),
  // Legacy arm: old sessions replay events that still carry a model name. It is parsed so the
  // replay works, and rendered nowhere.
  z.object({ ...envelope, type: z.literal("model.selected"), model: z.string().optional(), reason: z.string().optional() }),
  // `channels` is the mode name ("hybrid", "bm25"), not a channel list. Typing it as
  // Channel[] would make isChannel silently drop it.
  z.object({ ...envelope, type: z.literal("retrieval.started"), channels: z.string() }),
  z.object({
    ...envelope,
    type: z.literal("model.finished"),
    calls: z.number(),
    input_tokens: z.number(),
    output_tokens: z.number(),
    parse_failures: z.number(),
  }),
  z.object({ ...envelope, type: z.literal("localization.ready"), count: z.number() }),
  z.object({ ...envelope, type: z.literal("job.done"), wall_ms: z.number(), locations: z.number() }),
  z.object({ ...envelope, type: z.literal("job.failed"), error: z.string() }),
]);

export type JobEvent = z.infer<typeof JobEventSchema>;
export const TERMINAL_EVENTS: ReadonlySet<string> = new Set(["job.done", "job.failed"]);

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
