import type { NextRequest } from "next/server";
import { z } from "zod";
import { callBackend } from "@/lib/backend";
import { ok, toResponse } from "@/lib/route-helpers";

const SavedSchema = z.object({ ok: z.boolean(), kept: z.number() });

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body: unknown = await request.json();
    return ok(
      await callBackend(SavedSchema, `/api/jobs/${encodeURIComponent(id)}/triage`, {
        method: "POST",
        body,
      }),
    );
  } catch (e) {
    return toResponse(e);
  }
}
