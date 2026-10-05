import type { Metadata } from "next";
import { Heading, Stack, Text } from "@chakra-ui/react";
import { PlanCards } from "@/components/billing/plan-cards";
import { SiteShell } from "@/components/billing/site-shell";
import { hasUsedTrial } from "@/components/billing/data";
import { getPlanPrices } from "@/lib/catalog";
import { getEntitlement } from "@/lib/entitlement";
import { readSession } from "@/lib/session";

export const metadata: Metadata = { title: "Pricing · Inkwell" };

const FALLBACK = { monthly: 1200, yearly: 12000, credit: 2 };

async function loadPrices() {
  try {
    const { monthly, yearly, credits } = await getPlanPrices();
    return {
      monthlyCents: monthly.unitAmount ?? FALLBACK.monthly,
      yearlyCents: yearly.unitAmount ?? FALLBACK.yearly,
      creditCents: credits?.unitAmount ?? FALLBACK.credit,
      currency: monthly.currency ?? "usd",
    };
  } catch (error) {
    console.error("pricing: falling back to static prices", error instanceof Error ? error.message : error);
    return { monthlyCents: FALLBACK.monthly, yearlyCents: FALLBACK.yearly, creditCents: FALLBACK.credit, currency: "usd" };
  }
}

export default async function PricingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ canceled }, session, prices] = await Promise.all([searchParams, readSession(), loadPrices()]);
  let subscribed = false;
  let pastDue = false;
  let trialAvailable = true;
  if (session) {
    const [entitlement, usedTrial] = await Promise.all([getEntitlement(session.userId), hasUsedTrial(session.userId)]);
    subscribed = entitlement.active || entitlement.pastDue;
    pastDue = entitlement.pastDue;
    trialAvailable = !usedTrial;
  }
  return (
    <SiteShell signedIn={!!session}>
      <Stack gap="10">
        <Stack gap="3" textAlign="center" align="center">
          <Heading as="h1" size={{ base: "3xl", md: "4xl" }} letterSpacing="tight">
            Simple pricing for serious writers
          </Heading>
          <Text color="fg.muted" maxW="xl">
            {trialAvailable
              ? "One plan, two ways to pay. Start with a 14-day free trial on monthly, or save two months by paying yearly."
              : "One plan, two ways to pay. Go monthly, or save two months by paying yearly."}
          </Text>
        </Stack>
        <PlanCards
          {...prices}
          signedIn={!!session}
          subscribed={subscribed}
          pastDue={pastDue}
          trialAvailable={trialAvailable}
          canceled={canceled === "1"}
        />
      </Stack>
    </SiteShell>
  );
}
