import { backendUp } from "@/lib/backend";
import type { LiteFile } from "@/lib/lite-context";

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

export function liteConfigured(): boolean {
  return Boolean(process.env.FALLBACK_API_URL && process.env.FALLBACK_API_KEY);
}

/** Which engine answers a request: ours when it is up, the fallback when it is not. */
export async function liteEligible(): Promise<boolean> {
  if (!liteConfigured()) return false;
  return !(await backendUp());
}

const SYSTEM = `You are Shipwright's lite mode. Shipwright normally answers from a fully
indexed repository, but its analysis backend is not reachable right now, so you are answering
with general knowledge plus at most a few recorded example files provided below.

Rules:
- Answer questions about code and programming directly and concretely.
- If example files are provided, ground your answer in them and cite paths like msal/application.py.
- You cannot modify, apply or test code in this mode. If asked for a change, explain where it
  would go and what it would look like, and note that applying it needs the full backend.
- Never mention which AI model or provider you are. You are simply "Shipwright (lite)".`;

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
              content: context
                .map((f) => `Recorded file ${f.path}:\n\`\`\`\n${f.content}\n\`\`\``)
                .join("\n\n"),
            },
          ]
        : []),
      { role: "user", content: issue },
    ],
  };

  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.FALLBACK_API_KEY}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(55_000),
  });
  if (!res.ok || !res.body) {
    // 429 is the one failure worth naming: free tiers meter by the day.
    throw new Error(res.status === 429 ? "rate_limited" : `upstream_${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
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
      void reader.cancel(reason);
    },
  });
}
