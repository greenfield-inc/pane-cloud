/**
 * Creates what billing needs in a Stripe test-mode account, and is safe to run again:
 * the Pane Cloud product, the founding and standard $49 seat prices (found by lookup key),
 * and the customer portal configuration (card updates, invoices, cancel at period end).
 *
 *   STRIPE_SECRET_KEY=sk_test_... pnpm --filter @pane-cloud/billing stripe:setup
 */
import Stripe from 'stripe';
import { assertTestModeKey, PORTAL_METADATA, PRICE_LOOKUP_KEYS } from '../src/stripeGateway.ts';

const SEAT_CENTS = 4900;
const key = process.env.STRIPE_SECRET_KEY;
if (!key) throw new Error('Set STRIPE_SECRET_KEY to a test-mode secret key.');
assertTestModeKey(key);
const mock = process.env.STRIPE_MOCK_PORT ? { host: 'localhost', port: Number(process.env.STRIPE_MOCK_PORT), protocol: 'http' as const } : {};
const stripe = new Stripe(key, mock);

const products = await stripe.products.search({ query: "metadata['pane_cloud']:'seat'" });
const product =
  products.data[0] ??
  (await stripe.products.create({ name: 'Pane Cloud seat', description: 'One always-on Pane Cloud machine', metadata: { pane_cloud: 'seat' } }));
console.log(`product ${product.id}`);

for (const lookupKey of Object.values(PRICE_LOOKUP_KEYS)) {
  const existing = (await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 })).data[0];
  const price =
    existing ??
    (await stripe.prices.create({ product: product.id, currency: 'usd', unit_amount: SEAT_CENTS, recurring: { interval: 'month' }, lookup_key: lookupKey, nickname: lookupKey }));
  console.log(`price ${lookupKey} ${price.id} ${price.unit_amount}`);
}

const portals = await stripe.billingPortal.configurations.list({ active: true, limit: 100 });
const portalFeatures = {
  customer_update: { enabled: true, allowed_updates: ['email', 'address'] },
  invoice_history: { enabled: true },
  payment_method_update: { enabled: true },
  subscription_cancel: { enabled: true, mode: 'at_period_end' },
} satisfies Stripe.BillingPortal.ConfigurationCreateParams.Features;
const portal =
  portals.data.find((c) => c.metadata?.pane_cloud === PORTAL_METADATA.pane_cloud) ??
  (await stripe.billingPortal.configurations.create({ features: portalFeatures, metadata: PORTAL_METADATA }));
console.log(`portal configuration ${portal.id}`);
