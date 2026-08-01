import type { NextRequest } from "next/server";
import { ok, toResponse } from "@/lib/route-helpers";
import { RepoSchema, parseOrThrow } from "@/lib/contracts";
import { backendHeaders } from "@/lib/backend";
import { ApiError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// No maxDuration: it is Vercel-only semantics, and this route only exists where a backend
// runs locally. Declaring 60 here would document a limit that does not apply.

const MAX_BYTES = 150 * 1024 * 1024;

/** Raw multipart pass-through. Not `callBackend`: that is JSON-only with a 30s abort, and
 * request.formData() would buffer the whole archive in memory. */
export async function POST(request: NextRequest) {
  const base = process.env.BACKEND_URL;
  try {
    if (!base) throw new ApiError("backend_unreachable", "This deployment has no live backend");

    // content-length covers the whole multipart body, so allow for the boundary envelope;
    // the backend's own byte count on the raw file is the authoritative cap.
    const length = Number(request.headers.get("content-length") ?? 0);
    if (length > MAX_BYTES + 8192) {
      throw new ApiError("validation", "That archive is too large (limit 150 MB).");
    }
    const type = request.headers.get("content-type");
    if (!type?.startsWith("multipart/form-data")) {
      throw new ApiError("validation", "Upload a .zip archive.");
    }
    if (!request.body) throw new ApiError("validation", "The upload was empty.");

    let upstream: Response;
    try {
      // Exact path, no trailing slash: FastAPI's 307 redirect cannot be followed with a
      // one-shot stream body. content-type carries the multipart boundary, so it is forwarded
      // verbatim; content-length is not, because this leg is chunked.
      upstream = await fetch(new URL("/api/repos/upload", base), {
        method: "POST",
        headers: await backendHeaders({ "content-type": type }),
        body: request.body,
        // @ts-expect-error -- duplex is required by Node for a streamed request body and is
        // absent from the DOM RequestInit type.
        duplex: "half",
        signal: request.signal,
        cache: "no-store",
      });
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") throw e;
      // Undici surfaces a dead socket as TypeError("fetch failed"), which would otherwise
      // reach the user as that literal string.
      throw new ApiError(
        "backend_unreachable",
        "Can't reach Shipwright. Check that the local server is running.",
      );
    }

    if (!upstream.ok) {
      const detail = await upstreamDetail(upstream);
      throw new ApiError(
        upstream.status === 413 || upstream.status === 400 ? "validation" : "backend_error",
        detail ?? `The upload was refused (${upstream.status}).`,
      );
    }
    return ok(parseOrThrow(RepoSchema, await upstream.json(), "/api/repos/upload"));
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") return new Response(null, { status: 499 });
    return toResponse(e);
  }
}

async function upstreamDetail(res: Response): Promise<string | undefined> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === "object" && "detail" in body) {
      const d = (body as { detail: unknown }).detail;
      return typeof d === "string" ? d : undefined;
    }
  } catch {
    /* not JSON */
  }
  return undefined;
}
