"use client";

import { Button, Card, Flex, HStack, Stat, Text } from "@chakra-ui/react";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { postJson } from "./api";
import { formatMoney } from "./format";

export function UsageControl({
  used,
  unitCents,
  currency,
  attached,
}: {
  used: number;
  unitCents: number;
  currency: string;
  attached: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<number | null>(null);
  const [refreshing, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // One key per intended action. A failed request keeps its key, so clicking the same button again retries
  // that action (the server re-sends the same meter event identifier) instead of metering it twice.
  const unsent = useRef(new Map<number, string>());

  async function use(credits: number) {
    setPending(credits);
    setError(null);
    const idempotencyKey = unsent.current.get(credits) ?? crypto.randomUUID();
    unsent.current.set(credits, idempotencyKey);
    try {
      await postJson("/api/usage", { credits, idempotencyKey });
      unsent.current.delete(credits);
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? `${e.message} Click again to retry.` : "Could not record usage. Click again to retry.");
    } finally {
      setPending(null);
    }
  }

  return (
    <Card.Root variant="outline">
      <Card.Header>
        <Card.Title>AI credits</Card.Title>
        <Card.Description>
          {attached
            ? "Each click sends a Billing Meter event with an idempotency identifier."
            : "The first use attaches the metered add-on to your subscription."}
        </Card.Description>
      </Card.Header>
      <Card.Body gap="5">
        <Flex gap="8" wrap="wrap">
          <Stat.Root>
            <Stat.Label>Used this period</Stat.Label>
            <Stat.ValueText fontVariantNumeric="tabular-nums" opacity={refreshing ? 0.6 : 1}>
              {used.toLocaleString("en-US")}
            </Stat.ValueText>
          </Stat.Root>
          <Stat.Root>
            <Stat.Label>Estimated cost</Stat.Label>
            <Stat.ValueText fontVariantNumeric="tabular-nums" opacity={refreshing ? 0.6 : 1}>
              {formatMoney(used * unitCents, currency)}
            </Stat.ValueText>
            <Stat.HelpText>{formatMoney(unitCents, currency)} per credit, on your next invoice</Stat.HelpText>
          </Stat.Root>
        </Flex>
        <HStack gap="2">
          {[1, 10].map((n) => (
            <Button
              key={n}
              variant="outline"
              colorPalette="purple"
              loading={pending === n}
              disabled={pending !== null}
              onClick={() => void use(n)}
            >
              +{n} {n === 1 ? "credit" : "credits"}
            </Button>
          ))}
        </HStack>
        {error && (
          <Text textStyle="sm" color="fg.error" role="alert">
            {error}
          </Text>
        )}
      </Card.Body>
    </Card.Root>
  );
}
