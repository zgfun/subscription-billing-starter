import { NextResponse } from "next/server";
import { forbiddenCrossSite, isCrossSite } from "@/lib/request-guard";
import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/session";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (isCrossSite(req)) return forbiddenCrossSite();
  const json = (req.headers.get("accept") ?? "").includes("application/json");
  const res = json
    ? NextResponse.json({ ok: true })
    : NextResponse.redirect(new URL("/", process.env.APP_URL ?? req.url), 303);
  res.cookies.set(SESSION_COOKIE, "", sessionCookieOptions(0));
  return res;
}
