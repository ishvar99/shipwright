import type { NextRequest } from "next/server";
import { callBackend } from "@/lib/backend";
import { JobListSchema, JobSchema } from "@/lib/contracts";
import { ok, toResponse } from "@/lib/route-helpers";

export async function GET(request: NextRequest) {
  try {
    const limit = request.nextUrl.searchParams.get("limit") ?? undefined;
    return ok(await callBackend(JobListSchema, "/api/jobs", { query: { limit } }));
  } catch (e) {
    return toResponse(e);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body: unknown = await request.json();
    return ok(await callBackend(JobSchema, "/api/jobs", { method: "POST", body }));
  } catch (e) {
    return toResponse(e);
  }
}
