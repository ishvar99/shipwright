import { NextResponse, type NextRequest } from "next/server";
import { GATE_COOKIE, gateToken } from "@/lib/gate";

/** Exchanges the password for the gate cookie. Never reachable when no password is set, so a
 * deployment without one cannot be tricked into minting a token. */
export async function POST(request: NextRequest) {
  const password = process.env.SHIPWRIGHT_PASSWORD;
  if (!password) return NextResponse.json({ detail: "Not found." }, { status: 404 });

  const form = await request.formData();
  const given = String(form.get("password") ?? "");
  const next = String(form.get("next") ?? "/app");
  // Only same-origin paths: an open redirect here would be handed out to everyone who
  // ever unlocks.
  const to = next.startsWith("/") && !next.startsWith("//") ? next : "/app";

  if (given !== password) {
    return NextResponse.redirect(
      new URL(`/unlock?next=${encodeURIComponent(to)}&bad=1`, request.url),
      { status: 303 },
    );
  }

  const res = NextResponse.redirect(new URL(to, request.url), { status: 303 });
  res.cookies.set(GATE_COOKIE, await gateToken(password), {
    httpOnly: true,
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}
