import type { NextRequest } from "next/server";
import { headers } from "next/headers";
import { callBackend } from "@/lib/backend";
import { auth, githubConfigured } from "@/lib/auth";
import { RepoSchema } from "@/lib/contracts";
import { ok, toResponse } from "@/lib/route-helpers";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    // A private repo needs a credential the browser must never hold. The token is attached
    // here, server-side, and only for a GitHub URL the user just picked.
    const token = body.private && githubConfigured ? await accessToken() : "";
    // `private` is a BFF-only hint; the backend takes a token or nothing.
    const forwarded = { url: body.url ?? "", path: body.path ?? "" };
    return ok(
      await callBackend(RepoSchema, "/api/repos/import", {
        method: "POST",
        body: token ? { ...forwarded, token } : forwarded,
      }),
    );
  } catch (e) {
    return toResponse(e);
  }
}

async function accessToken(): Promise<string> {
  const result = await auth.api
    .getAccessToken({ body: { providerId: "github" }, headers: await headers() })
    .catch(() => null);
  return result?.accessToken ?? "";
}
