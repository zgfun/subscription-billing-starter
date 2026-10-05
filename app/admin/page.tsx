import type { Metadata } from "next";
import { connection } from "next/server";
import { AdminView } from "@/components/billing/admin-view";
import { getLedger } from "@/components/billing/data";
import { SiteShell } from "@/components/billing/site-shell";
import { readSession } from "@/lib/session";
import { HANDLED_EVENTS } from "@/lib/webhooks/events";

export const metadata: Metadata = { title: "Webhook ledger · Inkwell" };

export default async function AdminPage() {
  await connection();
  const [session, ledger] = await Promise.all([readSession(), getLedger(50)]);
  return (
    <SiteShell signedIn={!!session}>
      <AdminView handledEvents={[...HANDLED_EVENTS]} stats={ledger.stats} rows={ledger.rows} />
    </SiteShell>
  );
}
