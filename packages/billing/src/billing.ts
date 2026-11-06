import type { BillingStatus } from 'pane-cloud-contract';
import Stripe from 'stripe';
import { type BillingNotice, type BillingRecord, type BillingStore, emptyRecord } from './store.ts';
import { PRICE_LOOKUP_KEYS, type SeatPrice, type StripeGateway } from './stripeGateway.ts';

const DAY_MS = 86_400_000;
export const GRACE_DAYS = 7;

/** What billing reads from the service's team tables. */
export interface BillingTeam {
  id: string;
  createdAt: Date;
  /** Joined during the free cohort: every seat keeps the founding $49 price. */
  founding: boolean;
  ownerAccountId: string;
  /** Null when the owner's GitHub email is private; they get no notice until it is known. */
  ownerEmail: string | null;
  /** Billed seats: the owner plus every member. */
  seats: number;
}

export interface BillingDeps {
  stripe: StripeGateway;
  webhookSecret: string;
  store: BillingStore;
  teams: { getTeam(teamId: string): Promise<BillingTeam | null>; listTeamIds(): Promise<string[]> };
  /** Stops every running machine on the team through the service's signed stop, logged with actor `service`. Disks are kept. */
  machines: { stopTeamMachines(teamId: string, reason: string): Promise<void> };
  mailer: { send(mail: { to: string; subject: string; text: string }): Promise<void> };
  /** Where Checkout and the customer portal send the owner back to. */
  returnUrl: string;
  now?: () => Date;
}

/** Teams in these states may not run machines. */
const STOPPED_STATES = new Set<BillingStatus['status']>(['past_due', 'canceled']);

