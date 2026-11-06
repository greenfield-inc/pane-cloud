import { describe, expect, test } from 'vitest';
import { createStripeGateway } from './stripeGateway.ts';

test('refuses a live key', () => {
  expect(() => createStripeGateway('sk_live_123')).toThrow(/test mode only/);
  expect(() => createStripeGateway('rk_live_123')).toThrow(/test mode only/);
});

// stripe-mock (github.com/stripe/stripe-mock) answers from fixtures and refuses any request outside
// Stripe's OpenAPI spec, so this checks that every call billing makes is one Stripe accepts.
// Run it: docker run --rm -p 12111:12111 stripe/stripe-mock, then STRIPE_MOCK_PORT=12111 pnpm test.
const port = Number(process.env.STRIPE_MOCK_PORT);
describe.skipIf(!port)('against stripe-mock', () => {
  const stripe = createStripeGateway('sk_test_mock', { host: 'localhost', port, protocol: 'http' });

  test('every call billing makes is a valid Stripe request', async () => {
    const price = await stripe.findPrice('pane_cloud_seat_founding');
    expect(price.id).toMatch(/^price_/);
    const customerId = await stripe.createCustomer({ teamId: 'team_a', email: 'owner@example.com' });
    expect(customerId).toMatch(/^cus_/);
    const firstChargeAt = new Date(Date.now() + 14 * 86_400_000);
    const checkout = await stripe.createCheckoutSession({ customerId, teamId: 'team_a', priceId: price.id, quantity: 3, firstChargeAt, returnUrl: 'https://runpane.com/cloud' });
    expect(checkout).toMatch(/^https:/);
    expect(await stripe.createPortalSession({ customerId, returnUrl: 'https://runpane.com/cloud' })).toMatch(/^https:/);
    const sub = await stripe.latestSubscription(customerId);
    expect(sub?.id).toMatch(/^sub_/);
    await stripe.setSeatQuantity(sub?.id ?? '', 4);
  });
});
