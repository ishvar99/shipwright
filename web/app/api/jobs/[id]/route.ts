import { callBackend } from "@/lib/backend";
import { JobSchema } from "@/lib/contracts";
import { ok, toResponse } from "@/lib/route-helpers";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return ok(await callBackend(JobSchema, `/api/jobs/${encodeURIComponent(id)}`));
  } catch (e) {
    return toResponse(e);
  }
}
