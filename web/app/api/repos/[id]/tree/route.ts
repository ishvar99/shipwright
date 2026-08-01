import { RepoTreeSchema } from "@/lib/contracts";
import { callBackend } from "@/lib/backend";
import { ok, toResponse } from "@/lib/route-helpers";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return ok(await callBackend(RepoTreeSchema, `/api/repos/${encodeURIComponent(id)}/tree`));
  } catch (e) {
    return toResponse(e);
  }
}
