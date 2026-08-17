import type { NextRequest } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { callBackend } from "@/lib/backend";
import { JobSchema, type Job } from "@/lib/contracts";
import { ApiError } from "@/lib/errors";
import { ok, toResponse } from "@/lib/route-helpers";

function scrub(job: Job): Job {
  return { ...job, model: "", input_tokens: 0, output_tokens: 0 };
}

/** The two action kinds that write to GitHub; only these get a token attached. */
const NEEDS_TOKEN = new Set(["open_pr", "post_review"]);

async function accessToken(): Promise<string> {
  const result = await auth.api
    .getAccessToken({ body: { providerId: "github" }, headers: await headers() })
    .catch(() => null);
  const token = result?.accessToken;
  if (!token) throw new ApiError("validation", "Connect GitHub first.");
  return token;
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = (await request.json()) as Record<string, unknown>;
    // The browser never holds the token, so a `token` arriving from it is either a mistake or
    // an attempt to relay someone else's credential through us. Only this side supplies one.
    const kind = String(body.kind ?? "");
    const payload = { ...body, token: NEEDS_TOKEN.has(kind) ? await accessToken() : "" };
    return ok(
      scrub(
        await callBackend(JobSchema, `/api/jobs/${encodeURIComponent(id)}/actions`, {
          method: "POST",
          body: payload,
        }),
      ),
    );
  } catch (e) {
    return toResponse(e);
  }
}
