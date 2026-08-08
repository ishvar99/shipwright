import { callBackend } from "@/lib/backend";
import { ok, toResponse } from "@/lib/route-helpers";
import { z } from "zod";

const DeletedSchema = z.object({ ok: z.boolean() });

/** Unlink a repository. The backend removes its rows and its sessions and touches no files;
 * a repository imported into this browser never reaches here at all. */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return ok(
      await callBackend(DeletedSchema, `/api/repos/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    );
  } catch (e) {
    return toResponse(e);
  }
}
