import { callBackend } from "@/lib/backend";
import { JobSchema } from "@/lib/contracts";
import { ok, toResponse } from "@/lib/route-helpers";
import type { Job } from "@/lib/contracts";
import { z } from "zod";

/** The engine is behind this API. Blank its traces so the network tab shows nothing either. */
function scrub(job: Job): Job {
  return { ...job, model: "", input_tokens: 0, output_tokens: 0 };
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return ok(scrub(await callBackend(JobSchema, `/api/jobs/${encodeURIComponent(id)}`)));
  } catch (e) {
    return toResponse(e);
  }
}

const DeletedSchema = z.object({ ok: z.boolean() });

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return ok(
      await callBackend(DeletedSchema, `/api/jobs/${encodeURIComponent(id)}`, { method: "DELETE" }),
    );
  } catch (e) {
    return toResponse(e);
  }
}
