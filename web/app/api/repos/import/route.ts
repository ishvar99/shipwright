import type { NextRequest } from "next/server";
import { callBackend } from "@/lib/backend";
import { RepoSchema } from "@/lib/contracts";
import { ok, toResponse } from "@/lib/route-helpers";

export async function POST(request: NextRequest) {
  try {
    const body: unknown = await request.json();
    return ok(await callBackend(RepoSchema, "/api/repos/import", { method: "POST", body }));
  } catch (e) {
    return toResponse(e);
  }
}
