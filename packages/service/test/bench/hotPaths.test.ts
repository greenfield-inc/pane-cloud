/**
 * The service hot-path budget: a 500-seat team with 90 days of actions (about 500,000 action-log
 * rows) keeps p95 under 200 ms for the team's machine list and a machine's action log.
 * Run with `pnpm bench`; skipped in the normal test run.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from '../support/harness';

const SEATS = 500;
const ROWS = 500_000;
const SAMPLES = 200;
const BUDGET_MS = 200;

async function p95(call: () => Promise<unknown>): Promise<number> {
  for (let i = 0; i < 10; i += 1) await call();
  const times: number[] = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    const start = performance.now();
    await call();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(SAMPLES * 0.95)] ?? Infinity;
}

describe.skipIf(!process.env.BENCH)('service hot paths at 500 seats and 500,000 action-log rows', () => {
  let harness: Harness;
  let owner: ReturnType<Harness['client']>;
  let ownerMachine = '';
  const results: Record<string, number> = {};

  beforeAll(async () => {
    harness = await startHarness();
    await harness.cohort('bench-owner');
    owner = harness.client(await harness.signIn({ id: 1, login: 'bench-owner' }));
    const account = await owner.getAccount();
    const teamId = account.teamId;
    const db = harness.db;
    await db.query(
      `INSERT INTO accounts (id, github_id, github_login, name, tailscale_login)
       SELECT 'acct_b' || g, 100000 + g, 'member-' || g, 'Member ' || g, 'member-' || g || '@github' FROM generate_series(2, $1) g`,
      [SEATS],
    );
    await db.query(`INSERT INTO seats (account_id, team_id, role, founding_price) SELECT 'acct_b' || g, $1, 'member', true FROM generate_series(2, $2) g`, [teamId, SEATS]);
    await db.query(
      `INSERT INTO machines (id, owner_account_id, name, idempotency_key, state, tailnet_status, tailnet_hostname, shared_at, created_at)
       SELECT 'm_b' || g, CASE WHEN g = 1 THEN $1 ELSE 'acct_b' || g END, 'machine ' || g, 'key-' || g, 'running', 'joined', 'pane-' || g || '.ts.net', now() - interval '1 day', now() - interval '90 days'
       FROM generate_series(1, $2) g`,
      [account.id, SEATS],
    );
    ownerMachine = 'm_b1';
    await db.query(
      `INSERT INTO action_log (machine_id, batch, request_id, operation, fleet_operation, parameters, actor_kind, reason, status, requested_at, finished_at)
       SELECT 'm_b' || (1 + g % $2), gen_random_uuid(), gen_random_uuid(), 'collect_diagnostics', 'collect_diagnostics', '{}', 'service', 'bench', 'succeeded',
              now() - (g || ' seconds')::interval * (90 * 86400 / $1::float), now()
       FROM generate_series(1, $1) g`,
      [ROWS, SEATS],
    );
    await db.query('ANALYZE');
  }, 300_000);
  afterAll(async () => {
    console.log('hot path p95 (ms):', JSON.stringify(results));
    await harness.close();
  });

  it('lists the team’s shared machines', async () => {
    expect((await owner.listSharedMachines()).machines.length).toBe(SEATS);
    results.listSharedMachines = await p95(() => owner.listSharedMachines());
    expect(results.listSharedMachines).toBeLessThan(BUDGET_MS);
  }, 120_000);

  it('lists the team roster', async () => {
    expect((await owner.getTeam()).members.length).toBe(SEATS);
    results.getTeam = await p95(() => owner.getTeam());
    expect(results.getTeam).toBeLessThan(BUDGET_MS);
  }, 120_000);

  it('reads a machine’s action log, first and deep pages', async () => {
    const first = await owner.listActionLog(ownerMachine, { limit: 50 });
    expect(first.entries.length).toBe(50);
    results.actionLogFirstPage = await p95(() => owner.listActionLog(ownerMachine, { limit: 50 }));
    const deepCursor = (await harness.db.query<{ id: string }>('SELECT id FROM action_log WHERE machine_id = $1 ORDER BY id OFFSET 900 LIMIT 1', [ownerMachine])).rows[0]?.id;
    results.actionLogDeepPage = await p95(() => owner.listActionLog(ownerMachine, { limit: 200, before: `act_${deepCursor}` }));
    expect(results.actionLogFirstPage).toBeLessThan(BUDGET_MS);
    expect(results.actionLogDeepPage).toBeLessThan(BUDGET_MS);
  }, 120_000);
});
