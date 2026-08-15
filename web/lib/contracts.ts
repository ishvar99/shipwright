import { z } from "zod";
import { ApiError } from "@/lib/errors";

export const CHANNELS = ["bm25", "graph", "dense", "path"] as const;
export type Channel = (typeof CHANNELS)[number];

export const RepoStatusSchema = z.enum(["importing", "ready", "failed"]);
export const JobStatusSchema = z.enum(["queued", "running", "done", "errored"]);

export const RepoSchema = z.object({
  id: z.string(),
  slug: z.string(),
  source: z.enum(["github", "local", "zip"]),
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

export const FixSchema = z.object({
  patch: z.string().optional(),
  files: z.number().optional(),
  additions: z.number().optional(),
  deletions: z.number().optional(),
  attempt: z.number().optional(),
  failed: z.string().optional(),
  applied_branch: z.string().optional(),
  pr_url: z.string().optional(),
  target: z
    .object({ symbol: z.string(), path: z.string(), name: z.string(), start_line: z.number() })
    .optional(),
  tests: z.object({ passed: z.number(), failed: z.number() }).optional(),
});

/** One review finding, anchored to a position the diff actually contains. */
export const FindingSchema = z.object({
  path: z.string(),
  line: z.number(),
  end_line: z.number().default(0),
  side: z.enum(["LEFT", "RIGHT"]).default("RIGHT"),
  category: z.enum(["security", "error_handling", "test_coverage", "quality"]),
  severity: z.enum(["high", "medium", "low"]),
  title: z.string(),
  body: z.string().default(""),
  source: z.enum(["llm", "ruff"]).default("llm"),
  rule: z.string().default(""),
  /** Bounded diff excerpt around the anchor, attached at review time. */
  hunk: z.string().default(""),
  /** Flagged independently by more than one check. Raises rank, never duplicates the row. */
  agreed: z.boolean().default(false),
});

/** What was and was not reviewed. Every gap is named rather than implied. */
export const ReviewCoverageSchema = z.object({
  files: z.number().default(0),
  reviewed: z.number().default(0),
  unreviewed: z.array(z.string()).default([]),
  degraded: z.array(z.string()).default([]),
  /** graph = call-graph grounded · window = changed files only · none = static checks only. */
  tier: z.enum(["graph", "window", "none"]).default("none"),
});

export const PullRequestSchema = z.object({
  number: z.number(),
  title: z.string(),
  author: z.string().default(""),
  updated_at: z.string().default(""),
  draft: z.boolean().default(false),
  head_sha: z.string().default(""),
});
export const PullRequestListSchema = z.array(PullRequestSchema);

export const JobResultSchema = z.object({
  locations: z.array(LocationSchema).default([]),
  /**
   * Review output. Optional rather than defaulted, deliberately: a localize session has no
   * review, and defaulting it would assert `complete: true` and a coverage tier about a job
   * that was never reviewed. Absent and empty are different claims.
   */
  findings: z.array(FindingSchema).optional(),
  coverage: ReviewCoverageSchema.optional(),
  complete: z.boolean().optional(),
  review_url: z.string().optional(),
  triage: z
    .record(
      z.string(),
      z.object({
        state: z.enum(["kept", "dismissed"]),
        reason: z.string().default(""),
      }),
    )
    .optional(),
  superseded_by: z.string().optional(),
  graph: GraphStatsSchema.default({}),
  fix: FixSchema.nullish(),
  /** change | question | other — absent on sessions recorded before routing existed. */
  intent: z.enum(["change", "question", "other"]).nullish(),
  /** Why the router said `other` (meta | vague | chitchat | nonsense …): the reply differs by
   * subclass. Zod strips unknown keys, so without this line the field would vanish here. */
  reason: z.string().default(""),
  answer: z.string().default(""),
  /** A browser-run session's own event recording, so reopening it replays rather than
   * re-runs — the local analogue of the backend's Last-Event-ID resume. Backend rows carry
   * their events in Postgres and never set this. */
  frames: z.array(z.string()).default([]),
  /** The conversation, for multi-turn local sessions. `issue`/`answer`/`locations` above
   * always mirror the LATEST turn, so single-turn consumers (and every backend row, which
   * has no turns) never change. Defaults keep pre-feature rows parsing. */
  turns: z
    .array(
      z.object({
        issue: z.string(),
        answer: z.string(),
        locations: z.array(LocationSchema).default([]),
      }),
    )
    .default([]),
});

export const JobSchema = z.object({
  id: z.string(),
  repo_id: z.string(),
  // Carried on the job so session lists name their repo without a client-side join, which
  // has nothing to join against in the recorded demo.
  repo_slug: z.string().default(""),
  kind: z.string(),
  status: JobStatusSchema,
  mode: z.string(),
  base_mode: z.string(),
  client: z.string().default(""),
  model: z.string(),
  issue: z.string(),
  result: JobResultSchema,
  error: z.string(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  wall_ms: z.number(),
  created_at: z.string(),
});

/** The repo browser's file list. Flat: the client folds it into a tree and feeds quick-open
 * from the same array. `branch` is the branch actually checked out — after an apply the
 * workspace sits on shipwright/fix-*, and the UI says so rather than guessing. */
export const RepoTreeSchema = z.object({
  entries: z.array(z.object({ path: z.string(), size: z.number() })),
  truncated: z.boolean().default(false),
  branch: z.string().default(""),
  head: z.string().default(""),
});

/** Binary and oversize files come back 200 with a reason and no content, so the editor shows
 * a placeholder rather than an error banner. */
export const RepoFileSchema = z.object({
  path: z.string(),
  content: z.string().default(""),
  sha: z.string().default(""),
  reason: z.enum(["binary", "too_large"]).nullish(),
});

/** `sha` is the new conflict token: without it every second save would self-conflict. */
export const RepoSaveSchema = z.object({
  sha: z.string(),
  commit: z.string().nullable(),
});

/** The user's repositories, as the picker needs them. Straight from GitHub, narrowed. */
export const GitHubRepoSchema = z.object({
  full_name: z.string(),
  private: z.boolean(),
  updated_at: z.string(),
  clone_url: z.string(),
});
export const GitHubRepoListSchema = z.array(GitHubRepoSchema);

/** Whether Connect GitHub can be offered, and who is connected. Never carries the token. */
export const GitHubStatusSchema = z.object({
  configured: z.boolean(),
  connected: z.boolean(),
  login: z.string().default(""),
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
  "fix.started",
  "fix.delta",
  "fix.ready",
  "fix.failed",
  "fix.skipped",
  "apply.started",
  "apply.done",
  "pr.started",
  "pr.ready",
  "pr.failed",
  "env.started",
  "env.ready",
  "test.started",
  "test.output",
  "test.done",
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
  // Routing: what the user actually asked for. Only "change" may end in an edit.
  z.object({ ...envelope, type: z.literal("intent.started") }),
  z.object({
    ...envelope,
    type: z.literal("intent.ready"),
    intent: z.enum(["change", "question", "other"]),
    reason: z.string().default(""),
  }),
  z.object({ ...envelope, type: z.literal("answer.started") }),
  z.object({ ...envelope, type: z.literal("answer.delta"), text: z.string() }),
  z.object({ ...envelope, type: z.literal("answer.ready") }),
  z.object({ ...envelope, type: z.literal("answer.failed") }),
  z.object({ ...envelope, type: z.literal("understand.started") }),
  z.object({ ...envelope, type: z.literal("understand.done"), terms: z.number() }),
  z.object({ ...envelope, type: z.literal("search.started"), channels: z.string() }),
  z.object({ ...envelope, type: z.literal("candidates.found"), count: z.number() }),
  z.object({ ...envelope, type: z.literal("rank.started"), pool: z.number() }),
  z.object({ ...envelope, type: z.literal("engine.finished") }),
  z.object({ ...envelope, type: z.literal("fix.started"), attempt: z.number() }),
  z.object({ ...envelope, type: z.literal("fix.delta"), text: z.string() }),
  z.object({
    ...envelope,
    type: z.literal("fix.ready"),
    files: z.number(),
    additions: z.number(),
    deletions: z.number(),
    attempt: z.number(),
  }),
  z.object({ ...envelope, type: z.literal("fix.failed"), reason: z.string() }),
  z.object({ ...envelope, type: z.literal("fix.skipped") }),
  z.object({ ...envelope, type: z.literal("apply.started") }),
  z.object({ ...envelope, type: z.literal("apply.done"), branch: z.string() }),
  z.object({ ...envelope, type: z.literal("pr.started"), branch: z.string(), slug: z.string() }),
  z.object({ ...envelope, type: z.literal("pr.ready"), url: z.string(), number: z.number() }),
  z.object({ ...envelope, type: z.literal("pr.failed"), reason: z.string() }),
  z.object({ ...envelope, type: z.literal("env.started") }),
  z.object({ ...envelope, type: z.literal("env.ready") }),
  z.object({ ...envelope, type: z.literal("test.started") }),
  z.object({ ...envelope, type: z.literal("test.output"), text: z.string() }),
  z.object({ ...envelope, type: z.literal("test.done"), passed: z.number(), failed: z.number() }),
  // Legacy arm: old sessions replay events that still carry a model name. Parsed so the
  // replay works — but the name is NOT declared, so zod strips it at the boundary and a
  // provider identity from an old row can never reach the client. The events route is a byte
  // pass-through, so this schema is the only place that scrub can happen.
  z.object({ ...envelope, type: z.literal("model.selected"), reason: z.string().optional() }),
  // `channels` is the mode name ("hybrid", "bm25"), not a channel list. Typing it as
  // Channel[] would make isChannel silently drop it.
  z.object({ ...envelope, type: z.literal("retrieval.started"), channels: z.string() }),
  // Token counts are deliberately undeclared, for the same reason /api/jobs blanks them:
  // they are ours, not the caller's. Nothing emits this event today (assisted.py notifies
  // counts only), so this arm exists to keep an old replay parsing, scrubbed.
  z.object({
    ...envelope,
    type: z.literal("model.finished"),
    calls: z.number().optional(),
    parse_failures: z.number().optional(),
  }),
  z.object({ ...envelope, type: z.literal("localization.ready"), count: z.number() }),
  // Review. Counts only: findings themselves ride on Job.result, which the client refetches
  // on job.done. No model or token fields are declared, deliberately — the events route is a
  // byte pass-through and this schema is the only place a scrub can happen.
  z.object({
    ...envelope,
    type: z.literal("review.fetched"),
    files: z.number(),
    truncated: z.boolean().default(false),
  }),
  z.object({
    ...envelope,
    type: z.literal("review.chunked"),
    units: z.number(),
    skipped: z.number().default(0),
  }),
  z.object({ ...envelope, type: z.literal("review.stage.started"), stage: z.string() }),
  z.object({
    ...envelope,
    type: z.literal("review.stage.finished"),
    stage: z.string(),
    attempt: z.number().default(1),
  }),
  z.object({
    ...envelope,
    type: z.literal("review.stage.retried"),
    stage: z.string(),
    attempt: z.number().default(1),
    error: z.string().default(""),
  }),
  z.object({
    ...envelope,
    type: z.literal("review.stage.degraded"),
    stage: z.string(),
    error: z.string().default(""),
  }),
  z.object({ ...envelope, type: z.literal("review.ready"), findings: z.number() }),
  z.object({ ...envelope, type: z.literal("review.progress"), done: z.number(), total: z.number() }),
  z.object({ ...envelope, type: z.literal("review.post.started"), slug: z.string().default("") }),
  z.object({
    ...envelope,
    type: z.literal("review.post.ready"),
    url: z.string(),
    number: z.number(),
  }),
  z.object({ ...envelope, type: z.literal("review.post.failed"), reason: z.string().default("") }),
  z.object({ ...envelope, type: z.literal("job.done"), wall_ms: z.number(), locations: z.number() }),
  z.object({ ...envelope, type: z.literal("job.failed"), error: z.string() }),
]);

export type JobEvent = z.infer<typeof JobEventSchema>;
export const TERMINAL_EVENTS: ReadonlySet<string> = new Set(["job.done", "job.failed"]);

export type Repo = z.infer<typeof RepoSchema>;
export type Location = z.infer<typeof LocationSchema>;
export type Job = z.infer<typeof JobSchema>;
export type Source = z.infer<typeof SourceSchema>;
export type RepoTree = z.infer<typeof RepoTreeSchema>;
export type RepoFile = z.infer<typeof RepoFileSchema>;
export type RepoSave = z.infer<typeof RepoSaveSchema>;
export type GitHubRepo = z.infer<typeof GitHubRepoSchema>;
export type GitHubStatus = z.infer<typeof GitHubStatusSchema>;
export type Analytics = z.infer<typeof AnalyticsSchema>;
export type AnalyticsRun = z.infer<typeof AnalyticsRunSchema>;
export type Fix = z.infer<typeof FixSchema>;
export type Finding = z.infer<typeof FindingSchema>;
export type ReviewCoverage = z.infer<typeof ReviewCoverageSchema>;
export type PullRequest = z.infer<typeof PullRequestSchema>;

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
