import { describe, expect, test } from 'vitest';
import { decideReclaim, type HostSample, type MachineSample } from './index.js';

const GiB = 1024; // in MiB
const MINUTE = 60_000;
// r7g.metal: 512 GiB.
const hostAt = (fraction: number): HostSample => ({ totalMiB: 512 * GiB, usedMiB: 512 * GiB * fraction });

function machine(overrides: Partial<MachineSample> & { machineId: string }): MachineSample {
  return { residentMiB: 3 * GiB, idle: false, balloon: { targetMiB: 0, actualMiB: 0 }, residentAboveLimitMsInWindow: 0, ...overrides };
}

const stopped = (host: HostSample, machines: MachineSample[]) =>
  decideReclaim(host, machines)
    .filter((a) => a.kind === 'snapshot_stop')
    .map((a) => a.machineId);

describe('stop at 12 GiB for 10 of the last 15 minutes while the host is above 75%', () => {
  // Journey 5: a guest with its balloon driver unloaded reports nothing and holds 14 GiB.
  const hostile = machine({ machineId: 'hostile', residentMiB: 14 * GiB, balloon: { targetMiB: 0, actualMiB: 0 } });

  test('stops a guest that ignores its balloon once it has held the memory for 10 minutes', () => {
    expect(stopped(hostAt(0.76), [{ ...hostile, residentAboveLimitMsInWindow: 10 * MINUTE }])).toEqual(['hostile']);
  });

  test('a guest that dips under 12 GiB for a minute and touches its memory again is still stopped', () => {
    // Above for minutes 0 to 6 and 7 to 15, under for one minute: 14 minutes above within the window.
    expect(stopped(hostAt(0.76), [{ ...hostile, residentAboveLimitMsInWindow: 14 * MINUTE }])).toEqual(['hostile']);
  });

  test('waits for the sample that finds it above 12 GiB again', () => {
    expect(stopped(hostAt(0.76), [{ ...hostile, residentMiB: 11 * GiB, residentAboveLimitMsInWindow: 14 * MINUTE }])).toEqual([]);
  });

  test('waits until the 10 minutes are up', () => {
    expect(stopped(hostAt(0.76), [{ ...hostile, residentAboveLimitMsInWindow: 9 * MINUTE }])).toEqual([]);
  });

  test('leaves a large machine alone while the host is at 75% or below', () => {
    expect(stopped(hostAt(0.75), [{ ...hostile, residentAboveLimitMsInWindow: 60 * MINUTE }])).toEqual([]);
  });

  test('leaves a machine at 12 GiB or below alone', () => {
    expect(stopped(hostAt(0.8), [machine({ machineId: 'm', residentMiB: 12 * GiB, residentAboveLimitMsInWindow: 60 * MINUTE })])).toEqual([]);
  });

  test('stops a busy machine too: the rule does not depend on the guest being idle', () => {
    expect(stopped(hostAt(0.8), [{ ...hostile, idle: false, residentAboveLimitMsInWindow: 11 * MINUTE }])).toEqual(['hostile']);
  });
});

