import { BillingStatus } from 'pane-cloud-contract';
import { describe, expect, test } from 'vitest';
import { createBilling } from './billing.ts';
import { createMemoryStore } from './store.ts';
import { createFakeStripe } from './testing/fakeStripe.ts';

const NOV_5 = new Date('2026-11-05T12:00:00Z');
const DAY = 86_400_000;

function setup(options: { founding?: boolean; seats?: number } = {}) {
  let now = NOV_5;
  const stripe = createFakeStripe({ standardSeatCents: 4900 });
  const team = {
    id: 'team_a',
    createdAt: new Date('2026-11-01T00:00:00Z'),
    founding: options.founding ?? true,
    ownerAccountId: 'acct_owner',
    ownerEmail: 'owner@example.com',
    seats: options.seats ?? 1,
  };
  const stopped: { teamId: string; reason: string }[] = [];
  const outbox: { to: string; subject: string; text: string }[] = [];
  const billing = createBilling({
    stripe: stripe.gateway,
    webhookSecret: stripe.webhookSecret,
    store: createMemoryStore(),
    teams: { getTeam: async (id) => (id === team.id ? team : null), listTeamIds: async () => [team.id] },
    machines: { stopTeamMachines: async (teamId, reason) => void stopped.push({ teamId, reason }) },
    mailer: { send: async (mail) => void outbox.push(mail) },
    returnUrl: 'https://runpane.com/cloud',
    now: () => now,
  });
  return {
    billing,
    stripe,
    team,
    stopped,
    outbox,
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
    /** The owner opens their manage link and pays in Checkout; Stripe then sends its webhooks. */
    addCard: async () => {
      const status = await billing.getBillingStatus(team.id, team.ownerAccountId);
      if (!status.manageUrl) throw new Error('owner has no manage link');
      for (const event of stripe.completeCheckout(status.manageUrl, now)) await billing.handleWebhook(event.body, event.signature);
    },
    deliver: async (events: { body: string; signature: string }[]) => {
      for (const event of events) await billing.handleWebhook(event.body, event.signature);
    },
    status: async (viewer = team.ownerAccountId) => BillingStatus.parse(await billing.getBillingStatus(team.id, viewer)),
  };
}

describe('during the free cohort', () => {
  test('a founding team sees its seats free, at $49 locked, with nothing to manage', async () => {
    const t = setup({ seats: 3 });
    expect(await t.status()).toEqual({
      teamId: 'team_a',
      plan: 'cohort',
      seatPriceCents: 4900,
      currency: 'usd',
      foundingPriceLocked: true,
      status: 'free',
      seats: 3,
      chargesStartAt: null,
      graceEndsAt: null,
      currentPeriodEnd: null,
      manageUrl: null,
    });
    expect(await t.billing.machinesAllowed('team_a')).toBe(true);
  });

  test('a founding team keeps $49 when the standard price rises', async () => {
    const t = setup();
    t.stripe.setStandardSeatCents(5900);
    expect((await t.status()).seatPriceCents).toBe(4900);
  });

  test('a team that is not founding pays the standard price and is not locked', async () => {
    const t = setup({ founding: false });
    t.stripe.setStandardSeatCents(5900);
    const status = await t.status();
    expect(status.seatPriceCents).toBe(5900);
    expect(status.foundingPriceLocked).toBe(false);
  });
});

describe('the billing notice', () => {
  test('emails each team owner once with the start date and their monthly total', async () => {
    const t = setup({ seats: 3 });
    const startAt = new Date(NOV_5.getTime() + 14 * DAY);
    await t.billing.announceCharges(startAt);
    await t.billing.announceCharges(startAt);
    expect(t.outbox).toHaveLength(1);
    expect(t.outbox[0]?.to).toBe('owner@example.com');
    expect(t.outbox[0]?.text).toContain('November 19, 2026');
    expect(t.outbox[0]?.text).toContain('Your team has 3 seats, so your bill will be $147 a month');
    expect(t.outbox[0]?.text).toContain('founding team');
    const status = await t.status();
    expect(status.chargesStartAt).toBe('2026-11-19T12:00:00.000Z');
    expect(status.status).toBe('free');
  });

  test('refuses a start date that is not in the future', async () => {
    const t = setup();
    await expect(t.billing.announceCharges(NOV_5)).rejects.toThrow(/future/);
  });

  test('after notice the owner gets a Checkout link and a member gets none', async () => {
    const t = setup();
    await t.billing.announceCharges(new Date(NOV_5.getTime() + 14 * DAY));
    expect((await t.status()).manageUrl).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    expect((await t.status('acct_member')).manageUrl).toBeNull();
  });
});

