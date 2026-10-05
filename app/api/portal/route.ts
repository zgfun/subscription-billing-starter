import { withUser } from "@/lib/auth";
import { getStripe } from "@/lib/stripe";
import { ensureCustomer } from "@/lib/sync";

export const runtime = "nodejs";

export async function POST(req: Request) {
  return withUser(req, async (user) => {
    const customer = await ensureCustomer(user);
    const base = (process.env.APP_URL ?? new URL(req.url).origin).replace(/\/$/, "");
    const configuration = process.env.STRIPE_PORTAL_CONFIG_ID;
    const session = await getStripe().billingPortal.sessions.create({
      customer,
      return_url: `${base}/dashboard`,
      ...(configuration ? { configuration } : {}),
    });
    return Response.json({ url: session.url });
  }, { rateLimit: { name: "portal", perMinute: 10 } });
}
