import { and, count, eq, gt } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db, users } from "@/db";
import { getCurrentUser } from "@/lib/auth";
import { forbiddenCrossSite, isCrossSite } from "@/lib/request-guard";
import { SESSION_COOKIE, sessionCookieOptions, signSession } from "@/lib/session";
import { ensureCustomer } from "@/lib/sync";

export const runtime = "nodejs";

const WINDOW_MS = 60 * 60 * 1000;
const PER_IP_LIMIT = 10;
// Requests whose IP can't be trusted share one bucket, so header rotation buys nothing.
const UNTRUSTED_LIMIT = 30;
const MAX_TRACKED = 10_000;
const hits = new Map<string, number[]>();

/**
 * X-Forwarded-For is client-controlled unless a proxy we trust overwrites it. Vercel does (and sets
 * x-real-ip); elsewhere set TRUST_PROXY=1 only behind a proxy that replaces the header.
 */
function clientKey(req: Request): { key: string; limit: number } {
  const trusted = process.env.VERCEL === "1" || process.env.TRUST_PROXY === "1";
  if (trusted) {
    const ip = req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (ip) return { key: `ip:${ip}`, limit: PER_IP_LIMIT };
  }
  return { key: "untrusted", limit: UNTRUSTED_LIMIT };
}

/** In-memory sliding window (per server instance); the hourly cap below is the durable backstop. */
function rateLimit(key: string, limit: number, now = Date.now()): { ok: boolean; retryAfter: number } {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  hits.delete(key); // re-inserted below, so Map order stays least-recently-used first
  if (recent.length >= limit) {
    hits.set(key, recent);
    return { ok: false, retryAfter: Math.ceil((recent[0] + WINDOW_MS - now) / 1000) };
  }
  recent.push(now);
  hits.set(key, recent);
  for (const oldest of hits.keys()) {
    if (hits.size <= MAX_TRACKED) break;
    hits.delete(oldest);
  }
  return { ok: true, retryAfter: 0 };
}

/** Global cap across all IPs and instances, counted in the DB: each demo user also costs a Stripe customer. */
async function hourlyCapReached(): Promise<boolean> {
  const cap = Number(process.env.DEMO_HOURLY_CAP ?? 200);
  const [row] = await db
    .select({ n: count() })
    .from(users)
    .where(and(eq(users.isDemo, true), gt(users.createdAt, new Date(Date.now() - WINDOW_MS))));
  return (row?.n ?? 0) >= cap;
}

function wantsJson(req: Request) {
  return (req.headers.get("accept") ?? "").includes("application/json");
}

export async function POST(req: Request) {
  if (isCrossSite(req)) return forbiddenCrossSite();

  // Already signed in: keep that demo user (its subscription would be unreachable once the cookie is replaced).
  const existing = await getCurrentUser(req);
  if (existing) {
    return wantsJson(req)
      ? NextResponse.json({ user: { id: existing.id, name: existing.name, email: existing.email }, existing: true })
      : NextResponse.redirect(new URL("/dashboard", process.env.APP_URL ?? req.url), 303);
  }

  const { key, limit: max } = clientKey(req);
  const limit = rateLimit(key, max);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many demo accounts from this address. Try again later." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter) } },
    );
  }
  if (await hourlyCapReached()) {
    return NextResponse.json(
      { error: "The demo is busy right now. Try again in a little while." },
      { status: 429, headers: { "Retry-After": "600" } },
    );
  }

  const id = crypto.randomUUID();
  const number = 1000 + Math.floor(Math.random() * 9000);
  const [user] = await db
    .insert(users)
    .values({ id, name: `Demo Writer ${number}`, email: `demo-${id}@inkwell.test`, isDemo: true })
    .returning();

  // The Stripe customer is created on first login. If Stripe is briefly unavailable the user is still
  // signed in; checkout and the portal call ensureCustomer again.
  try {
    await ensureCustomer(user);
  } catch (error) {
    console.error("[demo] ensureCustomer failed:", (error as Error).message);
  }

  const token = await signSession(user.id);
  const res = wantsJson(req)
    ? NextResponse.json({ user: { id: user.id, name: user.name, email: user.email } })
    : NextResponse.redirect(new URL("/pricing", process.env.APP_URL ?? req.url), 303);
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  return res;
}
