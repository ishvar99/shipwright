import type { NextRequest } from "next/server";
import { callBackend } from "@/lib/backend";
import { JobSchema, type Job } from "@/lib/contracts";
import { ok, toResponse } from "@/lib/route-helpers";

function scrub(job: Job): Job {
  return { ...job, model: "", input_tokens: 0, output_tokens: 0 };
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body: unknown = await request.json();
    return ok(
      scrub(
        await callBackend(JobSchema, `/api/jobs/${encodeURIComponent(id)}/actions`, {
          method: "POST",
          body,
        }),
      ),
    );
  } catch (e) {
    return toResponse(e);
  }
}
