import type { z } from "zod";
import { parseOrThrow } from "@/lib/contracts";
import { ApiError, type ErrorKind } from "@/lib/errors";

/**
 * Mirror of route-helpers on the browser side: turns the BFF's {kind, message, detail}
 * envelope back into an ApiError, so the UI branches on `kind` and never on a status code.
 */
async function call<T>(schema: z.ZodType<T>, path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { cache: "no-store", ...init });
  } catch {
    throw new ApiError("backend_unreachable", "Cannot reach the server");
  }

  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    const read = (key: string) =>
      body && typeof body === "object" && key in body
        ? String((body as Record<string, unknown>)[key])
        : undefined;
    throw new ApiError(
      (read("kind") ?? "backend_error") as ErrorKind,
      read("message") ?? `Request failed (${res.status})`,
      read("detail"),
    );
  }
  return parseOrThrow(schema, await res.json(), path);
}

export function apiGet<T>(schema: z.ZodType<T>, path: string): Promise<T> {
  return call(schema, path);
}

export function apiPost<T>(schema: z.ZodType<T>, path: string, body: unknown): Promise<T> {
  return call(schema, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The one sentence a failure shows. Kind, never a status code. */
export function messageFor(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : "Something went wrong";
}
