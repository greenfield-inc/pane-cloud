import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, describe, expect, test } from 'vitest';
import { createPgStore } from './pgStore.ts';
import { type BillingStore, createMemoryStore, emptyRecord } from './store.ts';

async function pgStore(): Promise<{ store: BillingStore; close: () => Promise<void> }> {
  const client = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await client.connect();
  const schema = `billing_test_${process.pid}_${Date.now()}`;
  await client.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
  // The service's 001 migration owns teams; billing only needs its key.
  await client.query('CREATE TABLE teams (id text PRIMARY KEY)');
  await client.query("INSERT INTO teams (id) VALUES ('team_a'), ('team_b')");
  await client.query(await readFile(new URL('../migrations/100_billing.sql', import.meta.url), 'utf8'));
  return { store: createPgStore(client), close: async () => (await client.query(`DROP SCHEMA ${schema} CASCADE`), await client.end()) };
}

const stores: [string, () => Promise<{ store: BillingStore; close: () => Promise<void> }>][] = [
  ['memory', async () => ({ store: createMemoryStore(), close: async () => {} })],
  ...(process.env.TEST_DATABASE_URL ? [['postgres', pgStore] as [string, typeof pgStore]] : []),
];

describe.each(stores)('%s store', (_name, open) => {
  const opened: (() => Promise<void>)[] = [];
  afterAll(async () => {
    for (const close of opened) await close();
  });

  test('saves a team record and finds it by Stripe customer', async () => {
    const { store, close } = await open();
    opened.push(close);
    expect(await store.getRecord('team_a')).toBeNull();
    const record = {
      ...emptyRecord('team_a'),
      customerId: 'cus_1',
      subscription: { id: 'sub_1', status: 'past_due' as const, quantity: 3, currentPeriodEnd: new Date('2026-12-19T12:00:00Z'), cancelAtPeriodEnd: false },
      graceEndsAt: new Date('2026-11-26T12:00:00Z'),
    };
    await store.saveRecord(record);
    await store.saveRecord({ ...emptyRecord('team_b'), customerId: 'cus_2' });
    expect(await store.getRecord('team_a')).toEqual(record);
    expect(await store.findTeamByCustomer('cus_2')).toBe('team_b');
    expect(await store.findTeamByCustomer('cus_none')).toBeNull();

    await store.saveRecord({ ...record, subscription: null, graceEndsAt: null });
    expect(await store.getRecord('team_a')).toEqual({ ...record, subscription: null, graceEndsAt: null });
  });

  test('keeps one notice and replaces it', async () => {
    const { store, close } = await open();
    opened.push(close);
    expect(await store.getNotice()).toBeNull();
    const first = { issuedAt: new Date('2026-11-05T12:00:00Z'), chargesStartAt: new Date('2026-11-19T12:00:00Z') };
    await store.saveNotice(first);
    await store.saveNotice({ ...first, chargesStartAt: new Date('2026-11-26T12:00:00Z') });
    expect(await store.getNotice()).toEqual({ ...first, chargesStartAt: new Date('2026-11-26T12:00:00Z') });
  });
});
