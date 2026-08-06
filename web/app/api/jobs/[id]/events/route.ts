import type { NextRequest } from "next/server";
import { backendHeaders } from "@/lib/backend";
import { ApiError } from "@/lib/errors";
import { signedIn } from "@/lib/owner";
import { toResponse } from "@/lib/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Byte pass-through. Deliberately does not use `callBackend`: its 30s abort would cut a long
 * graph build, and it calls res.json() on a body that must stay a stream. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const base = process.env.BACKEND_URL;
  try {
    // Raw pass-through, so the callBackend gate does not cover it — gate it by hand.
    if (!(await signedIn(request.headers))) throw new ApiError("signed_out", "Sign in to use this.");
    if (!base) {
      // No backend in this deployment, so a stream can never open. Failing here is what makes
      // the deployed site select a recorded run instead of reconnect-looping.
      throw new ApiError("backend_unreachable", "This deployment has no live backend");
    }
    const { id } = await params;

    // A null Last-Event-ID stringifies to "null", which FastAPI reads as a cursor reset.
    const header = request.headers.get("last-event-id");
    const query = request.nextUrl.searchParams.get("after");
    const cursor = firstInt(header, query);

    const upstream = await fetch(new URL(`/api/jobs/${encodeURIComponent(id)}/events`, base), {
      headers: await backendHeaders({
        accept: "text/event-stream",
        ...(cursor === null ? {} : { "last-event-id": String(cursor) }),
      }),
      signal: request.signal,
      cache: "no-store",
    });

    if (!upstream.ok || !upstream.body) {
      throw new ApiError(
        upstream.status === 404 ? "not_found" : "backend_error",
        (await upstreamDetail(upstream)) ?? `Stream refused (${upstream.status})`,
      );
    }

    // Explicit headers only: upstream carries transfer-encoding and connection, which must not
    // be echoed through.
    return new Response(upstream.body, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") return new Response(null, { status: 499 });
    return toResponse(e);
  }
}

/** FastAPI reports a refusal as {"detail": "..."}; pass the message on, not the envelope. */
async function upstreamDetail(res: Response): Promise<string | undefined> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === "object" && "detail" in body) {
      const detail = (body as { detail: unknown }).detail;
      if (typeof detail === "string") return detail;
    }
  } catch {
    // non-JSON body
  }
  return undefined;
}

function firstInt(...values: (string | null)[]): number | null {
  for (const v of values) {
    if (v === null || v === "") continue;
    const n = Number(v);
    if (Number.isInteger(n) && n >= 0) return n;
  }
  return null;
}
