"use client";

import { Badge } from "@chakra-ui/react";
import { daysUntil, formatDate, statusOf, type EntitlementView } from "./format";

export function StatusBadge({ entitlement, now }: { entitlement: EntitlementView; now: string }) {
  const status = statusOf(entitlement);
  switch (status) {
    case "past_due":
      return (
        <Badge colorPalette="red" variant="solid" size="lg">
          Past due
        </Badge>
      );
    case "trialing": {
      const days = daysUntil(entitlement.trialEnd, now);
      return (
        <Badge colorPalette="purple" variant="subtle" size="lg">
          Trialing — {days} {days === 1 ? "day" : "days"} left
        </Badge>
      );
    }
    case "trial_canceling":
      return (
        <Badge colorPalette="orange" variant="subtle" size="lg">
          Trial ends {formatDate(entitlement.trialEnd ?? entitlement.periodEnd)} — won&apos;t renew
        </Badge>
      );
    case "canceling":
      return (
        <Badge colorPalette="orange" variant="subtle" size="lg">
          Canceling on {formatDate(entitlement.periodEnd)}
        </Badge>
      );
    case "active":
      return (
        <Badge colorPalette="green" variant="subtle" size="lg">
          Active
        </Badge>
      );
    default:
      return (
        <Badge variant="outline" size="lg">
          No plan
        </Badge>
      );
  }
}
