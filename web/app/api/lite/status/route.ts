import { backendUp } from "@/lib/backend";
import { liteConfigured } from "@/lib/lite";
import { ok } from "@/lib/route-helpers";

/** What the client may fall back to. Booleans only — never the provider or model. */
export async function GET() {
  return ok({ backend: await backendUp(), lite: liteConfigured() });
}
