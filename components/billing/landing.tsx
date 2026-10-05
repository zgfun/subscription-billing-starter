"use client";

import { Badge, Box, Button, Card, Code, Heading, HStack, Link, SimpleGrid, Stack, Text } from "@chakra-ui/react";
import NextLink from "next/link";
import { DemoButton } from "./demo-button";

const REPO_URL = "https://github.com/zgfun/subscription-billing-starter";

const POINTS = [
  {
    title: "Replay-safe webhooks",
    body: "Every event id is inserted into a ledger with a unique primary key before any work happens. A redelivery hits the conflict and returns 200 — no double upserts, no double emails.",
    tag: "INSERT … ON CONFLICT",
  },
  {
    title: "Fresh state, not payloads",
    body: "Subscription events trigger subscriptions.retrieve and an upsert from that snapshot, so out-of-order delivery is harmless. Side effects run after the response, guarded once-per-key.",
    tag: "after()",
  },
  {
    title: "DB-first entitlement",
    body: "Stripe owns the money; our database owns access. Every page and route asks getEntitlement(userId), which never calls Stripe in the request path.",
    tag: "getEntitlement",
  },
  {
    title: "Verified with test clocks",
    body: "A script creates a Stripe test clock, starts a 14-day trial, fast-forwards past it and replays every resulting event twice — for a good card and a failing one.",
    tag: "testHelpers.testClocks",
  },
  {
    title: "Proration preview",
    body: "Switching between monthly and yearly shows the exact invoice Stripe would create via invoices.createPreview, then applies it with the same proration date.",
    tag: "createPreview",
  },
  {
    title: "Metered add-on",
    body: "AI credits are reported to a Stripe Billing Meter with an idempotency identifier stored locally first, so a retried request never bills twice.",
    tag: "billing.meterEvents",
  },
];

export function Landing({ signedIn, handledEvents }: { signedIn: boolean; handledEvents: number | null }) {
  return (
    <Stack gap={{ base: "14", md: "20" }}>
      <Stack gap="6" maxW="3xl">
        <HStack gap="2" wrap="wrap">
          <Badge colorPalette="purple" variant="subtle" size="lg">
            Next.js 16 + Stripe Billing
          </Badge>
          {handledEvents !== null && (
            <Badge variant="outline" size="lg">
              {handledEvents} webhook event types, all replay-safe
            </Badge>
          )}
        </HStack>
        <Heading as="h1" size={{ base: "4xl", md: "6xl" }} letterSpacing="tight" lineHeight="1.05">
          Write without limits.
          <Box as="span" display="block" color="purple.fg">
            Bill without surprises.
          </Box>
        </Heading>
        <Text textStyle={{ base: "md", md: "lg" }} color="fg.muted" maxW="2xl">
          Inkwell is a fictional writing app used to demonstrate subscription billing done correctly: a 14-day trial,
          monthly and yearly plans with a proration preview, the customer portal, dunning, and a metered AI-credits
          add-on.
        </Text>
        <Stack direction={{ base: "column", sm: "row" }} gap="3" align={{ base: "stretch", sm: "flex-start" }}>
          {signedIn ? (
            <Button asChild colorPalette="purple" size="lg">
              <NextLink href="/dashboard">Open your dashboard</NextLink>
            </Button>
          ) : (
            <DemoButton />
          )}
          <Button asChild variant="outline" size="lg">
            <NextLink href="/pricing">See pricing</NextLink>
          </Button>
        </Stack>
        <Text textStyle="sm" color="fg.subtle">
          One click creates a throwaway demo account. No password, no email — nothing real is charged.
        </Text>
      </Stack>

      <Stack gap="6">
        <Stack gap="2">
          <Heading as="h2" size="2xl">
            What this demonstrates
          </Heading>
          <Text color="fg.muted" maxW="2xl">
            For engineers reviewing the code: the interesting parts are the ones you don&apos;t see in the UI.
          </Text>
        </Stack>
        <SimpleGrid columns={{ base: 1, md: 2, lg: 3 }} gap="4">
          {POINTS.map((p) => (
            <Card.Root key={p.title} variant="outline" size="sm">
              <Card.Body gap="3">
                <Card.Title>{p.title}</Card.Title>
                <Text textStyle="sm" color="fg.muted">
                  {p.body}
                </Text>
                <Box>
                  <Code size="sm" variant="surface">
                    {p.tag}
                  </Code>
                </Box>
              </Card.Body>
            </Card.Root>
          ))}
        </SimpleGrid>
        <HStack gap="4" wrap="wrap" textStyle="sm">
          <Link href={REPO_URL} target="_blank" rel="noreferrer" colorPalette="purple" color="colorPalette.fg">
            Read the source on GitHub →
          </Link>
          <Link asChild colorPalette="purple" color="colorPalette.fg">
            <NextLink href="/admin">Inspect the webhook ledger →</NextLink>
          </Link>
        </HStack>
      </Stack>
    </Stack>
  );
}
