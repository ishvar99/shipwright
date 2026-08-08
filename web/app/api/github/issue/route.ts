import { NextResponse, type NextRequest } from "next/server";
import { headers } from "next/headers";
import { auth, githubConfigured } from "@/lib/auth";
import { signedIn } from "@/lib/owner";

/**
 * Fetches one GitHub issue so "fix issue #123" can become the real report.
 *
 * A BFF route, not a browser fetch: our CSP is `connect-src 'self'`, the same reason the
 * zipball hop lives server-side. Gated, because an open proxy would spend the deployment's
 * shared unauthenticated GitHub budget (60/hr, keyed on the Vercel egress IP) for anyone who
 * found the URL. A signed-in caller's own token raises that to 5,000/hr and reaches issues in
 * their private repositories; without one we fall back to the anonymous budget for public
 * repositories only.
 */

const bad = (status: number, detail: string) => NextResponse.json({ detail }, { status });

async function userToken(): Promise<string> {
  if (!githubConfigured) return "";
  try {
    const r = await auth.api.getAccessToken({
      body: { providerId: "github" },
      headers: await headers(),
    });
    return r?.accessToken ?? "";
  } catch {
    return ""; // not connected: the anonymous budget still serves public repositories
  }
}

export async function POST(request: NextRequest) {
  if (!(await signedIn(request.headers))) return bad(401, "Sign in to use this.");

  let owner = "";
  let name = "";
  let number = 0;
  try {
    const b = (await request.json()) as { owner?: unknown; name?: unknown; number?: unknown };
    owner = String(b.owner ?? "");
    name = String(b.name ?? "");
    number = Number(b.number ?? 0);
  } catch {
    // handled by the validation below
  }
  // Re-validated here, not trusted from the client: these go straight into a URL path.
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name) || !Number.isInteger(number) || number < 1) {
    return bad(400, "That doesn't look like a GitHub issue reference.");
  }

  const token = await userToken();
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${name}/issues/${number}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(10_000),
        cache: "no-store",
      },
    );
    if (res.status === 404) {
      return bad(404, "No such issue, or it's in a private repository — connect GitHub first.");
    }
    if (res.status === 403) return bad(429, "GitHub is rate-limiting us. Try again shortly.");
    if (!res.ok) return bad(502, "GitHub is not responding right now.");
    const issue = (await res.json()) as {
      title?: string;
      body?: string | null;
      html_url?: string;
      pull_request?: unknown;
      state?: string;
    };
    // The issues endpoint also serves pull requests; a PR's body is a change description,
    // not a bug report, and silently ingesting one would mislead.
    if (issue.pull_request) return bad(400, `#${number} is a pull request, not an issue.`);
    return NextResponse.json(
      {
        title: issue.title ?? "",
        body: issue.body ?? "",
        html_url: issue.html_url ?? "",
        state: issue.state ?? "",
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return bad(502, "Could not reach GitHub.");
  }
}
