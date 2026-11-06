# @pane-cloud/billing

Stripe billing for Pane Cloud teams: $49 per seat a month after notice, the founding-price lock,
the notice email, 7 days of grace on a failed card, and cancellation at the end of the paid month.
It runs in Stripe test mode only; a live key is refused until live mode is approved.

The service (`packages/service`) wires it in. Billing owns its own two tables and reads seats,
founding and the owner from the service's team tables.

## How billing works

| When | What happens |
| --- | --- |
| Free cohort | Every team is `cohort`, `free`. A founding team (one that joined during the cohort) shows `foundingPriceLocked: true` and keeps $49 a seat if the standard price rises. |
| Notice | `announceCharges(startAt)` sets the start date for every team and emails each owner once. Running it again emails only owners who haven't had it, such as teams created since. The owner's `manageUrl` becomes a Stripe Checkout link. |
| Card added | Checkout saves the card and creates a subscription with one seat per team member, anchored to the start date (`billing_cycle_anchor`), so Stripe charges nothing until then and $49 a seat on that date. A card added after the start date is charged at once. |
| Teammate joins or leaves | `syncSeats(teamId)` changes the subscription's seat count; Stripe prorates it onto the next invoice. |
| Card fails, or no card by the start date | Status `grace` for 7 days (the app shows a banner from `status` and `graceEndsAt`), then `past_due`: `enforce()` stops the team's machines with their disks kept, and `machinesAllowed` refuses create and start. Paying the open invoice in the portal, or adding a card through Checkout when there was none, makes the team `active` again. |
| Owner cancels | In the customer portal (`manageUrl`), at the end of the period. The team stays `active` until then, then `canceled`: `enforce()` stops its machines and `machinesAllowed` refuses create and start. `manageUrl` becomes a Checkout link to subscribe again. |
| Refund | An operator refunds the charge in the Stripe dashboard (Payments → the charge → Refund). Billing state needs no change. |

## Wiring

```ts
import { createBilling, createPgStore, createStripeGateway } from '@pane-cloud/billing';

const billing = createBilling({
  stripe: createStripeGateway(process.env.STRIPE_SECRET_KEY),
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  store: createPgStore(pool),
  teams,    // getTeam(teamId) -> { id, createdAt, founding, ownerAccountId, ownerEmail, seats }; listTeamIds()
  machines, // stopTeamMachines(teamId, reason): the signed stop, logged with actor 'service'
  mailer,   // send({ to, subject, text })
  returnUrl: 'https://runpane.com/cloud',
});
```

| Service call | Billing call |
| --- | --- |
| `GET /v1/billing` | `getBillingStatus(teamId, accountId)` |
| `POST /v1/billing/webhook` (raw body, `Stripe-Signature` header) | `handleWebhook(rawBody, signature)` |
| Create or start a machine | refuse when `machinesAllowed(teamId)` is false |
| A member joins or is removed | `syncSeats(teamId)` |
| Every few minutes | `enforce()` |
| Operator sends the notice | `announceCharges(startAt)`, from a service operator command |

`migrations/100_billing.sql` creates `billing_teams` and `billing_notice`; the service's migration
runner applies it after the service's own migrations.

## Stripe setup (test mode)

1. Create the product, the two $49 prices and the customer portal configuration. The script is safe to run again:

   ```sh
   STRIPE_SECRET_KEY=sk_test_... pnpm --filter @pane-cloud/billing stripe:setup
   ```

   Prices are found by lookup key (`pane_cloud_seat_founding`, `pane_cloud_seat_standard`). To raise
   the standard price later, create a new price and move the `pane_cloud_seat_standard` lookup key to
   it; existing subscriptions keep their price.
2. Add a webhook endpoint at `<service>/v1/billing/webhook` for `checkout.session.completed`,
   `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`,
   `invoice.paid` and `invoice.payment_failed`, and set `STRIPE_WEBHOOK_SECRET` to its signing secret.
3. In the Dashboard under Billing, Revenue recovery, set retries to finish within 7 days and set
   "If all retries for a payment fail" to leave the subscription past due. Billing's own 7-day grace
   then decides when machines stop; if Stripe cancelled the subscription instead, the team would
   go straight to `canceled`.

For a local service, `stripe listen --api-key sk_test_... --forward-to localhost:<port>/v1/billing/webhook`
prints a signing secret to use instead.

## Tests

```sh
pnpm --filter @pane-cloud/billing test
```

The billing journeys run against an in-memory Stripe (`@pane-cloud/billing/testing`). Two more
suites run when their servers are up:

- `STRIPE_MOCK_PORT=12111` checks every Stripe call against [stripe-mock](https://github.com/stripe/stripe-mock)
  (`docker run --rm -p 12111:12111 stripe/stripe-mock`), which rejects requests that don't match Stripe's API spec.
- `TEST_DATABASE_URL=postgres://...` runs the store tests against Postgres, in a throwaway schema.
