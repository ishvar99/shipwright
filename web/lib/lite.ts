import { backendUp } from "@/lib/backend";

/** One excerpt the model may ground in: already retrieved and ranked by the caller. */
export type LiteFile = { path: string; content: string };

/**
 * Lite mode: answering without the backend.
 *
 * The frontend deploys free on Vercel; the real engine runs on a machine that may be off or
 * not deployed yet. When it is unreachable, questions fall back to a hosted free-tier model
 * behind THIS server — the provider, key and model live in env and never reach the browser,
 * exactly as the local engine never does. Server-only module.
 *
 * Provider-agnostic on purpose: every serious free tier (Groq, Gemini's OpenAI endpoint,
 * OpenRouter, Cerebras, Mistral) speaks the OpenAI chat-completions dialect, so swapping
 * providers is an env edit, not a deploy. Plain fetch — no SDK dependency.
 */

/** Long enough for a cold free-tier model to start; short enough that a dead host is obvious. */
const HEADERS_MS = 30_000;
/** Between tokens. Generation that has stalled this long is not coming back. */
const IDLE_MS = 30_000;

export function liteConfigured(): boolean {
  return Boolean(process.env.FALLBACK_API_URL && process.env.FALLBACK_API_KEY);
}

/** Which engine answers a request: ours when it is up, the fallback when it is not. */
export async function liteEligible(): Promise<boolean> {
  if (!liteConfigured()) return false;
  return !(await backendUp());
}

/** The grounding rules are the whole feature.
 *
 * Measured: asked how MSAL's token cache evicts entries, the real backend answered "the code
 * does not contain eviction logic" — correct. Lite mode, given only the files that happened to
 * mention the cache, answered "it uses an LRU policy" — invented, because token_cache.py is
 * not in the recorded bundle at all and nothing told the model to admit that. A confident
 * wrong answer is worse than no fallback, so the prompt names the evidence boundary and makes
 * "I can't see that" the required response outside it. */
const SYSTEM = `You are Shipwright's lite mode. Shipwright normally answers from a fully
indexed repository, but its analysis backend is not reachable right now. You have only the
excerpt files listed below — no index, no search, no ability to open anything else.

Grounding rules, in priority order:
1. If the excerpts do not contain what was asked, say so plainly and name what you would need
   to see. Do NOT fall back on how libraries of this kind usually work. A confident guess is
   the worst possible answer here.
2. Never state that the code does something unless you can point at the line in an excerpt
   that shows it. Cite paths like msal/application.py.
3. Excerpts may be truncated mid-file. Absence from an excerpt is not evidence of absence from
   the repository — say "not in the part I can see", never "the code does not do this".
4. General programming questions that are not about this repository can be answered normally.
5. You cannot modify, apply or test code here. For a change request, describe what it would
   look like and note that applying and verifying it needs the full backend.
6. Never mention which AI model or provider you are. You are simply "Shipwright (lite)".`;

/** Streams the answer as plain text. Provider SSE is parsed HERE so nothing provider-shaped
 * (model names, ids, usage) ever crosses to the browser. */
export async function askLite(issue: string, context: LiteFile[]): Promise<ReadableStream> {
  const base = (process.env.FALLBACK_API_URL ?? "").replace(/\/$/, "");
  const body = {
    model: process.env.FALLBACK_MODEL ?? "",
    stream: true,
    temperature: 0.2,
    messages: [
      { role: "system", content: SYSTEM },
      ...(context.length
        ? [
            {
              role: "system" as const,
              // The manifest first: without it the model cannot tell "absent from the repo"
              // from "absent from the handful of files I was handed".
              content:
                `These are the ONLY files you can see (${context.length} of them). Anything ` +
                `else in the repository is invisible to you:\n` +
                context.map((f) => `- ${f.path}`).join("\n") +
                `\n\n` +
                context
                  .map((f) => `Excerpt of ${f.path}:\n\`\`\`\n${f.content}\n\`\`\``)
                  .join("\n\n"),
            },
          ]
        : []),
      { role: "user", content: issue },
    ],
  };

  // Two timeouts, not one. `AbortSignal.timeout` covers the whole fetch INCLUDING the body,
  // so a single 55s budget killed healthy answers mid-sentence once generation ran long —
  // a slow stream is not a hung one. This waits `HEADERS_MS` for the response to start, then
  // switches to an idle timer that every chunk resets.
  const abort = new AbortController();
  let idle = setTimeout(() => abort.abort(new Error("upstream_silent")), HEADERS_MS);
  const resetIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(() => abort.abort(new Error("upstream_silent")), IDLE_MS);
  };

  let res: Response;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.FALLBACK_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: abort.signal,
    });
  } catch {
    clearTimeout(idle);
    throw new Error(abort.signal.aborted ? "upstream_silent" : "upstream_unreachable");
  }
  resetIdle();
  if (!res.ok || !res.body) {
    clearTimeout(idle);
    // 429 is the one failure worth naming: free tiers meter by the day.
    throw new Error(res.status === 429 ? "rate_limited" : `upstream_${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  return new ReadableStream({
    async pull(controller) {
      let done: boolean;
      let value: Uint8Array | undefined;
      try {
        ({ done, value } = await reader.read());
      } catch {
        // The upstream cut out mid-answer. Close cleanly rather than erroring the response:
        // the browser keeps every token it already rendered, which is worth more than a
        // truncated stream turning into a bare "network error".
        clearTimeout(idle);
        controller.close();
        return;
      }
      if (done) {
        clearTimeout(idle);
        controller.close();
        return;
      }
      resetIdle();
      buffer += decoder.decode(value, { stream: true });
      // SSE frames split on blank lines; a chunk can end mid-frame, so keep the tail.
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          try {
            const delta = JSON.parse(data)?.choices?.[0]?.delta?.content;
            if (typeof delta === "string" && delta) controller.enqueue(encoder.encode(delta));
          } catch {
            // a malformed frame is dropped, not fatal
          }
        }
      }
    },
    cancel(reason) {
      clearTimeout(idle);
      void reader.cancel(reason);
    },
  });
}
