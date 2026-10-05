"use client";

import { Alert, Badge, Box, Button, Card, Flex, Heading, HStack, List, SimpleGrid, Stack, Text } from "@chakra-ui/react";
import NextLink from "next/link";
import { useState } from "react";
import { ApiError, openPortal, startCheckout, startDemo } from "./api";
import { formatMoney } from "./format";
import { PortalButton } from "./portal-button";

export type PricingProps = {
  monthlyCents: number;
  yearlyCents: number;
  creditCents: number;
  currency: string;
  signedIn: boolean;
  subscribed: boolean;
  pastDue: boolean;
  trialAvailable: boolean;
  canceled: boolean;
};

type Plan = "monthly" | "yearly";

const FEATURES = [
  "Unlimited documents and folders",
  "Version history and focus mode",
  "Export to Markdown, PDF and DOCX",
  "Cancel any time from the billing portal",
];

function Check() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor" aria-hidden>
      <path d="M16.7 5.3a1 1 0 0 1 0 1.4l-8 8a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.4L8 12.6l7.3-7.3a1 1 0 0 1 1.4 0z" />
    </svg>
  );
}

export function PlanCards(props: PricingProps) {
  const { monthlyCents, yearlyCents, creditCents, currency, signedIn, subscribed, pastDue, trialAvailable, canceled } = props;
  const [pending, setPending] = useState<Plan | null>(null);
  const [error, setError] = useState<{ message: string; portal: boolean } | null>(null);
  const savings = monthlyCents * 12 - yearlyCents;

  async function subscribe(plan: Plan) {
    setPending(plan);
    setError(null);
    try {
      if (!signedIn) await startDemo();
      await startCheckout(plan);
    } catch (e) {
      const conflict = e instanceof ApiError && e.status === 409;
      setError({
        message: conflict
          ? "You already have an active subscription — change plans from the billing portal or your dashboard."
          : e instanceof Error
            ? e.message
            : "Could not start checkout",
        portal: conflict,
      });
      setPending(null);
    }
  }

  const plans: {
    id: Plan;
    name: string;
    price: string;
    cadence: string;
    badge: { label: string; palette: "purple" | "green" } | null;
    blurb: string;
    cta: string;
    featured: boolean;
  }[] = [
    {
      id: "monthly",
      name: "Pro Monthly",
      price: formatMoney(monthlyCents, currency, 0),
      cadence: "/ month",
      badge: trialAvailable ? { label: "14-day free trial", palette: "purple" } : null,
      blurb: trialAvailable
        ? "Try everything free for 14 days. You won't be charged until the trial ends."
        : "You've already used your free trial, so billing starts today.",
      cta: trialAvailable ? "Start free trial" : "Subscribe monthly",
      featured: true,
    },
    {
      id: "yearly",
      name: "Pro Yearly",
      price: formatMoney(yearlyCents, currency, 0),
      cadence: "/ year",
      badge: { label: "2 months free", palette: "green" },
      blurb: `Pay once a year and save ${formatMoney(savings, currency, 0)} compared to monthly. No trial — billed today.`,
      cta: "Subscribe yearly",
      featured: false,
    },
  ];

  return (
    <Stack gap="8">
      {canceled && (
        <Alert.Root status="info" variant="subtle">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Checkout canceled</Alert.Title>
            <Alert.Description>No charge was made. Pick a plan whenever you&apos;re ready.</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}
      {pastDue && (
        <Alert.Root status="error" variant="subtle">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Your last payment failed — update your card</Alert.Title>
            <Alert.Description>Stripe will retry automatically. Update your payment method to keep Inkwell Pro.</Alert.Description>
          </Alert.Content>
          <PortalButton size="sm" colorPalette="red" alignSelf="center">
            Update card
          </PortalButton>
        </Alert.Root>
      )}
      {subscribed && !pastDue && (
        <Alert.Root status="success" variant="subtle">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>You&apos;re subscribed</Alert.Title>
            <Alert.Description>
              Switch between monthly and yearly with a proration preview on your dashboard.
            </Alert.Description>
          </Alert.Content>
          <Button asChild size="sm" variant="outline" alignSelf="center">
            <NextLink href="/dashboard">Dashboard</NextLink>
          </Button>
        </Alert.Root>
      )}
      {error && (
        <Alert.Root status="error" variant="subtle">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{error.message}</Alert.Description>
          </Alert.Content>
          {error.portal && (
            <Button size="sm" variant="outline" alignSelf="center" onClick={() => void openPortal()}>
              Manage billing
            </Button>
          )}
        </Alert.Root>
      )}

      <SimpleGrid columns={{ base: 1, md: 2 }} gap="6">
        {plans.map((plan) => (
          <Card.Root
            key={plan.id}
            variant="outline"
            borderColor={plan.featured ? "purple.solid" : undefined}
            borderWidth={plan.featured ? "2px" : "1px"}
            shadow={plan.featured ? "md" : undefined}
          >
            <Card.Header gap="3">
              <Flex justify="space-between" align="center" gap="3" wrap="wrap">
                <Heading as="h2" size="lg">
                  {plan.name}
                </Heading>
                {plan.badge && (
                  <Badge colorPalette={plan.badge.palette} variant="solid" size="md">
                    {plan.badge.label}
                  </Badge>
                )}
              </Flex>
              <HStack align="baseline" gap="1">
                <Text fontSize="4xl" fontWeight="bold" letterSpacing="tight">
                  {plan.price}
                </Text>
                <Text color="fg.muted">{plan.cadence}</Text>
              </HStack>
              <Text textStyle="sm" color="fg.muted" minH={{ md: "10" }}>
                {plan.blurb}
              </Text>
            </Card.Header>
            <Card.Body>
              <List.Root gap="2" variant="plain" textStyle="sm">
                {FEATURES.map((f) => (
                  <List.Item key={f} alignItems="center">
                    <List.Indicator asChild color="green.fg">
                      <Check />
                    </List.Indicator>
                    {f}
                  </List.Item>
                ))}
              </List.Root>
            </Card.Body>
            <Card.Footer>
              {subscribed ? (
                <Button asChild w="full" variant="outline">
                  <NextLink href="/dashboard">Manage on dashboard</NextLink>
                </Button>
              ) : (
                <Button
                  w="full"
                  colorPalette="purple"
                  variant={plan.featured ? "solid" : "outline"}
                  loading={pending === plan.id}
                  loadingText={signedIn ? "Opening Checkout…" : "Creating demo user…"}
                  disabled={pending !== null && pending !== plan.id}
                  onClick={() => void subscribe(plan.id)}
                >
                  {plan.cta}
                </Button>
              )}
            </Card.Footer>
          </Card.Root>
        ))}
      </SimpleGrid>

      <Card.Root variant="subtle">
        <Card.Body>
          <Flex direction={{ base: "column", sm: "row" }} justify="space-between" gap="3" align={{ sm: "center" }}>
            <Box>
              <HStack gap="2" mb="1">
                <Text fontWeight="semibold">AI credits add-on</Text>
                <Badge variant="outline">Usage-based</Badge>
              </HStack>
              <Text textStyle="sm" color="fg.muted">
                Rewrite, summarize and brainstorm with AI. Metered through a Stripe Billing Meter and added to your next
                invoice — only pay for what you use.
              </Text>
            </Box>
            <Text fontWeight="semibold" whiteSpace="nowrap">
              {formatMoney(creditCents, currency)} / credit
            </Text>
          </Flex>
        </Card.Body>
      </Card.Root>

      <Text textStyle="xs" color="fg.subtle" textAlign="center">
        Prices in USD. Checkout is hosted by Stripe in test mode.{" "}
        {!signedIn && "Subscribing creates a throwaway demo account first."}
      </Text>
    </Stack>
  );
}
