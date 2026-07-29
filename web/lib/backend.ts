import type { z } from "zod";
import { parseOrThrow } from "@/lib/contracts";
import { ApiError, kindFromStatus } from "@/lib/errors";

const BASE = process.env.BACKEND_URL ?? "http://localhost:8000";
const TIMEOUT_MS = 30_000;

type Options = {
  method?: "GET" | "POST";
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
      headers: opts.body ? { "content-type": "application/json" } : undefined,
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
