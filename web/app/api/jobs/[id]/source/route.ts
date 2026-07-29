import type { NextRequest } from "next/server";
import { callBackend } from "@/lib/backend";
import { SourceSchema } from "@/lib/contracts";
import { ok, toResponse } from "@/lib/route-helpers";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const q = request.nextUrl.searchParams;
    return ok(
      await callBackend(SourceSchema, `/api/jobs/${encodeURIComponent(id)}/source`, {
        query: {
          path: q.get("path") ?? "",
          start: q.get("start") ?? undefined,
          end: q.get("end") ?? undefined,
        },
      }),
    );
  } catch (e) {
    return toResponse(e);
  }
}
