import { Resend } from "resend";

export type DunningEmail = {
  to: string;
  invoiceUrl: string | null;
  amount: number; // minor units
  currency?: string;
  nextAttempt: Date | null;
  idempotencyKey?: string;
};

export type TrialEndingEmail = {
  to: string;
  trialEnd: Date | null;
  plan?: string | null;
  idempotencyKey?: string;
};

export type EmailMessage = ({ kind: "dunning" } & DunningEmail) | ({ kind: "trial_ending" } & TrialEndingEmail);

export type EmailResult = { sent: boolean; skipped?: string; id?: string };

let client: Resend | null = null;

function getClient(): Resend | null {
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) return null;
  client ??= new Resend(process.env.RESEND_API_KEY);
  return client;
}

/** Without a verified domain Resend only delivers to the account owner, so all mail goes to the override when set. */
export function recipient(customerEmail: string | null | undefined): string | null {
  return process.env.DUNNING_EMAIL_OVERRIDE || customerEmail || null;
}

function formatMoney(amount: number, currency = "usd") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(amount / 100);
}

function formatDate(date: Date | null) {
  return date ? date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }) : null;
}

async function send(to: string, subject: string, text: string, idempotencyKey?: string): Promise<EmailResult> {
  const resend = getClient();
  if (!resend) return { sent: false, skipped: "email not configured" };
  const { data, error } = await resend.emails.send(
    { from: process.env.EMAIL_FROM!, to, subject, text },
    idempotencyKey ? { idempotencyKey } : undefined,
  );
  if (error) throw new Error(`Resend: ${error.message}`);
  return { sent: true, id: data?.id };
}

export async function sendDunningEmail(msg: DunningEmail): Promise<EmailResult> {
  const to = recipient(msg.to);
  if (!to) return { sent: false, skipped: "no recipient" };
  const next = formatDate(msg.nextAttempt);
  const lines = [
    `We couldn't charge your card for your Inkwell Pro subscription (${formatMoney(msg.amount, msg.currency)}).`,
    next ? `We'll try again on ${next}.` : "We won't retry automatically.",
    "Update your payment method to keep writing without interruption.",
    msg.invoiceUrl ? `Pay or view the invoice: ${msg.invoiceUrl}` : null,
    "",
    "This is a demo in Stripe test mode — no real money moved.",
  ].filter((l) => l !== null);
  return send(to, "Your Inkwell payment failed", lines.join("\n"), msg.idempotencyKey);
}

export async function sendTrialEndingEmail(msg: TrialEndingEmail): Promise<EmailResult> {
  const to = recipient(msg.to);
  if (!to) return { sent: false, skipped: "no recipient" };
  const end = formatDate(msg.trialEnd);
  const lines = [
    `Your Inkwell Pro trial ends${end ? ` on ${end}` : " soon"}.`,
    "Your card will be charged automatically unless you cancel from the billing portal.",
    "",
    "This is a demo in Stripe test mode — no real money moves.",
  ];
  return send(to, "Your Inkwell trial ends soon", lines.join("\n"), msg.idempotencyKey);
}

export async function sendEmail(msg: EmailMessage): Promise<EmailResult> {
  return msg.kind === "dunning" ? sendDunningEmail(msg) : sendTrialEndingEmail(msg);
}
