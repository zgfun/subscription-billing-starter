# Testing

Billing code is easy to get almost right. The tests here target the parts that break in production: duplicate webhook deliveries, events that arrive out of order, failed handlers that need a retry, and the trial-to-paid transition that only happens 14 days later.

There are three layers:

| Layer | What it proves | Command | Needs |
| --- | --- | --- | --- |
| Unit and DB tests (vitest) | Entitlement logic, sync, webhook ledger, routes | `pnpm test` | `TEST_DATABASE_URL` (DB tests skip if it is unreachable) |
| `stripe listen` + `stripe trigger` | The real route verifies real signatures and handles real payloads | see below | dev server, Stripe CLI |
| Test clock script | A real 14-day trial converting to paid, and a failed renewal going to dunning | `pnpm tsx scripts/test-clock.ts` | `DATABASE_URL`, `STRIPE_SECRET_KEY` (test mode) |

## 1. Unit and DB tests

```bash
pnpm db:local          # Postgres on :5435 (separate terminal)
pnpm test              # or: pnpm vitest run lib/webhooks
```

DB-backed tests connect to `TEST_DATABASE_URL` (the `billing_test` database), run the drizzle migrations from `drizzle/` themselves, and clean up their rows. If the database is unreachable they are skipped rather than failed, so the pure unit tests still run anywhere.

Stripe is never called from unit tests. The tests pass a fake client (or `vi.mock` `lib/stripe`) whose `subscriptions.retrieve` returns a scripted subscription. That matches the production design: webhook handlers ignore the payload's state and re-fetch the subscription, so the fake only has to answer one question, "what does Stripe say now?".

### Webhook tests (`lib/webhooks/__tests__`)

The fixtures in `fixtures/events/*.json` are **real events** recorded from the test account (`scripts/record-fixtures.ts`, emails replaced with `demo@inkwell.test`), so the payload shapes match the pinned API version and are not hand-written guesses.

- **Signature failure.** A body signed with the wrong secret, or modified after signing, gets a 400 and writes nothing.
- **Replay.** The same event is delivered twice. Result: one `stripe_events` row, one subscription upsert, one email side effect. The second call returns `"duplicate"` and never reaches the handler. Idempotency comes from inserting the event id into a table whose primary key is the event id. A "have I seen this?" read would be racy.
- **Out of order.** `customer.subscription.updated` is delivered before `customer.subscription.created`, and the mocked `retrieve` returns the latest state both times. The final row equals the fresh retrieve. Since handlers never apply the payload, delivery order cannot roll state backwards. `stripe_updated_at` also stops an older snapshot from overwriting a newer one. Syncs of one subscription also hold a transaction-scoped advisory lock, so a slow, older retrieve cannot land after a newer one (`lib/__tests__/sync.test.ts`).
- **Retry after failure.** The first delivery's handler throws. The route returns 500, and the ledger row is kept with `error` set and `processed_at` null so the failure shows on `/admin`. When Stripe retries, `handleEvent` reclaims that row: the insert's `ON CONFLICT ... DO UPDATE` only matches rows that failed or whose claim is stale, so the retry is processed normally instead of being treated as a duplicate. The second delivery succeeds. A replay of an event that was already processed, or is still being processed, remains a no-op.
- **In flight.** A redelivery that arrives while another attempt holds a fresh claim gets `"busy"`, and the route answers **409**, not 200, so Stripe keeps retrying. Acknowledging it would let Stripe stop even if the first attempt then crashed.
- **Side effect failure.** Emails run after the 200 (`after()`). If one fails, its `side_effects` key is released and the ledger row is un-marked (`processed_at` null, `error` set). `retryFailedEvents()` (run in `after()` on every webhook delivery) re-fetches such events from Stripe and re-runs them, and the test shows the email is then sent exactly once. A manual `stripe events resend` works too, because the row is no longer "processed".
- **Parallel checkouts.** Two completed Checkout Sessions for one customer: `checkout.session.completed` keeps the earliest live subscription and cancels and refunds the newer one. The checkout route also expires older open sessions and asks Stripe for live subscriptions that the webhook has not delivered yet.
- **Unhandled types** return `"ignored"` but are still ledgered, so a replay of them is cheap too.
- **Dunning.** `invoice.payment_failed` leaves the subscription `past_due` (from the re-fetch) and records exactly one `side_effects` row, which sends exactly one dunning email, even across replays.
- **Cancellation.** `customer.subscription.deleted` leaves the row `canceled` (the retrieve 404 path marks it canceled too).

