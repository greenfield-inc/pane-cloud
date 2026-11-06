import { createPrivateKey, sign } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createFleetClient, type OperationSigner } from 'pane-cloud-contract';
import type { StripeGateway } from '@pane-cloud/billing';
import { createServiceBilling } from './billing';
import type { ServiceConfig } from './config';
import { createDb, migrate } from './db';
import { createGithub } from './github';
import { createRouteServer } from './router';
import { serviceHandlers } from './service';
import { createWorker } from './worker';

const FLEET_TIMEOUT_MS = 5000;

/**
 * Signs operations with a P-256 key held by the service process. In AWS the key moves to KMS
 * (D-6, F6); the fleet checks the same signature either way.
 */
export function localSigner(keyId: string, privateKeyPem: string): OperationSigner {
  const key = createPrivateKey(privateKeyPem);
  return { keyId, sign: async (bytes) => sign('sha256', bytes, key) };
}

export interface ServiceApp {
  url: string;
  kickWorker(): Promise<void>;
  /** Runs billing's enforcement now (it also runs on an interval when billing is on). */
  enforceBilling(): Promise<void>;
  close(): Promise<void>;
}

/** Migrates the database, then starts the HTTP server and the worker. */
export async function startService(
  config: ServiceConfig,
  options: { log?: (line: string) => void; billing?: { stripe?: StripeGateway; now?: () => Date } } = {},
): Promise<ServiceApp> {
  const log = options.log ?? console.log;
  const db = createDb(config.databaseUrl);
  await migrate(db);
  const fleet = createFleetClient({
    baseUrl: config.fleet.url,
    token: config.fleet.token,
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(FLEET_TIMEOUT_MS) }),
  });
  const worker = createWorker({ db, fleet, signer: localSigner(config.signing.keyId, config.signing.privateKeyPem), intervalMs: config.workerIntervalMs, beta: config.beta, log });
  const billing = config.billing && createServiceBilling(db, config.billing, { ...options.billing, kickWorker: () => void worker.kick() });
  const server = createRouteServer(serviceHandlers({ db, github: createGithub(config.github), fleet, worker, beta: config.beta, billing }), log, {
    stripeWebhook: billing ? (body, signature) => billing.handleWebhook(body, signature) : null,
  });
  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  worker.start();
  const enforce = billing && config.billing
    ? setInterval(() => void billing.enforce().catch((error: unknown) => console.error('billing enforce failed:', error)), config.billing.enforceIntervalMs)
    : null;
  // SAFETY: a server listening on a TCP port reports an AddressInfo.
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    kickWorker: () => worker.kick(),
    enforceBilling: async () => billing?.enforce(),
    async close() {
      if (enforce) clearInterval(enforce);
      await worker.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.end();
    },
  };
}
