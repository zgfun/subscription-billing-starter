"use client";

import { Alert, Box, Button, Card, DataList, Flex, Heading, Stack, Text } from "@chakra-ui/react";
import NextLink from "next/link";
import { CheckoutPoller } from "./checkout-poller";
import { formatDate, formatMoney, PLAN_LABEL, statusOf, type EntitlementView } from "./format";
import { PortalButton } from "./portal-button";
import { StatusBadge } from "./status-badge";
import { SwitchPlanDialog } from "./switch-plan-dialog";
import { UsageControl } from "./usage-control";

export type DashboardProps = {
  userName: string;
  entitlement: EntitlementView;
  now: string;
  usage: { used: number; unitCents: number; currency: string };
  planCents: { monthly: number; yearly: number; currency: string };
  checkoutSessionId: string | null;
  trialAvailable: boolean;
};

export function DashboardView({
  userName,
  entitlement,
  now,
  usage,
  planCents,
  checkoutSessionId,
  trialAvailable,
}: DashboardProps) {
  const status = statusOf(entitlement);
  const hasPlan = status !== "none";
  const canUseCredits = entitlement.active && !entitlement.pastDue;

  let renewalLabel = "Next renewal";
  let renewalValue = formatDate(entitlement.periodEnd);
  if (status === "trialing") {
    renewalLabel = "First charge";
    renewalValue = formatDate(entitlement.trialEnd ?? entitlement.periodEnd);
  } else if (status === "trial_canceling") {
    renewalLabel = "Trial access until";
    renewalValue = formatDate(entitlement.trialEnd ?? entitlement.periodEnd);
  } else if (status === "canceling") {
    renewalLabel = "Access until";
  } else if (status === "past_due") {
    renewalLabel = "Payment";
    renewalValue = "Retry pending — update your card";
  }
  const canSwitch = entitlement.active && !entitlement.pastDue && !entitlement.cancelAtPeriodEnd;

  return (
    <Stack gap="8">
      <Flex justify="space-between" align={{ base: "flex-start", sm: "center" }} gap="3" direction={{ base: "column", sm: "row" }}>
        <Box>
          <Text textStyle="sm" color="fg.muted">
            Signed in as
          </Text>
          <Heading as="h1" size="2xl" letterSpacing="tight">
            {userName}
          </Heading>
        </Box>
        {hasPlan && <PortalButton variant="outline" />}
      </Flex>

      {checkoutSessionId && <CheckoutPoller sessionId={checkoutSessionId} ready={hasPlan} />}

      {entitlement.pastDue && (
        <Alert.Root status="error" variant="surface">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Your last payment failed — update your card</Alert.Title>
            <Alert.Description>
              Stripe will retry automatically. Update your payment method to keep access to Inkwell Pro.
            </Alert.Description>
          </Alert.Content>
          <PortalButton size="sm" colorPalette="red" alignSelf="center">
            Update card
          </PortalButton>
        </Alert.Root>
      )}

      <Card.Root variant="outline">
        <Card.Header>
          <Flex justify="space-between" align="center" gap="3" wrap="wrap">
            <Card.Title>Subscription</Card.Title>
            <StatusBadge entitlement={entitlement} now={now} />
          </Flex>
        </Card.Header>
        <Card.Body>
          {hasPlan && entitlement.plan ? (
            <Stack gap="6">
              <DataList.Root orientation="horizontal" gap="4" css={{ "--inkwell-label-w": { base: "8.5rem", sm: "11rem" } }}>
                <DataList.Item>
                  <DataList.ItemLabel minW="var(--inkwell-label-w)">Plan</DataList.ItemLabel>
                  <DataList.ItemValue fontWeight="medium">
                    {PLAN_LABEL[entitlement.plan]} ·{" "}
                    {formatMoney(planCents[entitlement.plan], planCents.currency, 0)} /{" "}
                    {entitlement.plan === "monthly" ? "month" : "year"}
                  </DataList.ItemValue>
                </DataList.Item>
                <DataList.Item>
                  <DataList.ItemLabel minW="var(--inkwell-label-w)">{renewalLabel}</DataList.ItemLabel>
                  <DataList.ItemValue>{renewalValue}</DataList.ItemValue>
                </DataList.Item>
                <DataList.Item>
                  <DataList.ItemLabel minW="var(--inkwell-label-w)">AI credits add-on</DataList.ItemLabel>
                  <DataList.ItemValue>{entitlement.hasUsageAddon ? "Attached" : "Not used yet"}</DataList.ItemValue>
                </DataList.Item>
              </DataList.Root>
              <Flex gap="3" wrap="wrap">
                {canSwitch && <SwitchPlanDialog from={entitlement.plan} trialing={entitlement.trialing} />}
                <PortalButton variant="ghost">
                  {entitlement.cancelAtPeriodEnd
                    ? "Renew subscription"
                    : entitlement.pastDue
                      ? "Update card"
                      : "Cancel or update card"}
                </PortalButton>
              </Flex>
            </Stack>
          ) : (
            <Stack gap="4" align="flex-start">
              <Text color="fg.muted">
                {trialAvailable
                  ? "You don't have an active plan. Start a 14-day free trial of Pro Monthly, or save with yearly."
                  : "You don't have an active plan. Pick a plan to resubscribe — monthly, or save with yearly."}
              </Text>
              <Button asChild colorPalette="purple">
                <NextLink href="/pricing">Choose a plan</NextLink>
              </Button>
            </Stack>
          )}
        </Card.Body>
      </Card.Root>

      {canUseCredits && (
        <UsageControl
          used={usage.used}
          unitCents={usage.unitCents}
          currency={usage.currency}
          attached={entitlement.hasUsageAddon}
        />
      )}
    </Stack>
  );
}
