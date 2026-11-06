import type { SubscriptionSnapshot } from './stripeGateway.ts';

/** What billing keeps per team. Seats, founding and the owner come from the service's team tables. */
export interface BillingRecord {
  teamId: string;
  customerId: string | null;
  /** Stripe's latest view of the team's subscription, refreshed on every webhook. */
  subscription: SubscriptionSnapshot | null;
  /** Set when a payment first fails; cleared when the subscription is paid again. */
  graceEndsAt: Date | null;
  noticeSentAt: Date | null;
}

/** The one billing notice: when it went out and when charges start for every team. */
export interface BillingNotice {
  issuedAt: Date;
  chargesStartAt: Date;
}

export interface BillingStore {
  getRecord(teamId: string): Promise<BillingRecord | null>;
  findTeamByCustomer(customerId: string): Promise<string | null>;
  saveRecord(record: BillingRecord): Promise<void>;
  getNotice(): Promise<BillingNotice | null>;
  saveNotice(notice: BillingNotice): Promise<void>;
}

export function emptyRecord(teamId: string): BillingRecord {
  return { teamId, customerId: null, subscription: null, graceEndsAt: null, noticeSentAt: null };
}

/** An in-process store for tests and local runs. */
export function createMemoryStore(): BillingStore {
  const records = new Map<string, BillingRecord>();
  let notice: BillingNotice | null = null;
  return {
    getRecord: async (teamId) => structuredClone(records.get(teamId) ?? null),
    findTeamByCustomer: async (customerId) => [...records.values()].find((r) => r.customerId === customerId)?.teamId ?? null,
    saveRecord: async (record) => void records.set(record.teamId, structuredClone(record)),
    getNotice: async () => structuredClone(notice),
    saveNotice: async (n) => void (notice = structuredClone(n)),
  };
}