describe('at 85% host memory, stop the largest idle machines until under the line', () => {
  // 86% of 512 GiB is 450,888 MiB; the 85% line is 445,645 MiB, so 5,243 MiB must go.
  const host: HostSample = { totalMiB: 512 * GiB, usedMiB: 450_888 };

  test('stops idle machines largest first and stops no more than needed', () => {
    const machines = [
      machine({ machineId: 'idle-2500', residentMiB: 2500, idle: true }),
      machine({ machineId: 'busy-8000', residentMiB: 8000, idle: false }),
      machine({ machineId: 'idle-4000', residentMiB: 4000, idle: true }),
      machine({ machineId: 'idle-3000', residentMiB: 3000, idle: true }),
    ];
    // 4,000 leaves the host at 446,888 (still over); 3,000 more brings it to 443,888.
    expect(stopped(host, machines)).toEqual(['idle-4000', 'idle-3000']);
  });

  test('counts memory freed by a 12 GiB stop first', () => {
    const machines = [
      machine({ machineId: 'hog', residentMiB: 14 * GiB, residentAboveLimitMsInWindow: 10 * MINUTE }),
      machine({ machineId: 'idle-4000', residentMiB: 4000, idle: true }),
    ];
    expect(stopped(host, machines)).toEqual(['hog']);
  });

  test("stops a machine above 12 GiB, busy or not, before other tenants' idle machines", () => {
    const machines = [
      machine({ machineId: 'idle-6000', residentMiB: 6000, idle: true }),
      // Above 12 GiB for only 3 minutes, so rule 2 has not stopped it yet.
      machine({ machineId: 'busy-13GiB', residentMiB: 13 * GiB, idle: false, residentAboveLimitMsInWindow: 3 * MINUTE }),
    ];
    expect(stopped(host, machines)).toEqual(['busy-13GiB']);
  });

  test('never stops a busy machine at 12 GiB or below for this rule', () => {
    expect(stopped(host, [machine({ machineId: 'busy', residentMiB: 10 * GiB, idle: false })])).toEqual([]);
  });

  test('does nothing below 85%', () => {
    expect(stopped(hostAt(0.84), [machine({ machineId: 'idle', residentMiB: 10 * GiB, idle: true })])).toEqual([]);
  });
});

describe('balloon', () => {
  const host = hostAt(0.5);

  test('after a 12 GiB build on an idle machine, inflates to the guest free memory less 1 GiB', () => {
    // The guest uses 1.5 GiB; the rest, page cache included, is available.
    const m = machine({ machineId: 'm', idle: true, residentMiB: 12.5 * GiB, balloon: { targetMiB: 0, actualMiB: 0, availableMemory: 14.5 * GiB * 1024 ** 2 } });
    expect(decideReclaim(host, [m])).toEqual([expect.objectContaining({ kind: 'inflate', machineId: 'm', targetMiB: 13.5 * GiB })]);
  });

  test('always leaves the guest at least 2 GiB', () => {
    const m = machine({ machineId: 'm', idle: true, balloon: { targetMiB: 0, actualMiB: 0, availableMemory: 15.8 * GiB * 1024 ** 2 } });
    expect(decideReclaim(host, [m])).toEqual([expect.objectContaining({ kind: 'inflate', targetMiB: 14 * GiB })]);
  });

  test('does not touch the balloon of a guest that reports no statistics', () => {
    expect(decideReclaim(host, [machine({ machineId: 'm', idle: true, residentMiB: 10 * GiB })])).toEqual([]);
  });

  test('waits for the guest to reach the last target before setting another', () => {
    const m = machine({ machineId: 'm', idle: true, balloon: { targetMiB: 8 * GiB, actualMiB: 6 * GiB, availableMemory: 6 * GiB * 1024 ** 2 } });
    expect(decideReclaim(host, [m])).toEqual([]);
  });

  test('does not inflate a busy machine, and gives a busy machine its memory back', () => {
    const fresh = machine({ machineId: 'fresh', idle: false, balloon: { targetMiB: 0, actualMiB: 0, availableMemory: 14 * GiB * 1024 ** 2 } });
    const returning = machine({ machineId: 'returning', idle: false, balloon: { targetMiB: 13 * GiB, actualMiB: 13 * GiB, availableMemory: GiB * 1024 ** 2 } });
    expect(decideReclaim(host, [fresh, returning])).toEqual([expect.objectContaining({ kind: 'deflate', machineId: 'returning', targetMiB: 0 })]);
  });

  test('does not inflate a machine it is stopping', () => {
    const m = machine({ machineId: 'm', idle: true, residentMiB: 14 * GiB, residentAboveLimitMsInWindow: 10 * MINUTE, balloon: { targetMiB: 0, actualMiB: 0, availableMemory: 2 * GiB * 1024 ** 2 } });
    expect(decideReclaim(hostAt(0.8), [m]).map((a) => a.kind)).toEqual(['snapshot_stop']);
  });
});
