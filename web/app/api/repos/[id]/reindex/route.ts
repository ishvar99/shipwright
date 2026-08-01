import { callBackend } from "@/lib/backend";
import { RepoSchema } from "@/lib/contracts";
import { ok, toResponse } from "@/lib/route-helpers";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return ok(
      await callBackend(RepoSchema, `/api/repos/${encodeURIComponent(id)}/reindex`, {
        method: "POST",
      }),
    );
  } catch (e) {
    return toResponse(e);
  }
}
