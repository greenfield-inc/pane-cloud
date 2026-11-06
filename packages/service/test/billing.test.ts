import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFakeStripe, type Delivery } from '@pane-cloud/billing/testing';
import type { Machine, ServiceClient } from 'pane-cloud-contract';
import { expectError, waitFor } from 'pane-cloud-contract/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCommand } from '../src/cli';
import { type Harness, startHarness } from './support/harness';

const DAY = 86_400_000;
const machineIn = (client: ServiceClient, id: string, done: (m: Machine) => boolean, what: string) =>
  waitFor(() => client.getMachine(id), done, what, 5000);

// Journeys 14 (billing) and 24 (a teammate is a billed seat), through the service API, with an in-memory Stripe.
describe('billing in the service', () => {
  let harness: Harness;
  let now = new Date();
  const stripe = createFakeStripe({ standardSeatCents: 4900 });
  const outboxDir = mkdtempSync(path.join(tmpdir(), 'pane-cloud-outbox-'));
  const billingEnv = { STRIPE_SECRET_KEY: 'sk_test_unused', STRIPE_WEBHOOK_SECRET: stripe.webhookSecret, BILLING_OUTBOX_DIR: outboxDir };
  beforeAll(async () => {
    harness = await startHarness({ billing: { stripe: stripe.gateway, webhookSecret: stripe.webhookSecret, outboxDir, now: () => now } });
  });
  afterAll(async () => {
    await harness.close();
    rmSync(outboxDir, { recursive: true, force: true });
  });

  const deliver = async (deliveries: Delivery[]) => {
    for (const d of deliveries) {
      const response = await fetch(`${harness.url}/v1/billing/webhook`, { method: 'POST', headers: { 'stripe-signature': d.signature }, body: d.body });
      expect(response.status).toBe(200);
    }
  };

  it('bills a founding team $49 a seat from the start date, stops its machines after 7 days unpaid, and lets them start once paid', async () => {
    await harness.cohort('bill-owner');
    const owner = harness.client(await harness.signIn({ id: 7001, login: 'bill-owner', name: 'Owner', email: 'owner@example.com' }));
    expect(await owner.getBilling()).toMatchObject({ plan: 'cohort', status: 'free', seatPriceCents: 4900, foundingPriceLocked: true, seats: 1, manageUrl: null });

    // The operator sends the notice: charges start in 14 days.
    const startAt = new Date(now.getTime() + 14 * DAY);
    expect(await runCommand(harness.db, ['billing', 'announce', startAt.toISOString()], billingEnv, { stripe: stripe.gateway, now: () => now })).toMatch(/Charges start .*Emailed 1 team owner/);
    const [mail] = readdirSync(outboxDir).map((f) => readFileSync(path.join(outboxDir, f), 'utf8'));
    expect(mail).toMatch(/^To: owner@example.com\nSubject: Pane Cloud billing starts /);
    expect(mail).toContain('founding team');

    // The owner adds a card for their one seat.
    const before = await owner.getBilling();
    expect(before).toMatchObject({ status: 'free', seats: 1, chargesStartAt: startAt.toISOString() });
    await deliver(stripe.completeCheckout(before.manageUrl ?? '', now));

    // A teammate joins: a second seat on the same bill. They see the bill but get no manage link.
    const invite = await owner.createInvite('bill-mate');
    const mate = harness.client(await harness.signIn({ id: 7002, login: 'bill-mate', name: 'Mate', email: 'mate@example.com' }));
    await mate.acceptInvite(invite.id);
    expect(await mate.getBilling()).toMatchObject({ seats: 2, seatPriceCents: 4900, foundingPriceLocked: true, manageUrl: null });

    const { machine } = await owner.createMachine('billed', randomUUID());
    await machineIn(owner, machine.id, (m) => m.state === 'running', 'running');

    // The card fails on the start date: 7 days of grace, machines keep running.
    stripe.declineCards();
    now = new Date(startAt.getTime());
    await deliver(stripe.advanceTo(now));
    expect(stripe.invoices()).toEqual([{ amountCents: 9800, paid: false }]);
    expect(await owner.getBilling()).toMatchObject({ plan: 'paid', status: 'grace', graceEndsAt: new Date(now.getTime() + 7 * DAY).toISOString() });
    await harness.app.enforceBilling();
    expect((await owner.getMachine(machine.id)).state).toBe('running');

    // During grace the teammate makes a machine and stops it; then the owner removes them, so they have no seat.
    const { machine: mateMachine } = await mate.createMachine('mate', randomUUID());
    await machineIn(mate, mateMachine.id, (m) => m.state === 'running', 'mate running');
    await mate.stopMachine(mateMachine.id);
    await machineIn(mate, mateMachine.id, (m) => m.state === 'stopped', 'mate stopped');
    const account = await mate.getAccount();
    await owner.removeMember(account.id);

    // Grace ends: the service stops the machine, logged as its own, and refuses to start it.
    now = new Date(now.getTime() + 7 * DAY + 1000);
    await harness.app.enforceBilling();
    await machineIn(owner, machine.id, (m) => m.state === 'stopped', 'stopped');
    const { entries } = await owner.listActionLog(machine.id);
    expect(entries.find((e) => e.operation === 'stop')).toMatchObject({ actor: { kind: 'service', accountId: null }, reason: expect.stringMatching(/Payment failed/) });
    await expectError('invalid_state', () => owner.startMachine(machine.id));
    // The removed teammate's start (their D-27 push window) isn't held to their old team's bill.
    await mate.startMachine(mateMachine.id);
    await machineIn(mate, mateMachine.id, (m) => m.state === 'running', 'mate push window');

    // Paid: the team is active and the machine starts again with its disk.
    stripe.acceptCards();
    await deliver(stripe.retryPayment());
    expect(await owner.getBilling()).toMatchObject({ status: 'active', graceEndsAt: null });
    await owner.startMachine(machine.id);
    await machineIn(owner, machine.id, (m) => m.state === 'running', 'running again');
  });

  it('refuses a webhook whose signature does not match', async () => {
    const response = await fetch(`${harness.url}/v1/billing/webhook`, { method: 'POST', headers: { 'stripe-signature': 't=1,v1=bad' }, body: '{}' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } });
  });
});
