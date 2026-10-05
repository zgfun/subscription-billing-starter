/**
 * In-memory sliding-window rate limiter (per server instance). Good enough to stop a single script from
 * hammering the Stripe-backed routes; durable caps (e.g. the demo hourly cap) live in the DB.
 */
export function slidingWindow(windowMs: number, maxTracked = 10_000) {
  const hits = new Map<string, number[]>();
  return function check(key: string, limit: number, now = Date.now()): { ok: boolean; retryAfter: number } {
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    hits.delete(key); // re-inserted below, so Map order stays least-recently-used first
    if (recent.length >= limit) {
      hits.set(key, recent);
      return { ok: false, retryAfter: Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000)) };
    }
    recent.push(now);
    hits.set(key, recent);
    for (const oldest of hits.keys()) {
      if (hits.size <= maxTracked) break;
      hits.delete(oldest);
    }
    return { ok: true, retryAfter: 0 };
  };
}

export function tooManyRequests(message: string, retryAfter: number): Response {
  return Response.json({ error: message }, { status: 429, headers: { "Retry-After": String(retryAfter) } });
}
