import { callBackend } from "@/lib/backend";
import { AnalyticsSchema } from "@/lib/contracts";
import { ok, toResponse } from "@/lib/route-helpers";

export async function GET() {
  try {
    return ok(await callBackend(AnalyticsSchema, "/api/analytics/summary"));
  } catch (e) {
    return toResponse(e);
  }
}
