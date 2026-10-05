import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db, users, type User } from "@/db";
import { slidingWindow, tooManyRequests } from "./rate-limit";
import { forbiddenCrossSite, isCrossSite } from "./request-guard";
import { readSession, readSessionFromRequest } from "./session";

export class UnauthorizedError extends Error {
  constructor() {
    super("Not signed in");
    this.name = "UnauthorizedError";
  }
}

async function loadUser(userId: string | undefined): Promise<User | null> {
  if (!userId) return null;
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return user ?? null;
}

/** The signed-in user, or null. Pass the Request in route handlers; omit it in Server Components. */
export async function getCurrentUser(req?: Request): Promise<User | null> {
  const session = req ? await readSessionFromRequest(req) : await readSession();
  return loadUser(session?.userId);
}

/**
 * Route handlers: `await requireUser(req)` throws UnauthorizedError (turn it into a 401 with `unauthorized()`).
 * Server Components: `await requireUser()` redirects to "/" when there is no valid session.
 */
export async function requireUser(req?: Request): Promise<User> {
  const user = await getCurrentUser(req);
  if (user) return user;
  if (req) throw new UnauthorizedError();
  redirect("/");
}

export function unauthorized(): Response {
  return Response.json({ error: "Not signed in" }, { status: 401 });
}

const perMinute = slidingWindow(60_000);

export type WithUserOptions = {
  /** Per-user requests per minute for this route, keyed by `name`. Use it on every route that calls Stripe. */
  rateLimit?: { name: string; perMinute: number };
};

/**
 * Wraps a route handler: 403 for cross-site writes, 401 for missing sessions, 429 over the per-user rate
 * limit, 502 for Stripe errors, 500 otherwise.
 */
export async function withUser(
  req: Request,
  handler: (user: User) => Promise<Response>,
  options: WithUserOptions = {},
): Promise<Response> {
  // CSRF defence in depth on top of the SameSite=Lax session cookie.
  if (req.method !== "GET" && req.method !== "HEAD" && isCrossSite(req)) return forbiddenCrossSite();
  try {
    const user = await requireUser(req);
    if (options.rateLimit) {
      const { name, perMinute: max } = options.rateLimit;
      const limit = perMinute(`${name}:${user.id}`, max);
      if (!limit.ok) return tooManyRequests("Too many requests. Slow down and try again shortly.", limit.retryAfter);
    }
    return await handler(user);
  } catch (error) {
    if (error instanceof UnauthorizedError) return unauthorized();
    const err = error as { type?: unknown; message?: unknown; code?: unknown };
    if (typeof err.type === "string" && err.type.startsWith("Stripe")) {
      console.error(`[stripe] ${err.type}: ${String(err.message)}`);
      // Stripe messages can carry object ids or a masked key; only card declines are worth showing verbatim.
      const message =
        err.type === "StripeCardError" && typeof err.message === "string"
          ? err.message
          : "Billing provider error, please try again.";
      return Response.json({ error: message, code: typeof err.code === "string" ? err.code : undefined }, { status: 502 });
    }
    console.error(error);
    return Response.json({ error: "Something went wrong" }, { status: 500 });
  }
}

/** The JSON body, or null. Non-JSON content types are refused, so a cross-site text/plain form can't post JSON. */
export async function readJson(req: Request): Promise<unknown> {
  if (!(req.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) return null;
  try {
    return await req.json();
  } catch {
    return null;
  }
}
