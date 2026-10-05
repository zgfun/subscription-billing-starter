"use client";

import { Alert, Box, Button, CloseButton, Dialog, Flex, Portal, Separator, Skeleton, Stack, Text } from "@chakra-ui/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ApiError, postJson } from "./api";
import { PortalButton } from "./portal-button";
import { formatDate, formatMoney, PLAN_LABEL } from "./format";

type Preview = {
  amountDue: number;
  currency: string;
  lines: { description: string | null; amount: number }[];
  prorationDate: number;
  nextPaymentAt: number | string | null;
  chargedNow?: boolean;
  dueAt?: string | null;
  trialing?: boolean;
  creditToBalance?: number;
};

function toIso(value: number | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  return value;
}

export function SwitchPlanDialog({ from, trialing }: { from: "monthly" | "yearly"; trialing: boolean }) {
  const to = from === "monthly" ? "yearly" : "monthly";
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [declined, setDeclined] = useState<{ invoiceUrl: string | null } | null>(null);

  async function loadPreview() {
    setLoading(true);
    setError(null);
    setDeclined(null);
    setPreview(null);
    try {
      setPreview(await postJson<Preview>("/api/plan/preview", { to }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the preview");
    } finally {
      setLoading(false);
    }
  }

  async function confirm() {
    if (!preview) return;
    setConfirming(true);
    setError(null);
    setDeclined(null);
    try {
      await postJson("/api/plan/change", { to, prorationDate: preview.prorationDate });
      setOpen(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change the plan");
      if (e instanceof ApiError && e.status === 402) {
        const url = e.data?.invoiceUrl;
        setDeclined({ invoiceUrl: typeof url === "string" ? url : null });
      }
    } finally {
      setConfirming(false);
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(details) => {
        setOpen(details.open);
        if (details.open) void loadPreview();
      }}
      placement="center"
      size="md"
    >
      <Dialog.Trigger asChild>
        <Button variant="outline">Switch to {to}</Button>
      </Dialog.Trigger>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>Switch to {PLAN_LABEL[to]}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Stack gap="4">
                <Text textStyle="sm" color="fg.muted">
                  {trialing
                    ? "You're on a free trial. Switching keeps your trial end date — nothing is charged until it ends."
                    : "Stripe credits the unused time on your current plan and charges the difference now. This is the exact invoice Stripe will create."}
                </Text>
                {loading && (
                  <Stack gap="2">
                    <Skeleton h="5" />
                    <Skeleton h="5" />
                    <Skeleton h="8" />
                  </Stack>
                )}
                {preview && (
                  <Box borderWidth="1px" rounded="md" p="4">
                    <Stack gap="3" as="ul" listStyleType="none">
                      {preview.lines.map((line, i) => (
                        <Flex as="li" key={i} justify="space-between" gap="4" textStyle="sm">
                          <Text color="fg.muted">{line.description ?? "Line item"}</Text>
                          <Text fontVariantNumeric="tabular-nums" whiteSpace="nowrap" color={line.amount < 0 ? "green.fg" : undefined}>
                            {formatMoney(line.amount, preview.currency)}
                          </Text>
                        </Flex>
                      ))}
                    </Stack>
                    <Separator my="3" />
                    <Flex justify="space-between" fontWeight="semibold">
                      <Text>
                        {preview.trialing ? `Due ${formatDate(toIso(preview.dueAt))}` : "Amount due now"}
                      </Text>
                      <Text fontVariantNumeric="tabular-nums">{formatMoney(Math.max(0, preview.amountDue), preview.currency)}</Text>
                    </Flex>
                    {(preview.creditToBalance ?? 0) > 0 && (
                      <Flex justify="space-between" textStyle="sm" mt="2" color="green.fg">
                        <Text>Credited to your balance for future invoices</Text>
                        <Text fontVariantNumeric="tabular-nums">{formatMoney(preview.creditToBalance ?? 0, preview.currency)}</Text>
                      </Flex>
                    )}
                    {preview.nextPaymentAt && (
                      <Text textStyle="xs" color="fg.muted" mt="2">
                        Next renewal on {formatDate(toIso(preview.nextPaymentAt))}.
                      </Text>
                    )}
                  </Box>
                )}
                {error && (
                  <Alert.Root status="error" size="sm">
                    <Alert.Indicator />
                    <Alert.Content>
                      <Alert.Title>{error}</Alert.Title>
                      {declined && (
                        <Flex gap="2" mt="2" wrap="wrap">
                          {declined.invoiceUrl && (
                            <Button asChild size="xs" colorPalette="red">
                              <a href={declined.invoiceUrl} target="_blank" rel="noreferrer">
                                Pay invoice
                              </a>
                            </Button>
                          )}
                          <PortalButton size="xs" variant="outline">
                            Update card
                          </PortalButton>
                        </Flex>
                      )}
                    </Alert.Content>
                  </Alert.Root>
                )}
              </Stack>
            </Dialog.Body>
            <Dialog.Footer>
              <Dialog.ActionTrigger asChild>
                <Button variant="ghost">Cancel</Button>
              </Dialog.ActionTrigger>
              <Button colorPalette="purple" onClick={() => void confirm()} disabled={!preview} loading={confirming}>
                Confirm switch
              </Button>
            </Dialog.Footer>
            <Dialog.CloseTrigger asChild>
              <CloseButton size="sm" />
            </Dialog.CloseTrigger>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
