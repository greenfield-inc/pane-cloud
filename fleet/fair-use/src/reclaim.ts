import type { BalloonStats } from '@pane-cloud/fleet-runtime';
import { MACHINE_LIMITS } from './limits.js';

const MiB = 1024 ** 2;

/** The margin triggers from the plan's "Fair use and margin" section, and the balloon policy. */
export const RECLAIM_RULES = {
  /**
   * Rule 2: while the host is above `stopAboveHostFraction`, a machine above this now, and above it
   * for `residentLimitForMs` in total within the last `residentWindowMs`, is stopped. A total over a
   * window, not an unbroken streak, so a guest can't reset the clock by dipping for one sample.
   */
  residentLimitMiB: 12 * 1024,
  residentLimitForMs: 10 * 60_000,
  residentWindowMs: 15 * 60_000,
  stopAboveHostFraction: 0.75,
  /** Rule 3: at this host use, machines above 12 GiB and then the largest idle machines are stopped until the host is under it. */
  stopIdleAtHostFraction: 0.85,
  /** Rule 1: an idle guest keeps this much memory free above what it uses. */
  keepAvailableMiB: 1024,
  /** Rule 1: the balloon never leaves a guest less than this. */
  minGuestMiB: 2048,
  /** Rule 1: the balloon is moved only by at least this much, so it doesn't churn. */
  minStepMiB: 256,
} as const;

export interface HostSample {
  totalMiB: number;
  usedMiB: number;
}

export interface MachineSample {
  machineId: string;
  /** Host-side resident memory (`readResidentMiB`). */
  residentMiB: number;
  /** No agent running and no client connected, as the idle stop sees it. */
  idle: boolean;
  /** The Firecracker balloon's state and the guest's own counters; null when unreadable. */
  balloon: BalloonStats | null;
  /**
   * How long, in total, `residentMiB` was above 12 GiB within the last 15 minutes. Each sample above
   * 12 GiB counts for the time since the sample before it.
   */
  residentAboveLimitMsInWindow: number;
}

export interface ReclaimAction {
  kind: 'inflate' | 'deflate' | 'snapshot_stop';
  machineId: string;
  /** The balloon size to set, for inflate and deflate. */
  targetMiB?: number;
  reason: string;
}

/**
 * Decides what the host agent does about memory this tick. Stops come from host-side numbers only,
 * so a guest that unloads its balloon driver or lies in its statistics is still caught. Every
 * `snapshot_stop` is a stop with the contract's `memory_pressure` reason.
 */
export function decideReclaim(host: HostSample, machines: readonly MachineSample[]): ReclaimAction[] {
  const r = RECLAIM_RULES;
  const stops: ReclaimAction[] = [];
  let usedMiB = host.usedMiB;

  if (host.usedMiB > host.totalMiB * r.stopAboveHostFraction) {
    for (const m of machines) {
      if (m.residentMiB > r.residentLimitMiB && m.residentAboveLimitMsInWindow >= r.residentLimitForMs) {
        stops.push({ kind: 'snapshot_stop', machineId: m.machineId, reason: `Host memory is above 75% and this machine held more than 12 GiB for ${Math.floor(m.residentAboveLimitMsInWindow / 60_000)} of the last 15 minutes.` });
        usedMiB -= m.residentMiB;
      }
    }
  }

  const line = host.totalMiB * r.stopIdleAtHostFraction;
  if (usedMiB >= line) {
    const stopping = new Set(stops.map((s) => s.machineId));
    const largestFirst = (list: MachineSample[]) => list.sort((a, b) => b.residentMiB - a.residentMiB);
    const candidates = machines.filter((m) => !stopping.has(m.machineId));
    // Machines over 12 GiB go first, busy or not, so one large guest can't push out other tenants' idle machines.
    const overLimit = largestFirst(candidates.filter((m) => m.residentMiB > r.residentLimitMiB));
    const idle = largestFirst(candidates.filter((m) => m.idle && m.residentMiB <= r.residentLimitMiB));
    for (const m of [...overLimit, ...idle]) {
      if (usedMiB < line) break;
      const why = m.residentMiB > r.residentLimitMiB ? 'machines above 12 GiB are stopped first' : 'the largest idle machines are stopped next';
      stops.push({ kind: 'snapshot_stop', machineId: m.machineId, reason: `Host memory reached 85%; ${why}.` });
      usedMiB -= m.residentMiB;
    }
  }

  const stopping = new Set(stops.map((s) => s.machineId));
  const balloons: ReclaimAction[] = [];
  for (const m of machines) {
    const b = m.balloon;
    if (stopping.has(m.machineId) || b === null) continue;
    if (!m.idle) {
      if (b.targetMiB > 0) balloons.push({ kind: 'deflate', machineId: m.machineId, targetMiB: 0, reason: 'The machine is in use again; it gets its full memory back.' });
      continue;
    }
    // Wait for the guest to reach the last target before setting a new one, and for its counters.
    if (b.availableMemory === undefined || b.actualMiB < b.targetMiB) continue;
    const wanted = Math.min(MACHINE_LIMITS.memoryMiB - r.minGuestMiB, b.actualMiB + Math.floor(b.availableMemory / MiB) - r.keepAvailableMiB);
    if (wanted >= b.targetMiB + r.minStepMiB) {
      balloons.push({ kind: 'inflate', machineId: m.machineId, targetMiB: wanted, reason: 'The machine is idle; its free memory and page cache go back to the host.' });
    }
  }
  return [...stops, ...balloons];
}
