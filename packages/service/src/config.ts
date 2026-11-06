import { readFileSync } from 'node:fs';
import { assertTestModeKey } from '@pane-cloud/billing';
import type { BetaConfig } from './beta';

/** B1 billing, on when STRIPE_SECRET_KEY is set. Test mode only: live keys are refused. */
export interface BillingConfig {
  stripeSecretKey: string;
  webhookSecret: string;
  /** Where Stripe Checkout and the customer portal send the owner back to. */
  returnUrl: string;
  /** Billing email is written here as files until SES is set up; with neither, the notice refuses to send. */
  outboxDir: string | null;
  enforceIntervalMs: number;
}

export interface ServiceConfig {
  databaseUrl: string;
  port: number;
  github: {
    /** The GitHub OAuth app's client id; device flow needs no client secret. */
    clientId: string;
    /** Where github.com's device-flow endpoints live (overridable for tests). */
    webUrl: string;
    apiUrl: string;
    /** The repository whose GitHub releases are the published Pane releases. */
    releasesRepo: string;
  };
  fleet: { url: string; token: string };
  signing: { keyId: string; privateKeyPem: string };
  /** How often the worker polls the fleet for operation status and events. */
  workerIntervalMs: number;
  beta: BetaConfig;
  /** Null while billing is off: everyone stays on the free cohort. */
  billing: BillingConfig | null;
}

function positiveMs(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = Number(env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Set ${name} to a positive number of milliseconds, or leave it unset.`);
  return value;
}

export function billingFromEnv(env: NodeJS.ProcessEnv): BillingConfig | null {
  const stripeSecretKey = env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) return null;
  assertTestModeKey(stripeSecretKey);
  return {
    stripeSecretKey,
    webhookSecret: required(env, 'STRIPE_WEBHOOK_SECRET'),
    returnUrl: env.BILLING_RETURN_URL ?? 'https://runpane.com/cloud',
    outboxDir: env.BILLING_OUTBOX_DIR ?? null,
    enforceIntervalMs: positiveMs(env, 'BILLING_ENFORCE_INTERVAL_MS', 300_000),
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Set ${name}: the service cannot start without it.`);
  return value;
}

/** Reads the service's configuration from the environment. Optional keys have working defaults. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const keyFile = env.SIGNING_KEY_FILE;
  const privateKeyPem = keyFile ? readFileSync(keyFile, 'utf8') : required(env, 'SIGNING_KEY_PEM');
  return {
    databaseUrl: required(env, 'DATABASE_URL'),
    port: Number(env.PORT ?? 8080),
    github: {
      clientId: required(env, 'GITHUB_CLIENT_ID'),
      webUrl: env.GITHUB_URL ?? 'https://github.com',
      apiUrl: env.GITHUB_API_URL ?? 'https://api.github.com',
      releasesRepo: env.PANE_RELEASES_REPO ?? 'greenfield-inc/Pane',
    },
    fleet: { url: required(env, 'FLEET_URL'), token: required(env, 'FLEET_TOKEN') },
    signing: { keyId: required(env, 'SIGNING_KEY_ID'), privateKeyPem },
    workerIntervalMs: Number(env.WORKER_INTERVAL_MS ?? 1000),
    beta: {
      endsAt: env.BETA_ENDS_AT ? new Date(env.BETA_ENDS_AT).toISOString() : null,
      announcementUrl: env.BETA_ANNOUNCEMENT_URL ?? null,
      ownAwsTemplateUrl: env.OWN_AWS_TEMPLATE_URL ?? null,
    },
    billing: billingFromEnv(env),
  };
}
