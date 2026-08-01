import { NextResponse, type NextRequest } from "next/server";
import { GATE_COOKIE, gateToken, sameToken } from "@/lib/gate";

/**
 * The password gate, when one is configured. Everything else — the landing page, the
 * benchmarks, the unlock form itself and Better Auth's own callback — stays public, so an
 * unconfigured deployment never sees this code do anything.
 */
export async function middleware(request: NextRequest) {
  const password = process.env.SHIPWRIGHT_PASSWORD;
  if (!password) return NextResponse.next();

  const cookie = request.cookies.get(GATE_COOKIE)?.value ?? "";
  if (sameToken(cookie, await gateToken(password))) return NextResponse.next();

  // An API call gets a status it can act on; a page gets the form.
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ detail: "This workspace is locked." }, { status: 401 });
  }
  const to = request.nextUrl.clone();
  to.pathname = "/unlock";
  // Where to return to, so unlocking does not dump you on the launcher having lost the link.
  to.search = `?next=${encodeURIComponent(request.nextUrl.pathname + request.nextUrl.search)}`;
  return NextResponse.redirect(to);
}

export const config = {
  matcher: ["/app/:path*", "/api/jobs/:path*", "/api/repos/:path*"],
};
