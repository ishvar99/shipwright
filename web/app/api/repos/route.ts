import { callBackend } from "@/lib/backend";
import { RepoListSchema } from "@/lib/contracts";
import { ok, toResponse } from "@/lib/route-helpers";

export async function GET() {
  try {
    return ok(await callBackend(RepoListSchema, "/api/repos"));
  } catch (e) {
    return toResponse(e);
  }
}
