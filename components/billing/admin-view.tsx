"use client";

import { Badge, Box, Card, Code, Heading, SimpleGrid, Stack, Stat, Table, Text } from "@chakra-ui/react";
import { formatDateTime } from "./format";

export type AdminProps = {
  handledEvents: string[];
  stats: { received: number; processed: number; failed: number; pending: number };
  rows: { id: string; type: string; receivedAt: string; processedAt: string | null; failed: boolean }[];
};

function truncateId(id: string): string {
  return id.length > 18 ? `${id.slice(0, 10)}…${id.slice(-6)}` : id;
}

function RowStatus({ row, handled }: { row: AdminProps["rows"][number]; handled: boolean }) {
  if (row.failed) {
    return (
      <Badge colorPalette="red" variant="subtle">
        Failed
      </Badge>
    );
  }
  if (!handled) return <Badge variant="outline">Ignored</Badge>;
  if (!row.processedAt) return <Badge colorPalette="yellow" variant="subtle">Processing</Badge>;
  return <Badge colorPalette="green" variant="subtle">Processed</Badge>;
}

export function AdminView({ handledEvents, stats, rows }: AdminProps) {
  const handled = new Set(handledEvents);
  const tiles = [
    { label: "Handled event types", value: handledEvents.length, help: "every one replay-safe" },
    { label: "Events received", value: stats.received, help: "unique event ids in the ledger" },
    { label: "Processed", value: stats.processed, help: `${stats.pending} in flight` },
    { label: "Failed", value: stats.failed, help: "retried by Stripe on redelivery" },
  ];

  return (
    <Stack gap="8">
      <Stack gap="2">
        <Heading as="h1" size="2xl" letterSpacing="tight">
          Webhook ledger
        </Heading>
        <Text color="fg.muted" maxW="3xl">
          Every Stripe event id is inserted into <Code size="sm">stripe_events</Code> before any work happens. The primary
          key is the idempotency guard: a redelivered event conflicts on insert and is acknowledged without being
          processed again, so duplicates never create a second row. Read-only, ids only.
        </Text>
      </Stack>

      <SimpleGrid columns={{ base: 2, md: 4 }} gap="4">
        {tiles.map((t) => (
          <Card.Root key={t.label} variant="outline" size="sm">
            <Card.Body>
              <Stat.Root>
                <Stat.Label>{t.label}</Stat.Label>
                <Stat.ValueText fontVariantNumeric="tabular-nums">{t.value.toLocaleString("en-US")}</Stat.ValueText>
                <Stat.HelpText>{t.help}</Stat.HelpText>
              </Stat.Root>
            </Card.Body>
          </Card.Root>
        ))}
      </SimpleGrid>

      <Box>
        <Text textStyle="sm" fontWeight="medium" mb="2">
          Handled types
        </Text>
        <Box display="flex" flexWrap="wrap" gap="2">
          {handledEvents.map((t) => (
            <Code key={t} size="sm" variant="surface">
              {t}
            </Code>
          ))}
        </Box>
      </Box>

      <Stack gap="3">
        <Heading as="h2" size="lg">
          Last {rows.length} events
        </Heading>
        {rows.length === 0 ? (
          <Card.Root variant="subtle">
            <Card.Body>
              <Text color="fg.muted" textStyle="sm">
                No events yet. Start a checkout, or run <Code size="sm">stripe trigger invoice.paid</Code> with{" "}
                <Code size="sm">stripe listen</Code> forwarding to <Code size="sm">/api/stripe/webhook</Code>.
              </Text>
            </Card.Body>
          </Card.Root>
        ) : (
          <Table.ScrollArea borderWidth="1px" rounded="md">
            <Table.Root size="sm" stickyHeader>
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>Event</Table.ColumnHeader>
                  <Table.ColumnHeader>Type</Table.ColumnHeader>
                  <Table.ColumnHeader>Received</Table.ColumnHeader>
                  <Table.ColumnHeader>Processed</Table.ColumnHeader>
                  <Table.ColumnHeader>Status</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {rows.map((row) => (
                  <Table.Row key={row.id}>
                    <Table.Cell>
                      <Code size="sm" variant="plain" title={row.id}>
                        {truncateId(row.id)}
                      </Code>
                    </Table.Cell>
                    <Table.Cell whiteSpace="nowrap">{row.type}</Table.Cell>
                    <Table.Cell whiteSpace="nowrap" color="fg.muted">
                      {formatDateTime(row.receivedAt)}
                    </Table.Cell>
                    <Table.Cell whiteSpace="nowrap" color="fg.muted">
                      {row.processedAt ? formatDateTime(row.processedAt) : "—"}
                    </Table.Cell>
                    <Table.Cell>
                      <RowStatus row={row} handled={handled.has(row.type)} />
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </Table.ScrollArea>
        )}
        <Text textStyle="xs" color="fg.subtle">
          Duplicate deliveries are rejected by the primary key and are deliberately not stored, so they aren&apos;t counted
          here. Failed rows (handler or email) are retried on Stripe&apos;s redelivery and by a sweep after each webhook.
        </Text>
      </Stack>
    </Stack>
  );
}
