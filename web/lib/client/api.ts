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
    throw new ApiError("backend_unreachable", "Can't reach Shipwright. Check that the local server is running.");
  }

  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    const read = (key: string) =>
      body && typeof body === "object" && key in body
        ? String((body as Record<string, unknown>)[key])
        : undefined;
    throw new ApiError(
      (read("kind") ?? "backend_error") as ErrorKind,
      read("message") ?? "Something went wrong. Please try again.",
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

/**
 * Upload with progress. XHR, not fetch: fetch exposes no upload-progress events, and a
 * streamed request body is Chromium-only over HTTP/2 while dev and start serve HTTP/1.1.
 * Parses the same {kind, message} envelope as call() so failures read identically.
 */
export function apiUpload<T>(
  schema: z.ZodType<T>,
  path: string,
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("file", file);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", path);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    const fail = (kind: ErrorKind, message: string) => reject(new ApiError(kind, message));
    xhr.onerror = () =>
      fail("backend_unreachable", "Can't reach Shipwright. Check that the local server is running.");
    // Without these the promise never settles and the UI stays stuck on "Uploading…".
    xhr.onabort = () => fail("validation", "The upload was cancelled.");
    xhr.ontimeout = () => fail("timeout", "The upload timed out. Please try again.");
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* non-JSON error page */
      }
      const read = (key: string) =>
        body && typeof body === "object" && key in body
          ? String((body as Record<string, unknown>)[key])
          : undefined;
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(
          new ApiError(
            (read("kind") ?? "backend_error") as ErrorKind,
            read("message") ?? "That upload didn't work. Please try again.",
            read("detail"),
          ),
        );
        return;
      }
      try {
        resolve(parseOrThrow(schema, body, path));
      } catch (e) {
        reject(e);
      }
    };
    xhr.send(form);
  });
}
