import Stripe from 'stripe';

/** Stripe price lookup keys; `pnpm stripe:setup` creates both prices. */
export const PRICE_LOOKUP_KEYS = { founding: 'pane_cloud_seat_founding', standard: 'pane_cloud_seat_standard' } as const;
/** Marks the customer portal configuration `pnpm stripe:setup` creates. */
export const PORTAL_METADATA = { pane_cloud: 'billing' } as const;

export interface SubscriptionSnapshot {
  id: string;
  status: Stripe.Subscription.Status;
  quantity: number;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

export interface SeatPrice {
  id: string;
  unitAmountCents: number;
}

/** The Stripe calls billing makes. `createStripeGateway` is the real one; tests use `createFakeStripe`. */
export interface StripeGateway {
  findPrice(lookupKey: string): Promise<SeatPrice>;
  createCustomer(input: { teamId: string; email: string | null }): Promise<string>;
  createCheckoutSession(input: {
    customerId: string;
    teamId: string;
    priceId: string;
    quantity: number;
    /** The first charge lands on this date and nothing is charged before it; null charges now. */
    firstChargeAt: Date | null;
    returnUrl: string;
  }): Promise<string>;
  createPortalSession(input: { customerId: string; returnUrl: string }): Promise<string>;
  /** The customer's newest subscription, or null when they have none. */
  latestSubscription(customerId: string): Promise<SubscriptionSnapshot | null>;
  setSeatQuantity(subscriptionId: string, quantity: number): Promise<void>;
}

export function assertTestModeKey(secretKey: string): void {
  if (/^(sk|rk)_live_/.test(secretKey)) {
    throw new Error('Pane Cloud billing runs in Stripe test mode only. Live charges wait for Parsa to approve live mode.');
  }
}

export function createStripeGateway(secretKey: string, options: { host?: string; port?: number; protocol?: 'http' | 'https' } = {}): StripeGateway {
  assertTestModeKey(secretKey);
  const stripe = new Stripe(secretKey, { maxNetworkRetries: 2, ...options });

  return {
    async findPrice(lookupKey) {
      const { data } = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
      const price = data[0];
      if (!price || price.unit_amount === null) throw new Error(`No active Stripe price with lookup key ${lookupKey}. Run pnpm stripe:setup.`);
      return { id: price.id, unitAmountCents: price.unit_amount };
    },

    async createCustomer({ teamId, email }) {
      const customer = await stripe.customers.create({ ...(email ? { email } : {}), metadata: { team_id: teamId } }, { idempotencyKey: `pane-cloud-customer-${teamId}` });
      return customer.id;
    },

    async createCheckoutSession({ customerId, teamId, priceId, quantity, firstChargeAt, returnUrl }) {
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: customerId,
        client_reference_id: teamId,
        line_items: [{ price: priceId, quantity }],
        subscription_data: {
          metadata: { team_id: teamId },
          ...(firstChargeAt ? { billing_cycle_anchor: Math.floor(firstChargeAt.getTime() / 1000), proration_behavior: 'none' as const } : {}),
        },
        success_url: returnUrl,
        cancel_url: returnUrl,
      });
      if (!session.url) throw new Error('Stripe returned a Checkout session without a URL.');
      return session.url;
    },

    async createPortalSession({ customerId, returnUrl }) {
      const configs = await stripe.billingPortal.configurations.list({ active: true, limit: 100 });
      const configuration = configs.data.find((c) => c.metadata?.pane_cloud === PORTAL_METADATA.pane_cloud)?.id;
      const session = await stripe.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl, ...(configuration ? { configuration } : {}) });
      return session.url;
    },

    async latestSubscription(customerId) {
      const { data } = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 1 });
      const sub = data[0];
      if (!sub) return null;
      const item = sub.items.data[0];
      return {
        id: sub.id,
        status: sub.status,
        quantity: item?.quantity ?? 0,
        currentPeriodEnd: item ? new Date(item.current_period_end * 1000) : null,
        cancelAtPeriodEnd: sub.cancel_at_period_end,
      };
    },

    async setSeatQuantity(subscriptionId, quantity) {
      const sub = await stripe.subscriptions.retrieve(subscriptionId);
      const item = sub.items.data[0];
      if (!item) throw new Error(`Subscription ${subscriptionId} has no seat item.`);
      await stripe.subscriptions.update(subscriptionId, { items: [{ id: item.id, quantity }], proration_behavior: 'create_prorations' });
    },
  };
}
