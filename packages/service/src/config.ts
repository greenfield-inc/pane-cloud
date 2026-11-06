import { readFileSync } from 'node:fs';

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
  };
}
