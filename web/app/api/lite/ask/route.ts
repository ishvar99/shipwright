import { NextResponse, type NextRequest } from "next/server";
import { backendUp } from "@/lib/backend";
import { loadDemoWorkspace, isDemoRepo } from "@/lib/fixtures";
import { askLite, liteConfigured } from "@/lib/lite";
import { pickLiteContext } from "@/lib/lite-context";

// Streaming a full answer takes longer than Vercel's default function budget.
export const maxDuration = 60;

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
  try {
    const body: unknown = await request.json();
    if (body && typeof body === "object") {
      issue = String((body as { issue?: unknown }).issue ?? "").trim();
      repoId = String((body as { repoId?: unknown }).repoId ?? "");
    }
  } catch {
    // fall through to the length check
  }
  if (issue.length < 8) return bad(400, "Ask a question or describe a change first.");
  if (issue.length > 20_000) return bad(400, "That's longer than we can read.");

  // The recorded workspace is the only code lite mode can ground in — used only when the
  // question is about the recorded repository.
  let context: { path: string; content: string }[] = [];
  if (isDemoRepo(repoId)) {
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
