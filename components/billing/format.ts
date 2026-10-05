export type EntitlementView = {
  plan: "monthly" | "yearly" | null;
  active: boolean;
  trialing: boolean;
  pastDue: boolean;
  periodEnd: string | null;
  trialEnd: string | null;
  cancelAtPeriodEnd: boolean;
  hasUsageAddon: boolean;
};

type EntitlementLike = Omit<EntitlementView, "periodEnd" | "trialEnd"> & {
  periodEnd: Date | string | null;
  trialEnd: Date | string | null;
};

const DAY_MS = 86_400_000;

function iso(value: Date | string | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function toEntitlementView(e: EntitlementLike): EntitlementView {
  return {
    plan: e.plan,
    active: e.active,
    trialing: e.trialing,
    pastDue: e.pastDue,
    periodEnd: iso(e.periodEnd),
    trialEnd: iso(e.trialEnd),
    cancelAtPeriodEnd: e.cancelAtPeriodEnd,
    hasUsageAddon: e.hasUsageAddon,
  };
}

export function formatMoney(minor: number, currency = "usd", maximumFractionDigits?: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: maximumFractionDigits === 0 ? 0 : 2,
    maximumFractionDigits: maximumFractionDigits ?? 2,
  }).format(minor / 100);
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(date);
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(date) + " UTC";
}

export function daysUntil(value: string | null, nowIso: string): number {
  if (!value) return 0;
  return Math.max(0, Math.ceil((new Date(value).getTime() - new Date(nowIso).getTime()) / DAY_MS));
}

export const PLAN_LABEL = { monthly: "Pro Monthly", yearly: "Pro Yearly" } as const;

export type StatusKind = "none" | "trialing" | "trial_canceling" | "active" | "past_due" | "canceling";

export function statusOf(e: EntitlementView): StatusKind {
  if (e.pastDue) return "past_due";
  if (!e.plan || !e.active) return "none";
  if (e.cancelAtPeriodEnd) return e.trialing ? "trial_canceling" : "canceling";
  if (e.trialing) return "trialing";
  return "active";
}
