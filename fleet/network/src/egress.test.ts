import { describe, expect, test } from 'vitest';
import { checkEgressAbuse, checkMonthlyEgress, type CounterSample, type EgressPolicy } from './index.js';

const GB = 1_000_000_000;
const GiB = 1024 ** 3;
const MINUTE = 60_000;
// The plan's numbers: 100 GiB a month (MACHINE_LIMITS.monthlyEgressBytes), an alert at 30 GB a seat
// a month, and "a guest pushing 10 GB out in an hour is stopped and flagged" (journey 9).
const policy: EgressPolicy = { monthlyCapBytes: 100 * GiB, monthlyAlertBytes: 30 * GB, abuseBytes: 10 * GB, abuseWindowMs: 60 * MINUTE };

/** A counter read every minute while the machine sends `perMinute` bytes. */
function steady(perMinute: number, minutes: number, from = 0): CounterSample[] {
  return Array.from({ length: minutes + 1 }, (_, i) => ({ at: i * MINUTE, bytes: from + i * perMinute }));
}

describe('egress abuse', () => {
  test('10 GB out within an hour stops the machine as abuse', () => {
    // 200 MB a minute for 50 minutes is 10 GB.
    expect(checkEgressAbuse(steady(200_000_000, 50), policy)).toEqual({ stop: true, reason: 'abuse', bytesInWindow: 10 * GB });
  });

  test('9 GB in an hour keeps running', () => {
    expect(checkEgressAbuse(steady(150_000_000, 60), policy)).toEqual({ stop: false, bytesInWindow: 9 * GB });
  });

  test('a steady 9 GB an hour for a day never trips the hourly rule', () => {
    expect(checkEgressAbuse(steady(150_000_000, 24 * 60), policy).stop).toBe(false);
  });

  test('only the last hour counts', () => {
    // 8 GB in the first hour, nothing for 30 minutes, then 4 GB over 30 minutes: 4 GB in the last hour.
    const samples = [
      { at: 0, bytes: 0 },
      { at: 60 * MINUTE, bytes: 8 * GB },
      { at: 90 * MINUTE, bytes: 8 * GB },
      { at: 120 * MINUTE, bytes: 12 * GB },
    ];
    expect(checkEgressAbuse(samples, policy)).toEqual({ stop: false, bytesInWindow: 4 * GB });
  });

  test('a reading that spans the window start counts only its share inside the window', () => {
    // 12 GB between minute 0 and minute 120: 6 GB of it falls in the last hour.
    expect(checkEgressAbuse([{ at: 0, bytes: 0 }, { at: 120 * MINUTE, bytes: 12 * GB }], policy)).toEqual({ stop: false, bytesInWindow: 6 * GB });
  });

  test('a counter reset counts from zero instead of going negative', () => {
    // 6 GB, then the machine was re-attached (counter back to 0) and sent 5 GB more.
    const samples = [
      { at: 0, bytes: 0 },
      { at: 20 * MINUTE, bytes: 6 * GB },
      { at: 40 * MINUTE, bytes: 5 * GB },
    ];
    expect(checkEgressAbuse(samples, policy)).toEqual({ stop: true, reason: 'abuse', bytesInWindow: 11 * GB });
  });

  test('one sample or none is not abuse', () => {
    expect(checkEgressAbuse([], policy).stop).toBe(false);
    expect(checkEgressAbuse([{ at: 0, bytes: 50 * GB }], policy).stop).toBe(false);
  });
});

describe('monthly egress', () => {
  test('alerts at 30 GB and caps at 100 GiB', () => {
    expect(checkMonthlyEgress(29 * GB, policy)).toEqual({ alert: false, capped: false });
    expect(checkMonthlyEgress(30 * GB, policy)).toEqual({ alert: true, capped: false });
    expect(checkMonthlyEgress(100 * GB, policy)).toEqual({ alert: true, capped: false });
    expect(checkMonthlyEgress(107_374_182_400, policy)).toEqual({ alert: true, capped: true });
  });
});
