import { NextResponse } from "next/server";
import { ApiError, statusFromKind } from "@/lib/errors";

/** The one place a thrown ApiError becomes a response the UI can branch on. */
export function toResponse(error: unknown): NextResponse {
  if (error instanceof ApiError) {
    return NextResponse.json(
      { kind: error.kind, message: error.message, detail: error.detail },
      { status: statusFromKind(error.kind) },
    );
  }
  // A malformed request body lands here (request.json() throws SyntaxError).
  if (error instanceof SyntaxError) {
    return NextResponse.json({ kind: "validation", message: "Malformed JSON body" }, { status: 400 });
  }
  const message = error instanceof Error ? error.message : "Unknown failure";
  return NextResponse.json({ kind: "backend_error", message }, { status: 502 });
}

export function ok(data: unknown): NextResponse {
  return NextResponse.json(data, { headers: { "cache-control": "no-store" } });
}
