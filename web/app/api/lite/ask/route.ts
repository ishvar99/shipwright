import { NextResponse, type NextRequest } from "next/server";
import { backendUp } from "@/lib/backend";
import { loadDemoWorkspace, isDemoRepo } from "@/lib/fixtures";
import { askLite, liteConfigured } from "@/lib/lite";
import { pickLiteContext } from "@/lib/lite-context";

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
  if (!liteConfigured()) {
    return bad(503, "Lite answers aren't configured on this deployment.");
  }
  if (await backendUp()) {
    return bad(409, "The backend is up — use a normal session.");
  }

  let issue = "";
  let repoId = "";
  let given: { path: string; content: string }[] = [];
  try {
    const body: unknown = await request.json();
    if (body && typeof body === "object") {
      const b = body as { issue?: unknown; repoId?: unknown; context?: unknown };
      issue = String(b.issue ?? "").trim();
      repoId = String(b.repoId ?? "");
      // A local session has already retrieved and ranked; it sends the excerpts it chose
      // rather than making this route guess from the recorded bundle.
      if (Array.isArray(b.context)) {
        given = b.context
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

  // The recorded workspace is the only code lite mode can ground in — used only when the
  // question is about the recorded repository.
  let context: { path: string; content: string }[] = given;
  if (!context.length && isDemoRepo(repoId)) {
    const w = await loadDemoWorkspace();
    context = pickLiteContext(
      Object.entries(w.files).map(([path, f]) => ({ path, content: f.content })),
      issue,
    );
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
