/**
 * Runs against the real cgroup v2 hierarchy. Needs root and FLEET_CGROUP_TEST_PARENT: a cgroup under
 * /sys/fs/cgroup with the cpu, memory and pids controllers enabled for its children.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { applyCeilings, createCpuBudget, type BudgetRecord, type BudgetStore } from './index.js';

const parent = process.env.FLEET_CGROUP_TEST_PARENT ?? '';
const canRun = parent !== '' && process.getuid?.() === 0;

const usageSeconds = async (cgroup: string) => {
  const line = (await readFile(join(cgroup, 'cpu.stat'), 'utf8')).split('\n').find((l) => l.startsWith('usage_usec '));
  return Number(line?.split(' ')[1]) / 1_000_000;
};

async function cpusUsedOver(cgroup: string, ms: number): Promise<number> {
  const before = await usageSeconds(cgroup);
  await new Promise((r) => setTimeout(r, ms));
  return (await usageSeconds(cgroup)) - before;
}

describe.skipIf(!canRun)('fair use on real cgroups', () => {
  const cgroup = join('/sys/fs/cgroup', parent, `fair-use-${process.pid}`);
  let burner: ChildProcess | undefined;

  beforeAll(async () => {
    await mkdir(cgroup);
  });

  afterAll(async () => {
    burner?.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 200));
    await rmdir(cgroup).catch(() => undefined);
  });

  test('the kernel takes every ceiling', async () => {
    await applyCeilings(cgroup);
    const read = async (file: string) => (await readFile(join(cgroup, file), 'utf8')).trim();
    expect(await read('cpu.max')).toBe('800000 100000');
    expect(await read('cpu.weight')).toBe('100');
    expect(Number(await read('memory.max'))).toBeGreaterThan(16 * 1024 ** 3);
    expect(await read('memory.swap.max')).toBe('0');
    expect(await read('pids.max')).toBe('64');
  });

  test('a CPU burner runs at about 0.5 CPU once the day’s budget is used, and at full speed after midnight', async () => {
    burner = spawn(process.execPath, ['-e', 'for (;;) {}'], { stdio: 'ignore' });
    await writeFile(join(cgroup, 'cgroup.procs'), String(burner.pid));

    const today = '2026-11-05';
    const records = new Map<string, BudgetRecord>([['burner', { day: today, usedUsec: 43_200 * 1_000_000, lastUsageUsec: 0, cgroupId: '', throttled: false }]]);
    const store: BudgetStore = { get: async (id) => records.get(id) ?? null, set: async (id, r) => void records.set(id, r) };
    let clock = new Date(`${today}T23:00:00Z`);
    const budget = createCpuBudget(store, { now: () => clock });

    expect(await budget.check('burner', cgroup)).toMatchObject({ throttled: true, event: 'budget_exhausted' });
    const throttled = await cpusUsedOver(cgroup, 3_000);
    console.log(`throttled burner: ${(throttled / 3).toFixed(3)} CPU`);
    expect(throttled / 3).toBeGreaterThan(0.4);
    expect(throttled / 3).toBeLessThan(0.55);

    clock = new Date('2026-11-06T00:00:10Z');
    expect(await budget.check('burner', cgroup)).toMatchObject({ throttled: false, event: 'budget_reset' });
    const free = await cpusUsedOver(cgroup, 3_000);
    console.log(`unthrottled burner: ${(free / 3).toFixed(3)} CPU`);
    expect(free / 3).toBeGreaterThan(0.8);
  }, 20_000);
});
