import type { z } from "zod";
import { parseOrThrow } from "@/lib/contracts";
import { ApiError, kindFromStatus } from "@/lib/errors";
import { callerOwner } from "@/lib/owner";

const BASE = process.env.BACKEND_URL ?? "http://localhost:8000";
const TIMEOUT_MS = 30_000;

/**
 * The shared secret, added to every backend call. Exported because three routes stream or
 * forward raw bodies and cannot go through `callBackend` — they must not be the three that
 * quietly stay unauthenticated. Server-only: this module is never imported by a client
 * component, so the key cannot reach the browser.
 */
export async function backendHeaders(
  extra?: Record<string, string>,
): Promise<Record<string, string>> {
  const key = process.env.SHIPWRIGHT_API_KEY;
  // Identity is resolved once, here, where the session cookie actually lives. FastAPI trusts
  // the header only because the shared secret gates the port.
  const owner = await callerOwner();
  return {
    ...(key ? { "x-shipwright-key": key } : {}),
    ...(owner ? { "x-shipwright-owner": owner } : {}),
    ...extra,
  };
}

/** Is our engine reachable? Cached briefly per server instance: the answer gates every
 * fallback decision, and re-asking a dead host on each request would add its full timeout
 * to every fallback response. 30s staleness is the accepted cost — a backend that just came
 * up takes up to 30s to be preferred again. */
let health: { up: boolean; at: number } | null = null;
const HEALTH_TTL_MS = 30_000;
const HEALTH_TIMEOUT_MS = 1_500;

export async function backendUp(): Promise<boolean> {
  // Unset means "this deployment has no backend", which is a configuration fact, not a probe.
  if (!process.env.BACKEND_URL) return false;
  if (health && Date.now() - health.at < HEALTH_TTL_MS) return health.up;
  let up = false;
  try {
    const res = await fetch(new URL("/api/health", BASE), {
      headers: await backendHeaders(),
      cache: "no-store",
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    up = res.ok;
  } catch {
    up = false;
  }
  health = { up, at: Date.now() };
  return up;
}

type Options = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | undefined>;
};

/** FastAPI puts HTTPException text in `detail`, but pydantic validation puts a list of
 * issues there. Take the first issue's message so the UI shows a reason, not a number. */
async function readDetail(res: Response): Promise<string | undefined> {
  try {
    const body: unknown = await res.json();
    if (!body || typeof body !== "object" || !("detail" in body)) return undefined;
    const detail = (body as { detail: unknown }).detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
      const first: unknown = detail[0];
      if (first && typeof first === "object" && "msg" in first) {
        const msg = (first as { msg: unknown }).msg;
        if (typeof msg === "string") return msg;
      }
    }
  } catch {
    // non-JSON error body
  }
  return undefined;
}

/** Calls FastAPI and validates the response. Throws ApiError; never returns a partial. */
export async function callBackend<T>(
  schema: z.ZodType<T>,
  path: string,
  opts: Options = {},
): Promise<T> {
  const method = opts.method ?? "GET";
  const url = new URL(path, BASE);
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: await backendHeaders(
        opts.body ? { "content-type": "application/json" } : undefined,
      ),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    throw new ApiError(
      aborted ? "timeout" : "backend_unreachable",
      aborted ? "The backend did not respond in time" : "Cannot reach the backend",
      `${method} ${url.pathname}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = await readDetail(res);
    throw new ApiError(
      kindFromStatus(res.status),
      detail ?? `Backend returned ${res.status}`,
      `${method} ${url.pathname}`,
    );
  }

  return parseOrThrow(schema, await res.json(), `${method} ${url.pathname}`);
}
