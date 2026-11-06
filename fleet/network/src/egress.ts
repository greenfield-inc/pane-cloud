/**
 * Egress limits. The numbers come from the host agent's config (D-23 keeps abuse thresholds in
 * private config); the plan's are 100 GiB a month (the contract's MACHINE_LIMITS.monthlyEgressBytes),
 * an alert at 30 GB a seat a month, and a stop at 10 GB out in an hour.
 */
export interface EgressPolicy {
  monthlyCapBytes: number;
  monthlyAlertBytes: number;
  abuseBytes: number;
  abuseWindowMs: number;
}

/** One reading of a machine's egress counter (`HostNetwork.egressBytes`). */
export interface CounterSample {
  /** Milliseconds since the epoch. */
  at: number;
  bytes: number;
}

export type AbuseDecision = { stop: true; reason: 'abuse'; bytesInWindow: number } | { stop: false; bytesInWindow: number };

/**
 * Stops a machine that sent `abuseBytes` or more in the `abuseWindowMs` ending at its latest
 * sample. A counter that went down was reset (a re-attach or host reboot) and counts from zero.
 * When samples straddle the window's start, the bytes between them are spread evenly over time.
 */
export function checkEgressAbuse(samples: readonly CounterSample[], policy: EgressPolicy): AbuseDecision {
  const sorted = [...samples].sort((a, b) => a.at - b.at);
  const end = sorted.at(-1)?.at ?? 0;
  const start = end - policy.abuseWindowMs;
  let bytesInWindow = 0;
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const next = sorted[i];
    if (!prev || !next || next.at <= start) continue;
    const sent = next.bytes >= prev.bytes ? next.bytes - prev.bytes : next.bytes;
    const inside = prev.at >= start ? 1 : (next.at - start) / (next.at - prev.at);
    bytesInWindow += sent * inside;
  }
  bytesInWindow = Math.round(bytesInWindow);
  return bytesInWindow >= policy.abuseBytes ? { stop: true, reason: 'abuse', bytesInWindow } : { stop: false, bytesInWindow };
}

/** Where a machine's egress this month stands against the alert and the monthly cap. */
export function checkMonthlyEgress(bytesThisMonth: number, policy: EgressPolicy): { alert: boolean; capped: boolean } {
  return { alert: bytesThisMonth >= policy.monthlyAlertBytes, capped: bytesThisMonth >= policy.monthlyCapBytes };
}
