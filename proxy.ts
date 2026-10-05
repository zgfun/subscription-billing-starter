import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/lib/session";

// Optimistic check only (signature + expiry, no DB): every protected route handler and page
// calls requireUser() again, which also confirms the user still exists.
export async function proxy(request: NextRequest) {
  const session = await verifySession(request.cookies.get(SESSION_COOKIE)?.value);
  if (session) return NextResponse.next();
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  return NextResponse.redirect(new URL("/", request.url));
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/api/checkout/:path*",
    "/api/portal/:path*",
    "/api/plan/:path*",
    "/api/usage/:path*",
    "/api/me/:path*",
  ],
};
