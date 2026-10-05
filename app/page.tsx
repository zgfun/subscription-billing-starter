import { Landing } from "@/components/billing/landing";
import { SiteShell } from "@/components/billing/site-shell";
import { readSession } from "@/lib/session";
import { HANDLED_EVENTS } from "@/lib/webhooks/events";

export default async function Home() {
  const session = await readSession();
  return (
    <SiteShell signedIn={!!session}>
      <Landing signedIn={!!session} handledEvents={HANDLED_EVENTS.length} />
    </SiteShell>
  );
}
