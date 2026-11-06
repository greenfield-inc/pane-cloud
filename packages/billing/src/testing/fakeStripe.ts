import Stripe from 'stripe';
import { PRICE_LOOKUP_KEYS, type StripeGateway, type SubscriptionSnapshot } from '../stripeGateway.ts';

/** A signed webhook delivery, as Stripe would POST it. */
export interface Delivery {
  body: string;
  signature: string;
}

interface Price {
  id: string;
  lookupKey: string | null;
  unitAmountCents: number;
}

interface Subscription {
  id: string;
  customerId: string;
  priceId: string;
  quantity: number;
  status: Stripe.Subscription.Status;
  trialEnd: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

function addMonth(date: Date): Date {
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}

/**
 * An in-memory Stripe for tests: customers, Checkout, one seat subscription per customer, trials,
 * invoices, declined cards and cancel at period end. Each call that changes a subscription returns
 * the webhook deliveries Stripe would send, signed with `webhookSecret`.
 */
export function createFakeStripe(options: { standardSeatCents: number }) {
  const webhookSecret = 'whsec_fake';
  let seq = 0;
  const id = (prefix: string) => `${prefix}_${++seq}`;
  const prices: Price[] = [{ id: 'price_founding', lookupKey: PRICE_LOOKUP_KEYS.founding, unitAmountCents: 4900 }];
  const customers = new Map<string, { teamId: string; email: string }>();
  const sessions = new Map<string, { customerId: string; priceId: string; quantity: number; trialEnd: Date | null }>();
  const subscriptions: Subscription[] = [];
  const invoices: { customerId: string; amountCents: number; paid: boolean }[] = [];
  let declining = false;

  function setStandardSeatCents(cents: number) {
    for (const p of prices) if (p.lookupKey === PRICE_LOOKUP_KEYS.standard) p.lookupKey = null;
    prices.push({ id: id('price'), lookupKey: PRICE_LOOKUP_KEYS.standard, unitAmountCents: cents });
  }
  setStandardSeatCents(options.standardSeatCents);

  function deliver(type: string, customerId: string): Delivery {
    const body = JSON.stringify({ id: id('evt'), object: 'event', type, data: { object: { customer: customerId } } });
    return { body, signature: Stripe.webhooks.generateTestHeaderString({ payload: body, secret: webhookSecret }) };
  }

  function charge(sub: Subscription, periodStart: Date): Delivery[] {
    const price = prices.find((p) => p.id === sub.priceId);
    if (!price) throw new Error(`fake stripe: unknown price ${sub.priceId}`);
    const paid = !declining;
    invoices.push({ customerId: sub.customerId, amountCents: price.unitAmountCents * sub.quantity, paid });
    sub.status = paid ? 'active' : 'past_due';
    sub.trialEnd = null;
    sub.currentPeriodEnd = addMonth(periodStart);
    return [deliver(paid ? 'invoice.paid' : 'invoice.payment_failed', sub.customerId), deliver('customer.subscription.updated', sub.customerId)];
  }

  function only(): Subscription {
    const sub = subscriptions.at(-1);
    if (!sub) throw new Error('fake stripe: no subscription yet');
    return sub;
  }

  const gateway: StripeGateway = {
    async findPrice(lookupKey) {
      const price = prices.find((p) => p.lookupKey === lookupKey);
      if (!price) throw new Error(`fake stripe: no price ${lookupKey}`);
      return { id: price.id, unitAmountCents: price.unitAmountCents };
    },
    async createCustomer({ teamId, email }) {
      const customerId = id('cus');
      customers.set(customerId, { teamId, email });
      return customerId;
    },
    async createCheckoutSession({ customerId, priceId, quantity, trialEnd }) {
      const url = `https://checkout.stripe.test/${id('cs')}`;
      sessions.set(url, { customerId, priceId, quantity, trialEnd });
      return url;
    },
    async createPortalSession({ customerId }) {
      return `https://billing.stripe.test/${customerId}/${id('bps')}`;
    },
    async latestSubscription(customerId): Promise<SubscriptionSnapshot | null> {
      const sub = subscriptions.filter((s) => s.customerId === customerId).at(-1);
      if (!sub) return null;
      const { id: subId, status, quantity, currentPeriodEnd, cancelAtPeriodEnd, trialEnd } = sub;
      return { id: subId, status, quantity, currentPeriodEnd, cancelAtPeriodEnd, trialEnd };
    },
    async setSeatQuantity(subscriptionId, quantity) {
      const sub = subscriptions.find((s) => s.id === subscriptionId);
      if (!sub) throw new Error(`fake stripe: no subscription ${subscriptionId}`);
      sub.quantity = quantity;
    },
  };

  return {
    gateway,
    webhookSecret,
    setStandardSeatCents,
    declineCards: () => void (declining = true),
    acceptCards: () => void (declining = false),
    invoices: () => invoices.map(({ amountCents, paid }) => ({ amountCents, paid })),
    eventFor: deliver,

    /** The customer pays in Checkout. With a trial end the subscription starts trialing; without one it is charged now. */
    completeCheckout(url: string, now = new Date()): Delivery[] {
      const session = sessions.get(url);
      if (!session) throw new Error(`fake stripe: no Checkout session ${url}`);
      sessions.delete(url);
      const sub: Subscription = {
        id: id('sub'),
        customerId: session.customerId,
        priceId: session.priceId,
        quantity: session.quantity,
        status: 'trialing',
        trialEnd: session.trialEnd,
        currentPeriodEnd: session.trialEnd,
        cancelAtPeriodEnd: false,
      };
      subscriptions.push(sub);
      const events = [deliver('checkout.session.completed', sub.customerId), deliver('customer.subscription.created', sub.customerId)];
      return session.trialEnd ? events : [...events, ...charge(sub, now)];
    },

    /** Stripe's clock moving to `date`: trials end, periods renew, and cancelled subscriptions end. */
    advanceTo(date: Date): Delivery[] {
      const sub = only();
      if (sub.status === 'trialing' && sub.trialEnd && sub.trialEnd <= date) return charge(sub, sub.trialEnd);
      if (sub.status === 'active' && sub.currentPeriodEnd && sub.currentPeriodEnd <= date) {
        if (!sub.cancelAtPeriodEnd) return charge(sub, sub.currentPeriodEnd);
        sub.status = 'canceled';
        return [deliver('customer.subscription.deleted', sub.customerId)];
      }
      return [];
    },

    /** Stripe retrying the open invoice. */
    retryPayment(): Delivery[] {
      const sub = only();
      const invoice = invoices.filter((i) => i.customerId === sub.customerId).at(-1);
      if (!invoice || invoice.paid || declining) return [];
      invoice.paid = true;
      sub.status = 'active';
      return [deliver('invoice.paid', sub.customerId), deliver('customer.subscription.updated', sub.customerId)];
    },

    /** The owner cancelling in the customer portal. */
    cancelAtPeriodEnd(): Delivery[] {
      const sub = only();
      sub.cancelAtPeriodEnd = true;
      return [deliver('customer.subscription.updated', sub.customerId)];
    },
  };
}
