"use client";

import { Alert, Button, Spinner } from "@chakra-ui/react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getJson } from "./api";

type Me = { entitlement?: { plan: string | null; active: boolean; pastDue: boolean } };

const ATTEMPTS = 6;
const INTERVAL_MS = 2000;

export function CheckoutPoller({ sessionId, ready }: { sessionId: string; ready: boolean }) {
  const router = useRouter();
  const [polled, setState] = useState<"waiting" | "done" | "timeout">("waiting");
  const state = ready ? "done" : polled;

  useEffect(() => {
    if (ready) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function attempt(n: number) {
      try {
        const me = await getJson<Me>(`/api/me?sync=${encodeURIComponent(sessionId)}`);
        if (cancelled) return;
        if (me.entitlement?.plan && (me.entitlement.active || me.entitlement.pastDue)) {
          setState("done");
          router.refresh();
          return;
        }
      } catch {
        if (cancelled) return;
      }
      if (n + 1 >= ATTEMPTS) setState("timeout");
      else timer = setTimeout(() => void attempt(n + 1), INTERVAL_MS);
    }
    void attempt(0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [ready, router, sessionId]);

  if (state === "done") {
    return (
      <Alert.Root status="success" variant="subtle">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>Welcome to Inkwell Pro</Alert.Title>
          <Alert.Description>Your subscription is confirmed. Happy writing.</Alert.Description>
        </Alert.Content>
        <Button size="sm" variant="ghost" alignSelf="center" onClick={() => router.replace("/dashboard")}>
          Dismiss
        </Button>
      </Alert.Root>
    );
  }
  if (state === "timeout") {
    return (
      <Alert.Root status="warning" variant="subtle">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>Still confirming your payment</Alert.Title>
          <Alert.Description>
            Stripe hasn&apos;t told us yet. The webhook usually lands within seconds — refresh in a moment.
          </Alert.Description>
        </Alert.Content>
        <Button size="sm" variant="outline" alignSelf="center" onClick={() => window.location.reload()}>
          Refresh
        </Button>
      </Alert.Root>
    );
  }
  return (
    <Alert.Root status="info" variant="subtle">
      <Alert.Indicator>
        <Spinner size="sm" />
      </Alert.Indicator>
      <Alert.Content>
        <Alert.Title>Confirming your subscription…</Alert.Title>
        <Alert.Description>Checkout succeeded. Waiting for Stripe to confirm it with our database.</Alert.Description>
      </Alert.Content>
    </Alert.Root>
  );
}
