import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MACHINE_LIMITS, checkMachineId } from './limits.js';
import { MACHINE_CGROUP, cpuMax, statField } from './cgroup.js';

/** One machine's CPU use for one UTC day, kept so a host agent restart doesn't reset the budget. */
export interface BudgetRecord {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  /** CPU time the machine used this day, in microseconds, across restarts of its cgroup. */
  usedUsec: number;
  /** The cgroup's `usage_usec` at the last check. */
  lastUsageUsec: number;
  /** The cgroup directory's inode at the last check; a new one means the machine restarted and its counter began at 0. */
  cgroupId: string;
  throttled: boolean;
}

export interface BudgetStore {
  get(machineId: string): Promise<BudgetRecord | null>;
  set(machineId: string, record: BudgetRecord): Promise<void>;
}

/** What one check found, for the fleet API's metrics and events. */
export interface BudgetState {
  machineId: string;
  day: string;
  cpuSecondsUsed: number;
  throttled: boolean;
  /** Set on the check that throttled the machine, or the first check of a new day that lifted the throttle. */
  event: 'budget_exhausted' | 'budget_reset' | null;
}

export interface CpuBudget {
  /**
   * Reads the machine's `cpu.stat`, adds the CPU time since the last check to the day's total, and
   * writes `cpu.max`: 0.5 vCPU once the day's 43,200 vCPU-seconds are used, 8 vCPU otherwise.
   * Run it on a timer for every running machine, and once right before a stop so no use is lost.
   */
  check(machineId: string, cgroupPath: string): Promise<BudgetState>;
  /**
   * The cgroup files a machine starts with: MACHINE_CGROUP, with `cpu.max` at 0.5 vCPU when the
   * machine has used today's budget. Pass it as F1's `MachineSpec.cgroup` on every start, restore
   * and recovery, so a throttled machine never runs a moment at 8 vCPU after a restart.
   */
  cgroupFor(machineId: string, now?: Date): Promise<Record<string, string>>;
}

const FULL_CPU_MAX = cpuMax(MACHINE_LIMITS.vcpu);
const THROTTLED_CPU_MAX = cpuMax(MACHINE_LIMITS.throttledVcpu);
const BUDGET_USEC = MACHINE_LIMITS.dailyCpuSeconds * 1_000_000;

export function createCpuBudget(store: BudgetStore, options: { now?: () => Date } = {}): CpuBudget {
  const now = options.now ?? (() => new Date());
  return {
    async check(machineId, cgroupPath) {
      const usage = statField(await readFile(join(cgroupPath, 'cpu.stat'), 'utf8'), 'usage_usec');
      const cgroupId = (await stat(cgroupPath, { bigint: true })).ino.toString();
      const day = now().toISOString().slice(0, 10);
      const previous = await store.get(machineId);
      let event: BudgetState['event'] = null;
      let usedUsec: number;
      if (previous === null || previous.day !== day) {
        // A new day counts from now; time used since the last check before midnight is not charged.
        if (previous?.throttled) event = 'budget_reset';
        usedUsec = 0;
      } else {
        const sameCounter = previous.cgroupId === cgroupId && usage >= previous.lastUsageUsec;
        usedUsec = previous.usedUsec + (sameCounter ? usage - previous.lastUsageUsec : usage);
      }
      const throttled = usedUsec >= BUDGET_USEC;
      if (throttled && !previous?.throttled) event = 'budget_exhausted';
      // Written every check: the jailer starts a restarted machine at 8 vCPU.
      const cpuMaxPath = join(cgroupPath, 'cpu.max');
      const wanted = throttled ? THROTTLED_CPU_MAX : FULL_CPU_MAX;
      if ((await readFile(cpuMaxPath, 'utf8')).trim() !== wanted) await writeFile(cpuMaxPath, wanted);
      await store.set(machineId, { day, usedUsec, lastUsageUsec: usage, cgroupId, throttled });
      return { machineId, day, cpuSecondsUsed: usedUsec / 1_000_000, throttled, event };
    },

    async cgroupFor(machineId, at = now()) {
      const record = await store.get(machineId);
      const throttled = record?.day === at.toISOString().slice(0, 10) && record.throttled;
      return { ...MACHINE_CGROUP, 'cpu.max': throttled ? THROTTLED_CPU_MAX : FULL_CPU_MAX };
    },
  };
}

/** Keeps each machine's record in `<dir>/<machineId>.json`, replaced atomically. */
export function createFileBudgetStore(dir: string): BudgetStore {
  const pathOf = (machineId: string) => join(dir, `${checkMachineId(machineId)}.json`);
  return {
    async get(machineId) {
      let text: string;
      try {
        text = await readFile(pathOf(machineId), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
      // An unreadable record restarts the day's count rather than blocking the budget.
      try {
        const record: unknown = JSON.parse(text);
        return isBudgetRecord(record) ? record : null;
      } catch {
        return null;
      }
    },
    async set(machineId, record) {
      await mkdir(dir, { recursive: true });
      const path = pathOf(machineId);
      await writeFile(`${path}.tmp`, JSON.stringify(record));
      await rename(`${path}.tmp`, path);
    },
  };
}

function isBudgetRecord(value: unknown): value is BudgetRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.day === 'string' &&
    typeof r.usedUsec === 'number' &&
    typeof r.lastUsageUsec === 'number' &&
    typeof r.cgroupId === 'string' &&
    typeof r.throttled === 'boolean'
  );
}
