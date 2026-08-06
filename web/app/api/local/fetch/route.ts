import { NextResponse, type NextRequest } from "next/server";
import { signedIn } from "@/lib/owner";

export const maxDuration = 60;

/**
 * Fetches a public GitHub repository's zipball server-side and streams the bytes to the
 * browser, which unzips and indexes them locally.
 *
 * Why a route and not a direct browser fetch: our CSP is `connect-src 'self'`, and relaxing it
 * to reach github.com would widen the policy for every page to save one hop. Server-to-server
 * has no CORS to satisfy and measured 401ms. Public repositories only — a token here would be
 * a credential this deployment does not own.
 */
export async function POST(request: NextRequest) {
  // Proxied bandwidth is spent on the caller's behalf — the workspace gate covers it.
  if (!(await signedIn(request.headers))) {
    return NextResponse.json({ detail: "Sign in to use this." }, { status: 401 });
  }
  let url = "";
  try {
    const body: unknown = await request.json();
    url = String((body as { url?: unknown })?.url ?? "").trim();
  } catch {
    // handled by the parse below
  }

  const m = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);
  if (!m) {
    return NextResponse.json(
      { detail: "Paste a GitHub repository URL, like https://github.com/owner/name." },
      { status: 400 },
    );
  }
  const [, owner, name] = m;

  try {
    const meta = await fetch(`https://api.github.com/repos/${owner}/${name}`, {
      headers: { accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (meta.status === 404) {
      return NextResponse.json(
        { detail: "No public repository at that URL. Private repos need the local engine." },
        { status: 404 },
      );
    }
    if (!meta.ok) {
      return NextResponse.json({ detail: "GitHub is not responding right now." }, { status: 502 });
    }
    const info = (await meta.json()) as { default_branch?: string; size?: number };
    // `size` is in KB and counts history; 150MB of working tree is already past what the
    // browser should unzip, so refuse before spending the download.
    if ((info.size ?? 0) > 150_000) {
      return NextResponse.json(
        { detail: "That repository is too large to index in the browser." },
        { status: 413 },
      );
    }
    const branch = info.default_branch ?? "main";

    const zip = await fetch(
      `https://codeload.github.com/${owner}/${name}/zip/refs/heads/${branch}`,
      { signal: AbortSignal.timeout(45_000) },
    );
    if (!zip.ok || !zip.body) {
      return NextResponse.json({ detail: "Could not download that repository." }, { status: 502 });
    }
    return new Response(zip.body, {
      headers: {
        "content-type": "application/zip",
        "cache-control": "no-store",
        "x-repo-slug": `${owner}/${name}`,
        "x-repo-ref": branch,
      },
    });
  } catch {
    return NextResponse.json({ detail: "Could not reach GitHub." }, { status: 502 });
  }
}
