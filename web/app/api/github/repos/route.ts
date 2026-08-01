import { headers } from "next/headers";
import { auth, githubConfigured } from "@/lib/auth";
import { GitHubRepoListSchema, parseOrThrow } from "@/lib/contracts";
import { ApiError } from "@/lib/errors";
import { ok, toResponse } from "@/lib/route-helpers";

/** Lists the connected user's repositories. The token is read server-side and never returned;
 * the browser only ever sees names. */
export async function GET() {
  try {
    if (!githubConfigured) throw new ApiError("not_found", "GitHub isn't configured here.");
    const token = await accessToken();
    const res = await fetch(
      "https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member",
      {
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
        cache: "no-store",
      },
    );
    if (res.status === 401 || res.status === 403) {
      // The user revoked access on github.com; the stored token is still present but dead.
      throw new ApiError("validation", "Access was revoked on GitHub. Reconnect to continue.");
    }
    if (!res.ok) throw new ApiError("backend_error", `GitHub returned ${res.status}.`);
    const body: unknown = await res.json();
    const list = Array.isArray(body)
      ? body.map((r) => {
          const x = r as Record<string, unknown>;
          return {
            full_name: x.full_name,
            private: x.private,
            updated_at: x.updated_at,
            clone_url: x.clone_url,
          };
        })
      : [];
    return ok(parseOrThrow(GitHubRepoListSchema, list, "GET /api/github/repos"));
  } catch (e) {
    return toResponse(e);
  }
}

async function accessToken(): Promise<string> {
  const result = await auth.api
    .getAccessToken({ body: { providerId: "github" }, headers: await headers() })
    .catch(() => null);
  const token = result?.accessToken;
  if (!token) throw new ApiError("validation", "Connect GitHub first.");
  return token;
}
