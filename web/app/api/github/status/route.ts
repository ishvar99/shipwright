import { headers } from "next/headers";
import { auth, githubConfigured } from "@/lib/auth";
import { ok } from "@/lib/route-helpers";

/** What the UI needs to decide between Connect, Connected and hidden. No token crosses this
 * boundary — only whether one exists. */
export async function GET() {
  try {
    if (!githubConfigured) return ok({ configured: false, connected: false, login: "" });
    const session = await auth.api.getSession({ headers: await headers() });
    return ok({
      configured: true,
      connected: Boolean(session?.user),
      login: session?.user?.name ?? session?.user?.email ?? "",
    });
  } catch {
    // A malformed or expired cookie is "not connected", not an error page.
    return ok({ configured: githubConfigured, connected: false, login: "" });
  }
}
