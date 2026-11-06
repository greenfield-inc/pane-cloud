/** A fleet API and host agents in one process, on fake runtimes, for tests. */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createFleetClient, type FleetClient, type OperationEnvelope, type OperationPayload, type PaneRelease, signOperation } from 'pane-cloud-contract';
import { createLocalSigner } from 'pane-cloud-contract/testing';

type LocalSigner = ReturnType<typeof createLocalSigner>;
import { type Fleet, type FleetState, startFleet } from '../fleet.js';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHostAgent, type HostAgent, type HostAgentOptions, type HostState } from '../host.js';
import { stsHostAuth, stsHostCredential } from '../identity.js';
import type { Work } from '../sync.js';
import type { EgressPolicy } from '@pane-cloud/fleet-network';
import { fleetFairUse, localDiagnosticsStore, localSnapshotStore, localVolumeRecovery, noHostMetrics, releasesFrom } from '../local.js';
import { memoryStore, type StateStore } from '../store.js';
import { createFakeNetwork, createFakeRuntime, type FakeNetwork, type FakeRuntime, startFakeSts } from './fakes.js';

export const SERVICE_TOKEN = 'test-service-token';

/** A clock that runs with real time, plus whatever a test adds. */
export function testClock() {
  const clock = { offsetMs: 0, now: () => new Date(Date.now() + clock.offsetMs) };
  return clock;
}

export interface TestHost {
  id: string;
  agent: HostAgent;
  fake: FakeRuntime;
  net: FakeNetwork;
  clock: ReturnType<typeof testClock>;
  dataDir: string;
  store: StateStore<HostState>;
  /** Memory in use on the host, as its agent reports it. */
  memory: { totalMiB: number; usedMiB: number };
  maintenance: { requested: boolean };
  /** This host's bearer token for the sync route. */
  token(): Promise<string>;
  /** Adds work to this host's next sync answer, as a compromised controller could; resolves once it is sent. */
  inject(work: Work): Promise<void>;
  /** Stops this agent and starts a new one on the same state and VMs, as a restart would. */
  restart(): Promise<void>;
}

export interface HarnessOptions {
  hosts: { id: string; usedMiB?: number; maxMachines?: number; releases?: PaneRelease[]; trustedKeys?: Record<string, string>; egressPolicy?: EgressPolicy }[];
  hostLostAfterMs?: number;
}

export interface Harness {
  fleet: Fleet;
  client: FleetClient;
  signer: LocalSigner;
  untrusted: LocalSigner;
  release: PaneRelease;
  fleetClock: ReturnType<typeof testClock>;
  hosts: Map<string, TestHost>;
  tmp: string;
  payload(machineId: string, operation: OperationPayload['operation'], extra?: Partial<OperationPayload>): OperationPayload;
  sign(machineId: string, operation: OperationPayload['operation'], extra?: Partial<OperationPayload>): Promise<OperationEnvelope>;
  close(): Promise<void>;
}

const quiet = process.env.FLEET_TEST_LOG ? (entry: Record<string, unknown>) => console.log(JSON.stringify(entry)) : () => undefined;

