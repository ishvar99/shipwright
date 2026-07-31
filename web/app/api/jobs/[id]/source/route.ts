import type { NextRequest } from "next/server";
import { callBackend } from "@/lib/backend";
import { JobSchema, SourceSchema } from "@/lib/contracts";
import { ApiError } from "@/lib/errors";
import { ok, toResponse } from "@/lib/route-helpers";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const q = request.nextUrl.searchParams;
    const path = q.get("path") ?? "";
    if (!path) throw new ApiError("validation", "No file requested");

    // Allowlist, not sanitisation. The backend refuses to escape the repo but happily serves
    // anything inside it — .git/config carries the clone's remote URL. The only paths this
    // surface has any business returning are the ones the job itself reported.
    const job = await callBackend(JobSchema, `/api/jobs/${encodeURIComponent(id)}`);
    const allowed = new Set(job.result.locations.map((l) => l.path));
    if (!allowed.has(path)) {
      throw new ApiError("validation", "That file is not part of this job's results");
    }

    return ok(
      await callBackend(SourceSchema, `/api/jobs/${encodeURIComponent(id)}/source`, {
        query: { path, start: q.get("start") ?? undefined, end: q.get("end") ?? undefined },
      }),
    );
  } catch (e) {
    return toResponse(e);
  }
}
