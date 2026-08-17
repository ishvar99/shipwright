import type { NextRequest } from "next/server";
import { headers } from "next/headers";
import { auth, githubConfigured } from "@/lib/auth";
import { callBackend } from "@/lib/backend";
import { JobSchema } from "@/lib/contracts";
import type { Job } from "@/lib/contracts";
import { ApiError } from "@/lib/errors";
import { ok, toResponse } from "@/lib/route-helpers";

/** The engine is behind this API. Blank its traces so the network tab shows nothing either. */
function scrub(job: Job): Job {
  return { ...job, model: "", input_tokens: 0, output_tokens: 0 };
}

export async function POST(request: NextRequest) {
  try {
    if (!githubConfigured) throw new ApiError("not_found", "GitHub isn't configured here.");
    const body = (await request.json()) as { repo_id?: unknown; number?: unknown };
    const repoId = String(body.repo_id ?? "");
    const number = Number(body.number ?? 0);
    if (!repoId || !Number.isInteger(number) || number < 1) {
      throw new ApiError("validation", "That doesn't look like a pull request reference.");
    }
    // Attached server-side. A token in the client's request body would put it in the
    // browser's network tab and in any proxy log between here and the engine.
    const result = await auth.api
      .getAccessToken({ body: { providerId: "github" }, headers: await headers() })
      .catch(() => null);
    const token = result?.accessToken;
    if (!token) throw new ApiError("validation", "Connect GitHub first.");

    return ok(
      scrub(
        await callBackend(JobSchema, "/api/reviews", {
          method: "POST",
          body: { repo_id: repoId, number, token },
        }),
      ),
    );
  } catch (e) {
    return toResponse(e);
  }
}
