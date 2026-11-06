import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createCpuBudget, createFileBudgetStore } from './index.js';

const FULL = '800000 100000'; // 8 vCPU
const THROTTLED = '50000 100000'; // 0.5 vCPU

let work: string;
let cgroup: string;
let clock: Date;

/** A stand-in cgroup directory with the files the budget reads and writes, as the jailer leaves them. */
async function startCgroup(): Promise<void> {
  await rm(cgroup, { recursive: true, force: true });
  await mkdir(cgroup, { recursive: true });
  await writeFile(join(cgroup, 'cpu.max'), `${FULL}\n`);
  await setUsage(0);
}
const setUsage = (seconds: number) => writeFile(join(cgroup, 'cpu.stat'), `usage_usec ${seconds * 1_000_000}\nuser_usec 0\nsystem_usec 0\n`);
const cpuMax = async () => (await readFile(join(cgroup, 'cpu.max'), 'utf8')).trim();
const budget = () => createCpuBudget(createFileBudgetStore(join(work, 'budget')), { now: () => clock });

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'fair-use-budget-'));
  cgroup = join(work, 'cgroup', 'm1');
  await startCgroup();
});
afterEach(() => rm(work, { recursive: true, force: true }));

describe('daily CPU budget', () => {
  test('throttles to 0.5 vCPU after 12 vCPU-hours in a UTC day and restores 8 vCPU at the next UTC midnight', async () => {
    const b = budget();
    clock = new Date('2026-11-05T06:00:00Z');
    await setUsage(100);
    expect(await b.check('m1', cgroup)).toMatchObject({ day: '2026-11-05', cpuSecondsUsed: 0, throttled: false, event: null });

    clock = new Date('2026-11-05T20:00:00Z');
    await setUsage(100 + 43_199);
    expect(await b.check('m1', cgroup)).toMatchObject({ cpuSecondsUsed: 43_199, throttled: false, event: null });
    expect(await cpuMax()).toBe(FULL);

    clock = new Date('2026-11-05T20:01:00Z');
    await setUsage(100 + 43_200);
    expect(await b.check('m1', cgroup)).toMatchObject({ cpuSecondsUsed: 43_200, throttled: true, event: 'budget_exhausted' });
    expect(await cpuMax()).toBe(THROTTLED);

    clock = new Date('2026-11-05T23:59:00Z');
    await setUsage(100 + 43_200 + 3_500);
    expect(await b.check('m1', cgroup)).toMatchObject({ throttled: true, event: null });
    expect(await cpuMax()).toBe(THROTTLED);

    clock = new Date('2026-11-06T00:00:30Z');
    await setUsage(100 + 43_200 + 3_515);
    expect(await b.check('m1', cgroup)).toMatchObject({ day: '2026-11-06', cpuSecondsUsed: 0, throttled: false, event: 'budget_reset' });
    expect(await cpuMax()).toBe(FULL);

    clock = new Date('2026-11-06T01:00:00Z');
    await setUsage(100 + 43_200 + 3_515 + 3_600);
    expect(await b.check('m1', cgroup)).toMatchObject({ cpuSecondsUsed: 3_600, throttled: false, event: null });
  });

  test('a throttled machine starts throttled until the next UTC midnight', async () => {
    const b = budget();
    clock = new Date('2026-11-05T08:00:00Z');
    expect((await b.cgroupFor('m1'))['cpu.max']).toBe(FULL); // never seen
    await b.check('m1', cgroup);
    clock = new Date('2026-11-05T20:00:00Z');
    await setUsage(43_200);
    await b.check('m1', cgroup);

    // What F2 hands the jailer when it starts, restores or recovers the machine.
    const atStart = await b.cgroupFor('m1');
    expect(atStart['cpu.max']).toBe(THROTTLED);
    expect(atStart['memory.swap.max']).toBe('0');
    expect((await b.cgroupFor('m1', new Date('2026-11-05T23:59:59Z')))['cpu.max']).toBe(THROTTLED);
    expect((await b.cgroupFor('m1', new Date('2026-11-06T00:00:00Z')))['cpu.max']).toBe(FULL);
  });

  test('a host agent restart keeps the day’s usage', async () => {
    clock = new Date('2026-11-05T08:00:00Z');
    await setUsage(1_000);
    await budget().check('m1', cgroup);
    clock = new Date('2026-11-05T12:00:00Z');
    await setUsage(31_000);
    expect(await budget().check('m1', cgroup)).toMatchObject({ cpuSecondsUsed: 30_000 });

    // A new budget and store over the same directory, as after the agent restarts.
    clock = new Date('2026-11-05T13:00:00Z');
    await setUsage(44_200);
    expect(await budget().check('m1', cgroup)).toMatchObject({ cpuSecondsUsed: 43_200, throttled: true, event: 'budget_exhausted' });
    expect(await cpuMax()).toBe(THROTTLED);
  });

  test('a machine restarted the same day keeps its usage and its throttle', async () => {
    clock = new Date('2026-11-05T08:00:00Z');
    await budget().check('m1', cgroup);
    clock = new Date('2026-11-05T15:00:00Z');
    await setUsage(43_500);
    expect(await budget().check('m1', cgroup)).toMatchObject({ throttled: true });

    // Stop and resume: a new cgroup whose counter starts at 0 and whose cpu.max the jailer set to 8 vCPU.
    await startCgroup();
    await setUsage(60);
    clock = new Date('2026-11-05T16:00:00Z');
    expect(await budget().check('m1', cgroup)).toMatchObject({ cpuSecondsUsed: 43_560, throttled: true, event: null });
    expect(await cpuMax()).toBe(THROTTLED);
  });
});
