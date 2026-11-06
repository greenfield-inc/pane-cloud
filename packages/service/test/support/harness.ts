import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServiceClient, type ServiceClient } from 'pane-cloud-contract';
import { type FleetStub, startFleetStub } from 'pane-cloud-contract/stubs';
import { Client } from 'pg';
import { inject } from 'vitest';
import { startService, type ServiceApp } from '../../src/app';
import { runCommand } from '../../src/cli';
import { createDb, type Db } from '../../src/db';
import { type FakeGithubUser, startFakeGithub } from './fakeGithub';

export const RELEASES = [
  { version: '2.4.214', debSha256: '1'.repeat(64) },
  { version: '2.4.215', debSha256: '2'.repeat(64) },
];

export interface Harness {
  app: ServiceApp;
  url: string;
  fleet: FleetStub;
  github: Awaited<ReturnType<typeof startFakeGithub>>;
  /** The service's database, for checks only a database search can make (journey 8). */
  db: Db;
  databaseUrl: string;
  cohort(login: string): Promise<void>;
  signIn(user: FakeGithubUser): Promise<string>;
  client(token?: string): ServiceClient;
  /** Restarts the service on the same database with a new beta end date, as an operator would. */
  restart(options: { betaEndsAt: string | null }): Promise<void>;
  close(): Promise<void>;
}

/** A running service on its own fresh database, with P0's fleet stub and a fake GitHub behind it. */
export async function startHarness(options: { fleetUrl?: string; betaEndsAt?: string } = {}): Promise<Harness> {
  const admin = new Client({ connectionString: inject('adminDatabaseUrl') });
  await admin.connect();
  const name = `pane_cloud_test_${randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const databaseUrl = inject('adminDatabaseUrl').replace(/\/[^/]*$/, `/${name}`);

  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const fleet = await startFleetStub({
    trustedKeys: { 'service-test-key': publicKey.export({ type: 'spki', format: 'pem' }).toString() },
    publishedReleases: RELEASES.map((r) => ({ version: r.version, arch: 'arm64' as const, debSha256: r.debSha256 })),
  });
  const github = await startFakeGithub({ releases: RELEASES });
  const signingKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const start = (betaEndsAt: string | null, port: number) =>
    startService(
      {
        databaseUrl,
        port,
        github: { clientId: 'Iv1.test', webUrl: github.url, apiUrl: github.url, releasesRepo: 'greenfield-inc/Pane' },
        fleet: { url: options.fleetUrl ?? fleet.url, token: 'fleet-test-token' },
        signing: { keyId: 'service-test-key', privateKeyPem: signingKeyPem },
        workerIntervalMs: 50,
        beta: { endsAt: betaEndsAt, announcementUrl: null, ownAwsTemplateUrl: null },
      },
      { log: () => undefined },
    );
  let app = await start(options.betaEndsAt ?? null, 0);
  const db = createDb(databaseUrl);
  const client = (token?: string) => createServiceClient({ baseUrl: app.url, token });
  return {
    get app() {
      return app;
    },
    get url() {
      return app.url;
    },
    fleet,
    github,
    db,
    databaseUrl,
    async cohort(login) {
      await runCommand(db, ['cohort', 'add', login]);
    },
    async signIn(user) {
      const anonymous = client();
      const { deviceCode, userCode } = await anonymous.startDeviceSignIn();
      github.approve(userCode, user);
      const result = await anonymous.pollDeviceSignIn(deviceCode);
      if (result.status !== 'complete') throw new Error(`sign-in ended ${result.status}`);
      return result.token;
    },
    client,
    async restart({ betaEndsAt }) {
      const port = Number(new URL(app.url).port);
      await app.close();
      app = await start(betaEndsAt, port);
    },
    async close() {
      await app.close();
      await db.end();
      await fleet.close();
      await github.close();
    },
  };
}
