import { NextResponse, type NextRequest } from "next/server";
import { backendUp } from "@/lib/backend";
import { askLite, liteConfigured } from "@/lib/lite";
import { signedIn } from "@/lib/owner";

// A streamed answer outlives the default function budget. 300s is the Vercel ceiling on the
// free plan for streaming responses; the idle timeout in lib/lite.ts is what actually ends a
// stalled run, so this only has to be larger than a slow-but-working answer.
export const maxDuration = 300;

const bad = (status: number, detail: string) => NextResponse.json({ detail }, { status });

/**
 * Answers without the backend. Only reachable in that state: while our engine is up this
 * route refuses, so the fallback can never silently shadow the real product.
 */
export async function POST(request: NextRequest) {
  // The one route that spends the free-tier quota, so the gate covers it too.
  if (!(await signedIn(request.headers))) return bad(401, "Sign in to use this.");
  if (!liteConfigured()) {
    return bad(503, "Lite answers aren't configured on this deployment.");
  }
  if (await backendUp()) {
    return bad(409, "The backend is up — use a normal session.");
  }

  let issue = "";
  let context: { path: string; content: string }[] = [];
  try {
    const body: unknown = await request.json();
    if (body && typeof body === "object") {
      const b = body as { issue?: unknown; context?: unknown };
      issue = String(b.issue ?? "").trim();
      // A local session has already retrieved and ranked; it sends the excerpts it chose
      // rather than making this route guess from the recorded bundle.
      if (Array.isArray(b.context)) {
        context = b.context
          .slice(0, 8)
          .map((c) => ({
            path: String((c as { path?: unknown })?.path ?? ""),
            content: String((c as { content?: unknown })?.content ?? "").slice(0, 12_000),
          }))
          .filter((c) => c.path && c.content);
      }
    }
  } catch {
    // fall through to the length check
  }
  if (issue.length < 8) return bad(400, "Ask a question or describe a change first.");
  if (issue.length > 20_000) return bad(400, "That's longer than we can read.");
  // No excerpts means no grounding — refusing beats a model guessing about unseen code.
  if (!context.length) {
    return bad(400, "Nothing to ground an answer in — ask from a repository session.");
  }

  try {
    const stream = await askLite(issue, context);
    return new Response(stream, {
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  } catch (e) {
    const msg = e instanceof Error && e.message === "rate_limited"
      ? "The free answering service hit its daily limit — try again later, or start the backend."
      : "The fallback answering service isn't reachable right now.";
    return bad(502, msg);
  }
}
