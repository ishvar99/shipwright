import type { NextRequest } from "next/server";
import { callBackend } from "@/lib/backend";
import { JobListSchema, JobSchema } from "@/lib/contracts";
import { ok, toResponse } from "@/lib/route-helpers";
import type { Job } from "@/lib/contracts";

/** The engine is behind this API. Blank its traces so the network tab shows nothing either. */
function scrub(job: Job): Job {
  return { ...job, model: "", input_tokens: 0, output_tokens: 0 };
}

export async function GET(request: NextRequest) {
  try {
    const limit = request.nextUrl.searchParams.get("limit") ?? undefined;
    return ok((await callBackend(JobListSchema, "/api/jobs", { query: { limit } })).map(scrub));
  } catch (e) {
    return toResponse(e);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body: unknown = await request.json();
    return ok(scrub(await callBackend(JobSchema, "/api/jobs", { method: "POST", body })));
  } catch (e) {
    return toResponse(e);
  }
}
