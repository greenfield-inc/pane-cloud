import type { BillingNotice, BillingRecord, BillingStore } from './store.ts';
import type { SubscriptionSnapshot } from './stripeGateway.ts';

/** The part of a `pg` Pool or Client the store uses. */
export interface Queryable {
  query<R extends object>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
}

interface RecordRow {
  team_id: string;
  stripe_customer_id: string | null;
  subscription: (Omit<SubscriptionSnapshot, 'currentPeriodEnd' | 'trialEnd'> & { currentPeriodEnd: string | null; trialEnd: string | null }) | null;
  grace_ends_at: Date | null;
  notice_sent_at: Date | null;
}

const toDate = (s: string | null) => (s === null ? null : new Date(s));

function fromRow(row: RecordRow): BillingRecord {
  const sub = row.subscription;
  return {
    teamId: row.team_id,
    customerId: row.stripe_customer_id,
    subscription: sub && { ...sub, currentPeriodEnd: toDate(sub.currentPeriodEnd), trialEnd: toDate(sub.trialEnd) },
    graceEndsAt: row.grace_ends_at,
    noticeSentAt: row.notice_sent_at,
  };
}

/** Billing state in the service's Postgres, in the tables `migrations/100_billing.sql` creates. */
export function createPgStore(db: Queryable): BillingStore {
  return {
    async getRecord(teamId) {
      const { rows } = await db.query<RecordRow>('SELECT * FROM billing_teams WHERE team_id = $1', [teamId]);
      return rows[0] ? fromRow(rows[0]) : null;
    },
    async findTeamByCustomer(customerId) {
      const { rows } = await db.query<{ team_id: string }>('SELECT team_id FROM billing_teams WHERE stripe_customer_id = $1', [customerId]);
      return rows[0]?.team_id ?? null;
    },
    async saveRecord(r) {
      await db.query(
        `INSERT INTO billing_teams (team_id, stripe_customer_id, subscription, grace_ends_at, notice_sent_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (team_id) DO UPDATE SET stripe_customer_id = $2, subscription = $3, grace_ends_at = $4, notice_sent_at = $5, updated_at = now()`,
        [r.teamId, r.customerId, r.subscription && JSON.stringify(r.subscription), r.graceEndsAt, r.noticeSentAt],
      );
    },
    async getNotice() {
      const { rows } = await db.query<{ issued_at: Date; charges_start_at: Date }>('SELECT issued_at, charges_start_at FROM billing_notice');
      const row = rows[0];
      return row ? { issuedAt: row.issued_at, chargesStartAt: row.charges_start_at } : null;
    },
    async saveNotice(n: BillingNotice) {
      await db.query(
        `INSERT INTO billing_notice (id, issued_at, charges_start_at) VALUES (true, $1, $2)
         ON CONFLICT (id) DO UPDATE SET issued_at = $1, charges_start_at = $2`,
        [n.issuedAt, n.chargesStartAt],
      );
    },
  };
}