The number of handled event types is `HANDLED_EVENTS.length` in `lib/webhooks/events.ts`.

## 2. Real events locally: `stripe listen` and `stripe trigger`

Shortcut: `STRIPE_CLI=/path/to/stripe PORT=3000 pnpm stripe:listen` reads the key from `.env.local` and forwards exactly `HANDLED_EVENTS` (current Stripe CLI versions require `--events`). It passes the key to the CLI in the `STRIPE_API_KEY` environment variable, not on the command line where `ps` could show it, and redacts `whsec_`/`sk_`/`rk_` values from the CLI's output, so don't expect to see the signing secret there.

The Stripe CLI is at `/Users/panczapeter/.local/bin/stripe` and is not logged in, so give it the key through the environment. Read it from `.env.local` without printing it. Never redirect `stripe listen` output to a shared log file, because its first line contains the signing secret:

```bash
export STRIPE_API_KEY=$(grep '^STRIPE_SECRET_KEY=' .env.local | cut -d= -f2-)
STRIPE=/Users/panczapeter/.local/bin/stripe

# One-off: write the signing secret straight into .env.local (STRIPE_WEBHOOK_SECRET) without echoing it
echo "STRIPE_WEBHOOK_SECRET=$($STRIPE listen --print-secret)" >> .env.local

# Terminal 1: forward events to the dev server
$STRIPE listen --events checkout.session.completed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,customer.subscription.trial_will_end,invoice.paid,invoice.payment_failed,price.created,price.updated --forward-to localhost:3000/api/stripe/webhook

# Terminal 2: fire real events
$STRIPE trigger checkout.session.completed
$STRIPE trigger customer.subscription.updated
$STRIPE trigger invoice.payment_failed

# Replay one event by hand: the second delivery must be a no-op (see /admin)
$STRIPE events resend evt_...
```

Triggered fixtures create their own customers without `metadata.userId`, so the handler ledgers them and skips them because it cannot map them to a user. That is the intended behaviour for objects that are not ours. To see the full flow, use the app: click "Try the demo", subscribe with card `4242 4242 4242 4242`, and watch `/admin`.

## 3. Test clocks: `scripts/test-clock.ts`

Some bugs only appear 14 days after signup, when the trial ends. Stripe test clocks let a script fast-forward a customer's time. The script runs against the **real** test-mode account and does not need the web server:

```bash
pnpm db:local                                   # if not already running
pnpm tsx scripts/test-clock.ts                  # both scenarios, ~2-5 minutes
pnpm tsx scripts/test-clock.ts --only=happy     # or --only=dunning
pnpm tsx scripts/test-clock.ts --keep-clock     # keep the clock to inspect it in the dashboard
pnpm tsx scripts/test-clock.ts --send-emails    # really send the emails through Resend (default: recorded only)
```

Each scenario:

1. Creates a test clock frozen at "now", a demo user row, and a Stripe customer attached to the clock (`metadata.userId`, via the same `ensureCustomer` the app uses).
2. Attaches a test card as the default payment method and creates a Pro Monthly subscription with `trial_period_days: 14` directly through the API (Checkout cannot be scripted).
3. Runs `syncSubscription` and asserts that the DB says `trialing` and `getEntitlement` reports a 14-day trial.
4. Advances the clock 15 days and polls `testClocks.retrieve` until the status is `ready`.
5. Lists every event for this customer since the start and feeds each through **`handleEvent`**, the function the webhook route calls, **twice**. The first pass must process (or ignore) every event. The second pass must answer `"duplicate"` for all of them.
6. Asserts the results and deletes the clock, which also deletes its customer and subscription.

| Scenario | Card | Assertions after +15 days |
| --- | --- | --- |
| `happy` | `pm_card_visa` | DB status `active`, entitlement active and not trialing, trial ended, latest invoice `paid` for 1200 USD, exactly one ledger row per event id, all rows processed |
| `dunning` | `pm_card_chargeCustomerFail` (attaches fine, every charge declines) | DB status `past_due`, entitlement `pastDue`, exactly one dunning `side_effects` row and one dunning email across both deliveries, one ledger row per event id |

The script prints a PASS/FAIL report and exits non-zero on any failed check. Rows created in `DATABASE_URL` (demo users and ledger entries) are kept so they appear on `/admin`.

Note: if a `stripe listen` session is forwarding to a running dev server against the same database at the same time, the route may process some of these events first. The script then sees `"duplicate"` on its first pass for those events. That is still correct (one ledger row per event), but run the script without a listener for the cleanest report.
