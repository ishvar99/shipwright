import { headers } from "next/headers";
import { auth, githubConfigured } from "@/lib/auth";
import { callBackend } from "@/lib/backend";
import { PullRequestListSchema } from "@/lib/contracts";
import { ApiError } from "@/lib/errors";
import { ok, toResponse } from "@/lib/route-helpers";

/**
 * Open pull requests for one repository.
 *
 * The token is read here, server-side, and forwarded to the engine for exactly this call —
 * the same rule the import path follows. The browser never sees it; our CSP is
 * `connect-src 'self'`, so the GitHub hop could not happen there anyway.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!githubConfigured) throw new ApiError("not_found", "GitHub isn't configured here.");
    const result = await auth.api
      .getAccessToken({ body: { providerId: "github" }, headers: await headers() })
      .catch(() => null);
    const token = result?.accessToken;
    if (!token) throw new ApiError("validation", "Connect GitHub first.");
    return ok(
      await callBackend(PullRequestListSchema, `/api/repos/${encodeURIComponent(id)}/pulls`, {
        query: { token },
      }),
    );
  } catch (e) {
    return toResponse(e);
  }
}