describe('charges', () => {
  test('a card added before the start date is charged $49 a seat on the start date', async () => {
    const t = setup({ seats: 2 });
    await t.billing.announceCharges(new Date(NOV_5.getTime() + 14 * DAY));
    await t.addCard();
    expect(t.stripe.invoices()).toEqual([]);
    expect((await t.status()).status).toBe('free');

    t.advance(14 * DAY);
    await t.deliver(t.stripe.advanceTo(new Date(NOV_5.getTime() + 14 * DAY)));

    expect(t.stripe.invoices()).toEqual([{ amountCents: 9800, paid: true }]);
    const status = await t.status();
    expect(status.plan).toBe('paid');
    expect(status.status).toBe('active');
    expect(status.currentPeriodEnd).toBe('2026-12-19T12:00:00.000Z');
    expect(status.manageUrl).toMatch(/^https:\/\/billing\.stripe\.test\//);
  });

  test('a card added the day before the start date is first charged on the start date', async () => {
    const t = setup();
    await t.billing.announceCharges(new Date(NOV_5.getTime() + 14 * DAY));
    t.advance(13 * DAY);
    await t.addCard();
    expect(t.stripe.invoices()).toEqual([]);
    expect((await t.status()).status).toBe('free');
    t.advance(DAY);
    await t.deliver(t.stripe.advanceTo(new Date(NOV_5.getTime() + 14 * DAY)));
    expect(t.stripe.invoices()).toEqual([{ amountCents: 4900, paid: true }]);
  });

  test('a card added after the start date is charged at once', async () => {
    const t = setup();
    await t.billing.announceCharges(new Date(NOV_5.getTime() + 14 * DAY));
    t.advance(15 * DAY);
    await t.addCard();
    expect(t.stripe.invoices()).toEqual([{ amountCents: 4900, paid: true }]);
    expect(await t.status()).toMatchObject({ status: 'active', graceEndsAt: null });
  });

  test('a teammate who joins adds a $49 seat to the bill', async () => {
    const t = setup({ seats: 1 });
    await t.billing.announceCharges(new Date(NOV_5.getTime() + 14 * DAY));
    await t.addCard();
    t.team.seats = 2;
    await t.billing.syncSeats('team_a');
    t.advance(14 * DAY);
    await t.deliver(t.stripe.advanceTo(new Date(NOV_5.getTime() + 14 * DAY)));
    expect(t.stripe.invoices()).toEqual([{ amountCents: 9800, paid: true }]);
    expect((await t.status()).seats).toBe(2);
  });
});

describe('a failed payment', () => {
  test('gets 7 days of grace, then the team machines stop and stay stopped until it is paid', async () => {
    const t = setup();
    await t.billing.announceCharges(new Date(NOV_5.getTime() + 14 * DAY));
    await t.addCard();
    t.stripe.declineCards();
    t.advance(14 * DAY);
    await t.deliver(t.stripe.advanceTo(new Date(NOV_5.getTime() + 14 * DAY)));

    expect(await t.status()).toMatchObject({ status: 'grace', graceEndsAt: '2026-11-26T12:00:00.000Z' });
    await t.billing.enforce();
    expect(t.stopped).toEqual([]);
    expect(await t.billing.machinesAllowed('team_a')).toBe(true);

    t.advance(7 * DAY);
    expect((await t.status()).status).toBe('past_due');
    await t.billing.enforce();
    expect(t.stopped).toEqual([{ teamId: 'team_a', reason: expect.stringMatching(/payment/i) }]);
    expect(await t.billing.machinesAllowed('team_a')).toBe(false);

    t.stripe.acceptCards();
    await t.deliver(t.stripe.retryPayment());
    expect(await t.status()).toMatchObject({ status: 'active', graceEndsAt: null });
    expect(await t.billing.machinesAllowed('team_a')).toBe(true);
  });

  test('a team with no card on the start date gets the same grace', async () => {
    const t = setup();
    await t.billing.announceCharges(new Date(NOV_5.getTime() + 14 * DAY));
    t.advance(14 * DAY);
    expect(await t.status()).toMatchObject({ plan: 'paid', status: 'grace', graceEndsAt: '2026-11-26T12:00:00.000Z' });
    expect((await t.status()).manageUrl).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    t.advance(7 * DAY);
    await t.billing.enforce();
    expect(t.stopped).toHaveLength(1);
  });
});

describe('cancelling', () => {
  test('keeps the team active to the end of the paid period, then stops billing and machines', async () => {
    const t = setup();
    await t.billing.announceCharges(new Date(NOV_5.getTime() + 14 * DAY));
    await t.addCard();
    t.advance(14 * DAY);
    await t.deliver(t.stripe.advanceTo(new Date(NOV_5.getTime() + 14 * DAY)));

    await t.deliver(t.stripe.cancelAtPeriodEnd());
    expect((await t.status()).status).toBe('active');
    await t.billing.enforce();
    expect(t.stopped).toEqual([]);

    t.advance(30 * DAY);
    await t.deliver(t.stripe.advanceTo(new Date(NOV_5.getTime() + 44 * DAY)));
    expect(t.stripe.invoices()).toEqual([{ amountCents: 4900, paid: true }]);
    expect((await t.status()).status).toBe('canceled');
    await t.billing.enforce();
    expect(t.stopped).toHaveLength(1);
  });
});

describe('webhooks', () => {
  test('refuse a body whose signature does not match', async () => {
    const t = setup();
    await expect(t.billing.handleWebhook('{"type":"invoice.paid"}', 't=1,v1=bad')).rejects.toThrow();
  });

  test('ignore events for customers that are not Pane Cloud teams', async () => {
    const t = setup();
    await expect(t.deliver([t.stripe.eventFor('cus_unknown', 'invoice.paid')])).resolves.toBeUndefined();
  });
});
