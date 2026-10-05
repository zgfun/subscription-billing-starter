/**
 * Login-CSRF guard for cookie-setting POSTs that need no session (/api/demo, /api/logout).
 * Browsers always send Sec-Fetch-Site / Origin on cross-site form posts and pages can't forge them.
 */
export function isCrossSite(req: Request): boolean {
  if (req.headers.get("sec-fetch-site") === "cross-site") return true;
  const origin = req.headers.get("origin");
  if (!origin) return false;
  const allowed = new Set([new URL(req.url).origin]);
  if (process.env.APP_URL) allowed.add(new URL(process.env.APP_URL).origin);
  return !allowed.has(origin);
}

export function forbiddenCrossSite(): Response {
  return Response.json({ error: "Cross-site request refused" }, { status: 403 });
}