export async function startHarness(options: HarnessOptions): Promise<Harness> {
  const tmp = await mkdtemp(join(tmpdir(), 'fa-'));
  const signer = createLocalSigner('test-key');
  const untrusted = createLocalSigner('test-key');
  const trustedKeys = { 'test-key': signer.publicKeyPem };
  const release: PaneRelease = { version: '1.4.0', arch: 'arm64', debSha256: randomBytes(32).toString('hex') };
  const fleetClock = testClock();
  const sts = await startFakeSts();
  const fleet = await startFleet({
    serviceToken: SERVICE_TOKEN,
    hostAuth: stsHostAuth({ endpoint: sts.url, fleetId: 'pane-cloud', hostRoleArn: sts.hostRoleArn }),
    trustedKeys,
    releases: releasesFrom([release]),
    store: memoryStore<FleetState>(),
    now: fleetClock.now,
    hostLostAfterMs: options.hostLostAfterMs ?? 120_000,
    checkIntervalMs: 20,
    log: quiet,
  });

  const hosts = new Map<string, TestHost>();
  const proxies: Awaited<ReturnType<typeof startSyncProxy>>[] = [];
  for (const spec of options.hosts) {
    const dataDir = join(tmp, spec.id);
    const fake = createFakeRuntime(join(tmp, `${spec.id}-vm`));
    const net = createFakeNetwork();
    const memory = { totalMiB: 512 * 1024, usedMiB: spec.usedMiB ?? 0 };
    const maintenance = { requested: false };
    const store = memoryStore<HostState>();
    const clock = testClock();
    const credential = stsHostCredential({ endpoint: sts.url, region: 'us-east-1', fleetId: 'pane-cloud', credentials: sts.credentialsFor(spec.id) });
    const injected: Injected[] = [];
    const proxy = await startSyncProxy(fleet.url, injected);
    proxies.push(proxy);
    const agentOptions: HostAgentOptions = {
      hostId: spec.id,
      fleetUrl: proxy.url,
      credential: credential.token,
      trustedKeys: spec.trustedKeys ?? trustedKeys,
      runtime: fake.runtime,
      releases: releasesFrom(spec.releases ?? [release]),
      snapshots: localSnapshotStore(join(tmp, 'snapshots')),
      diagnostics: localDiagnosticsStore(join(tmp, 'diagnostics')),
      volumes: localVolumeRecovery(tmp),
      maintenance: { requested: async () => maintenance.requested },
      fairUse: fleetFairUse(join(dataDir, 'cpu-budget'), clock.now),
      network: net.network,
      hostMetrics: noHostMetrics,
      ...(spec.egressPolicy ? { egressPolicy: spec.egressPolicy } : {}),
      store,
      dataDir,
      kernelPath: join(tmp, 'vmlinux'),
      templatePath: join(tmp, 'template.ext4'),
      createDisk: async (_template, diskPath) => {
        await mkdir(dirname(diskPath), { recursive: true });
        await writeFile(diskPath, 'template\n');
      },
      maxMachines: spec.maxMachines ?? 109,
      hostMemory: async () => memory,
      now: clock.now,
      syncIntervalMs: 10,
      pollIntervalMs: 20,
      guestTimeoutMs: 2_000,
      log: quiet,
    };
    const host: TestHost = {
      id: spec.id,
      agent: await createHostAgent(agentOptions),
      fake,
      net,
      clock,
      dataDir,
      store,
      memory,
      maintenance,
      token: credential.token,
      inject: (work) => new Promise((sent) => injected.push({ work, sent })),
      async restart() {
        await host.agent.close();
        host.agent = await createHostAgent(agentOptions);
        host.agent.start();
      },
    };
    host.agent.start();
    hosts.set(spec.id, host);
  }

  // Every host has reported once, so the fleet can place on any of them.
  await Promise.all(proxies.map((proxy) => proxy.synced));

  const payload = (machineId: string, operation: OperationPayload['operation'], extra: Partial<OperationPayload> = {}): OperationPayload => {
    const issuedAt = new Date();
    // SAFETY: parameters fit `operation`; signOperation parses the payload again.
    return {
      requestId: randomUUID(),
      machineId,
      reason: `test: ${operation}`,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + 120_000).toISOString(),
      operation,
      parameters: operation === 'bootstrap' || operation === 'update_pane' ? { release } : {},
      ...extra,
    } as OperationPayload;
  };

  return {
    fleet,
    client: createFleetClient({ baseUrl: fleet.url, token: SERVICE_TOKEN }),
    signer,
    untrusted,
    release,
    fleetClock,
    hosts,
    tmp,
    payload,
    sign: (machineId, operation, extra) => signOperation(payload(machineId, operation, extra), signer.signer),
    async close() {
      for (const host of hosts.values()) await host.agent.close();
      for (const host of hosts.values()) await host.fake.crash();
      await fleet.close();
      for (const proxy of proxies) await proxy.close();
      await sts.close();
      // Machine work that close() leaves running may still be writing here.
      await rm(tmp, { recursive: true, force: true, maxRetries: 10 });
    },
  };
}

/** Polls until `done` holds or the time runs out. */
export async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out; last value: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Passes a host's calls to the fleet, adding `injected` work to the next sync answer. */
interface Injected {
  work: Work;
  sent: () => void;
}

async function startSyncProxy(fleetUrl: string, injected: Injected[]): Promise<{ url: string; synced: Promise<void>; close(): Promise<void> }> {
  let firstSync = () => undefined as void;
  const synced = new Promise<void>((resolve) => (firstSync = resolve));
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const upstream = await fetch(new URL(request.url ?? '/', fleetUrl), {
        method: request.method ?? 'GET',
        headers: { authorization: request.headers.authorization ?? '', 'content-type': 'application/json' },
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      });
      let body = await upstream.text();
      const sending = upstream.ok ? injected.splice(0) : [];
      if (sending.length > 0) {
        const answer = JSON.parse(body) as { work: Work[] };
        answer.work.push(...sending.map((i) => i.work));
        body = JSON.stringify(answer);
      }
      response.writeHead(upstream.status, { 'content-type': 'application/json' });
      response.end(body, () => sending.forEach((i) => i.sent()));
      if (upstream.ok) firstSync();
    })().catch(() => response.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  // SAFETY: a server listening on a TCP port reports an AddressInfo.
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    synced,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