export function createBilling(deps: BillingDeps) {
  const { stripe, store, teams } = deps;
  const now = deps.now ?? (() => new Date());

  async function requireTeam(teamId: string): Promise<BillingTeam> {
    const team = await teams.getTeam(teamId);
    if (!team) throw new Error(`No team ${teamId}.`);
    return team;
  }

  async function seatPrice(team: BillingTeam): Promise<SeatPrice> {
    return stripe.findPrice(team.founding ? PRICE_LOOKUP_KEYS.founding : PRICE_LOOKUP_KEYS.standard);
  }

  /** The team's billing state, derived from Stripe's last word, the notice and the clock. */
  function derive(record: BillingRecord, notice: BillingNotice | null): Pick<BillingStatus, 'plan' | 'status' | 'graceEndsAt'> {
    const t = now();
    const sub = record.subscription;
    const started = notice !== null && t >= notice.chargesStartAt;
    const grace = (endsAt: Date) => ({ status: t < endsAt ? ('grace' as const) : ('past_due' as const), graceEndsAt: endsAt.toISOString() });

    if (!sub || sub.status === 'canceled' || sub.status === 'incomplete_expired') {
      if (sub) return { plan: 'paid', status: 'canceled', graceEndsAt: null };
      if (!notice || !started) return { plan: 'cohort', status: 'free', graceEndsAt: null };
      return { plan: 'paid', ...grace(new Date(notice.chargesStartAt.getTime() + GRACE_DAYS * DAY_MS)) };
    }
    if (sub.status === 'active' || sub.status === 'trialing') return started ? { plan: 'paid', status: 'active', graceEndsAt: null } : { plan: 'cohort', status: 'free', graceEndsAt: null };
    // past_due, unpaid, incomplete, paused: the card failed or was never confirmed.
    return { plan: 'paid', ...grace(record.graceEndsAt ?? new Date(t.getTime() + GRACE_DAYS * DAY_MS)) };
  }

  async function ensureCustomer(record: BillingRecord, team: BillingTeam): Promise<string> {
    if (record.customerId) return record.customerId;
    record.customerId = await stripe.createCustomer({ teamId: team.id, email: team.ownerEmail });
    await store.saveRecord(record);
    return record.customerId;
  }

  /** Checkout to add a card (or to come back after cancelling); the customer portal for everything else. */
  async function manageUrl(record: BillingRecord, team: BillingTeam, notice: BillingNotice, price: SeatPrice): Promise<string> {
    const customerId = await ensureCustomer(record, team);
    const sub = record.subscription;
    if (sub && sub.status !== 'canceled' && sub.status !== 'incomplete_expired') {
      return stripe.createPortalSession({ customerId, returnUrl: deps.returnUrl });
    }
    const firstChargeAt = notice.chargesStartAt > now() ? notice.chargesStartAt : null;
    return stripe.createCheckoutSession({ customerId, teamId: team.id, priceId: price.id, quantity: team.seats, firstChargeAt, returnUrl: deps.returnUrl });
  }

  async function status(teamId: string): Promise<BillingStatus['status']> {
    const [record, notice] = await Promise.all([store.getRecord(teamId), store.getNotice()]);
    return derive(record ?? emptyRecord(teamId), notice).status;
  }

  /** Matches the subscription's seat count to the team's; a no-op without a live subscription or when they agree. */
  async function syncSeats(teamId: string): Promise<void> {
    const [team, record] = await Promise.all([requireTeam(teamId), store.getRecord(teamId)]);
    const sub = record?.subscription;
    if (!record || !sub || sub.status === 'canceled' || sub.status === 'incomplete_expired' || sub.quantity === team.seats) return;
    await stripe.setSeatQuantity(sub.id, team.seats);
    record.subscription = { ...sub, quantity: team.seats };
    await store.saveRecord(record);
  }

  return {
    /** GET /v1/billing. Only the owner gets a manage link; creating it may call Stripe. */
    async getBillingStatus(teamId: string, viewerAccountId: string): Promise<BillingStatus> {
      const team = await requireTeam(teamId);
      const [stored, notice, price] = await Promise.all([store.getRecord(teamId), store.getNotice(), seatPrice(team)]);
      const record = stored ?? emptyRecord(teamId);
      const isOwner = viewerAccountId === team.ownerAccountId;
      return {
        teamId,
        ...derive(record, notice),
        seatPriceCents: price.unitAmountCents,
        currency: 'usd',
        foundingPriceLocked: team.founding,
        seats: team.seats,
        chargesStartAt: notice?.chargesStartAt.toISOString() ?? null,
        currentPeriodEnd: record.subscription?.currentPeriodEnd?.toISOString() ?? null,
        manageUrl: isOwner && notice ? await manageUrl(record, team, notice, price) : null,
      };
    },

    /** Whether the team may create or start machines. */
    async machinesAllowed(teamId: string): Promise<boolean> {
      return !STOPPED_STATES.has(await status(teamId));
    },

    /** Call after a member joins or leaves (E2). Stripe prorates the change onto the next invoice. */
    syncSeats,

    /**
     * Sets the date charges start for every team and emails each owner once. Running it again emails
     * only owners who haven't had it. Returns how many were emailed, and the teams whose owner has no email.
     */
    async announceCharges(chargesStartAt: Date): Promise<{ emailed: number; noEmail: string[] }> {
      if (chargesStartAt <= now()) throw new Error('The charge start date must be in the future.');
      const existing = await store.getNotice();
      await store.saveNotice({ issuedAt: existing?.issuedAt ?? now(), chargesStartAt });
      const result = { emailed: 0, noEmail: [] as string[] };
      for (const teamId of await teams.listTeamIds()) {
        const record = (await store.getRecord(teamId)) ?? emptyRecord(teamId);
        if (record.noticeSentAt) continue;
        const team = await requireTeam(teamId);
        if (!team.ownerEmail) {
          result.noEmail.push(teamId);
          continue;
        }
        await deps.mailer.send(noticeEmail({ ...team, ownerEmail: team.ownerEmail }, (await seatPrice(team)).unitAmountCents, chargesStartAt));
        record.noticeSentAt = now();
        await store.saveRecord(record);
        result.emailed += 1;
      }
      return result;
    },

    /** POST /v1/billing/webhook with the raw body and the Stripe-Signature header. Throws on a bad signature. */
    async handleWebhook(rawBody: string | Buffer, signature: string): Promise<void> {
      const event = Stripe.webhooks.constructEvent(rawBody, signature, deps.webhookSecret);
      const object = event.data.object as { customer?: unknown };
      const customerId = typeof object.customer === 'string' ? object.customer : null;
      if (!customerId) return;
      const teamId = await store.findTeamByCustomer(customerId);
      if (!teamId) return;
      const record = (await store.getRecord(teamId)) ?? emptyRecord(teamId);
      // Read Stripe's current state instead of trusting the event, so retries and out-of-order deliveries agree.
      const sub = await stripe.latestSubscription(customerId);
      const failing = sub !== null && !['active', 'trialing', 'canceled', 'incomplete_expired'].includes(sub.status);
      record.subscription = sub;
      record.graceEndsAt = failing ? (record.graceEndsAt ?? new Date(now().getTime() + GRACE_DAYS * DAY_MS)) : null;
      await store.saveRecord(record);
    },

    /**
     * Run on a schedule: catches up seat counts a failed Stripe call missed, and stops the machines of
     * teams whose grace ran out or whose subscription ended.
     */
    async enforce(): Promise<void> {
      const failures: unknown[] = [];
      for (const teamId of await teams.listTeamIds()) {
        try {
          const s = await status(teamId);
          if (s === 'past_due') await deps.machines.stopTeamMachines(teamId, 'Payment failed and the 7-day grace period ended. Your disk is kept; machines start again once the bill is paid.');
          if (s === 'canceled') await deps.machines.stopTeamMachines(teamId, 'The Pane Cloud subscription ended. Your disk is kept.');
          await syncSeats(teamId);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) throw new AggregateError(failures, `Billing enforcement failed for ${failures.length} team(s).`);
    },
  };
}

export type Billing = ReturnType<typeof createBilling>;

const dollars = (cents: number) => `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;

function noticeEmail(team: BillingTeam & { ownerEmail: string }, seatCents: number, startAt: Date) {
  const date = startAt.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' });
  const seats = `${team.seats} ${team.seats === 1 ? 'seat' : 'seats'}`;
  const lines = [
    `Pane Cloud starts charging on ${date}.`,
    '',
    `Each seat costs ${dollars(seatCents)} a month. Your team has ${seats}, so your bill will be ${dollars(seatCents * team.seats)} a month.`,
    ...(team.founding ? ['', `You joined as a founding team, so you keep ${dollars(seatCents)} a seat even if the price goes up.`] : []),
    '',
    `Add a card in Pane before ${date}: open Settings, then Remote Access, then Pane Cloud billing. If no card is on file by then, your machines keep running for ${GRACE_DAYS} days, then stop with their disks kept.`,
    '',
    'You can cancel at any time from the same place; billing stops at the end of the paid month.',
  ];
  return { to: team.ownerEmail, subject: `Pane Cloud billing starts ${date}`, text: lines.join('\n') };
}
