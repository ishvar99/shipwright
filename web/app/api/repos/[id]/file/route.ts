import type { NextRequest } from "next/server";
import { RepoFileSchema } from "@/lib/contracts";
import { backendHeaders, callBackend } from "@/lib/backend";
import { ApiError } from "@/lib/errors";
import { signedIn } from "@/lib/owner";
import { ok, toResponse } from "@/lib/route-helpers";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const path = request.nextUrl.searchParams.get("path");
    if (!path) throw new ApiError("validation", "No file was requested.");
    return ok(
      await callBackend(RepoFileSchema, `/api/repos/${encodeURIComponent(id)}/file`, {
        query: { path },
      }),
    );
  } catch (e) {
    return toResponse(e);
  }
}

/**
 * Save. Not `callBackend`: a 409 carries a body the client must read intact — `conflict`
 * needs the current sha so Overwrite is one request with no second race window, and `busy`
 * has no Overwrite at all. Collapsing both into a message would lose that distinction.
 */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const base = process.env.BACKEND_URL;
  try {
    // Raw pass-through, so the callBackend gate does not cover it — gate it by hand.
    if (!(await signedIn(request.headers))) throw new ApiError("signed_out", "Sign in to use this.");
    if (!base) throw new ApiError("backend_unreachable", "This deployment has no live backend");
    const { id } = await params;
    const body: unknown = await request.json();

    let upstream: Response;
    try {
      upstream = await fetch(new URL(`/api/repos/${encodeURIComponent(id)}/file`, base), {
        method: "PUT",
        headers: await backendHeaders({ "content-type": "application/json" }),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
        cache: "no-store",
      });
    } catch (e) {
      if (e instanceof Error && e.name === "TimeoutError") {
        throw new ApiError("timeout", "Saving took too long. Try again in a moment.");
      }
      throw new ApiError(
        "backend_unreachable",
        "Can't reach Shipwright. Check that the local server is running.",
      );
    }

    const payload: unknown = await upstream.json().catch(() => null);
    if (upstream.status === 409) {
      return new Response(JSON.stringify(payload), {
        status: 409,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }
    if (!upstream.ok) {
      const detail =
        payload && typeof payload === "object" && "detail" in payload
          ? String((payload as { detail: unknown }).detail)
          : undefined;
      throw new ApiError(
        upstream.status === 400 || upstream.status === 413 || upstream.status === 422
          ? "validation"
          : "backend_error",
        detail ?? `The save was refused (${upstream.status}).`,
      );
    }
    return ok(payload);
  } catch (e) {
    return toResponse(e);
  }
}
