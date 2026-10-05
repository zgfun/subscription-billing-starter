import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { DashboardView } from "@/components/billing/dashboard-view";
import { getUser, hasUsedTrial } from "@/components/billing/data";
import { toEntitlementView } from "@/components/billing/format";
import { SiteShell } from "@/components/billing/site-shell";
import { getPlanPrices } from "@/lib/catalog";
import { getEntitlement } from "@/lib/entitlement";
import { readSession } from "@/lib/session";
import { getUsageSummary } from "@/lib/usage";

export const metadata: Metadata = { title: "Dashboard · Inkwell" };

async function planCents() {
  try {
    const { monthly, yearly } = await getPlanPrices();
    return { monthly: monthly.unitAmount ?? 1200, yearly: yearly.unitAmount ?? 12000, currency: monthly.currency };
  } catch {
    return { monthly: 1200, yearly: 12000, currency: "usd" };
  }
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await readSession();
  if (!session) redirect("/");
  const [params, user, entitlement, usage, plans, usedTrial] = await Promise.all([
    searchParams,
    getUser(session.userId),
    getEntitlement(session.userId),
    getUsageSummary(session.userId),
    planCents(),
    hasUsedTrial(session.userId),
  ]);
  if (!user) redirect("/");

  const sessionId = params.checkout === "success" && typeof params.session_id === "string" ? params.session_id : null;

  return (
    <SiteShell signedIn>
      <DashboardView
        userName={user.name}
        entitlement={toEntitlementView(entitlement)}
        now={new Date().toISOString()}
        usage={{ used: usage.creditsThisPeriod, unitCents: usage.unitAmountCents, currency: usage.currency }}
        planCents={plans}
        checkoutSessionId={sessionId}
        trialAvailable={!usedTrial}
      />
    </SiteShell>
  );
}
