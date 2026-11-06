/**
 * The end of the beta (D-7). The end date comes from configuration; the phase and the notice dates
 * follow from it and the clock, so nothing about them is stored.
 */
import { BETA_NOTICE_DAYS, BETA_PUSH_WINDOW_DAYS, BETA_PUSH_WINDOW_MINUTES, type BetaStatus, CloudApiError } from 'pane-cloud-contract';

export interface BetaConfig {
  /** ISO timestamp of the end of the beta; null while none is set. */
  endsAt: string | null;
  announcementUrl: string | null;
  ownAwsTemplateUrl: string | null;
}

/** The end date and its links, from BETA_ENDS_AT, BETA_ANNOUNCEMENT_URL and OWN_AWS_TEMPLATE_URL. */
export function betaConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BetaConfig {
  return {
    endsAt: env.BETA_ENDS_AT ? new Date(env.BETA_ENDS_AT).toISOString() : null,
    announcementUrl: env.BETA_ANNOUNCEMENT_URL ?? null,
    ownAwsTemplateUrl: env.OWN_AWS_TEMPLATE_URL ?? null,
  };
}

const DAY_MS = 86_400_000;
export const PUSH_WINDOW_MS = BETA_PUSH_WINDOW_MINUTES * 60_000;

export function betaStatus(config: BetaConfig, now = Date.now()): BetaStatus {
  const ends = config.endsAt === null ? null : Date.parse(config.endsAt);
  const at = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
  const noticeAt = ends === null ? null : ends - BETA_NOTICE_DAYS * DAY_MS;
  const pushFrom = ends === null ? null : ends - BETA_PUSH_WINDOW_DAYS * DAY_MS;
  let phase: BetaStatus['phase'] = 'open';
  if (ends !== null && noticeAt !== null && pushFrom !== null) {
    if (now >= ends) phase = 'ended';
    else if (now >= pushFrom) phase = 'push_windows';
    else if (now >= noticeAt) phase = 'notice';
  }
  return {
    endsAt: at(ends),
    noticeAt: at(noticeAt),
    pushWindowsFrom: at(pushFrom),
    phase,
    pushWindowMinutes: BETA_PUSH_WINDOW_MINUTES,
    announcementUrl: config.announcementUrl,
    ownAwsTemplateUrl: config.ownAwsTemplateUrl,
  };
}

export function assertCanCreate(config: BetaConfig): void {
  const { phase } = betaStatus(config);
  if (phase === 'push_windows' || phase === 'ended') {
    throw new CloudApiError('invalid_state', 'The Pane Cloud beta is ending, so no new machines can be created.', 'Use the own-AWS template from GET /v1/beta to run a machine in your own account.');
  }
}

export function assertCanStart(config: BetaConfig): void {
  if (betaStatus(config).phase === 'ended') {
    throw new CloudApiError('invalid_state', 'The Pane Cloud beta has ended, so machines no longer start.', 'Contact support if you still need work from this machine.');
  }
}
