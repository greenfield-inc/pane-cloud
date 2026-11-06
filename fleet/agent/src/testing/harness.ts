/** A fleet API and host agents in one process, on fake runtimes, for tests. */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createFleetClient, type FleetClient, type OperationEnvelope, type OperationPayload, type PaneRelease, signOperation } from 'pane-cloud-contract';
import { createLocalSigner } from 'pane-cloud-contract/testing';

type LocalSigner = ReturnType<typeof createLocalSigner>;
import { type Fleet, type FleetState, startFleet } from '../fleet.js';
import { createHostAgent, type HostAgent, type HostAgentOptions, type HostState } from '../host.js';
import { basicFairUse, localDiagnosticsStore, localSnapshotStore, localVolumeRecovery, releasesFrom } from '../local.js';
import { memoryStore, type StateStore } from '../store.js';
import { createFakeRuntime, type FakeRuntime } from './fakes.js';

export const SERVICE_TOKEN = 'test-service-token';
export const HOST_TOKEN = 'test-host-token';

/** A clock that runs with real time, plus whatever a test adds. */
export function testClock() {
  const clock = { offsetMs: 0, now: () => new Date(Date.now() + clock.offsetMs) };
  return clock;
}

export interface TestHost {
  id: string;
  agent: HostAgent;
  fake: FakeRuntime;
  clock: ReturnType<typeof testClock>;
  dataDir: string;
  store: StateStore<HostState>;
  /** Memory in use on the host, as its agent reports it. */
  memory: { totalMiB: number; usedMiB: number };
  maintenance: { requested: boolean };
  /** Stops this agent and starts a new one on the same state and VMs, as a restart would. */
  restart(): Promise<void>;
}

export interface HarnessOptions {
  hosts: { id: string; usedMiB?: number; maxMachines?: number; releases?: PaneRelease[]; trustedKeys?: Record<string, string> }[];
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
  const fleet = await startFleet({
    serviceToken: SERVICE_TOKEN,
    hostToken: HOST_TOKEN,
    trustedKeys,
    releases: releasesFrom([release]),
    store: memoryStore<FleetState>(),
    now: fleetClock.now,
    hostLostAfterMs: options.hostLostAfterMs ?? 120_000,
    checkIntervalMs: 20,
    log: quiet,
  });

  const hosts = new Map<string, TestHost>();
  for (const spec of options.hosts) {
    const dataDir = join(tmp, spec.id);
    const fake = createFakeRuntime(join(tmp, `${spec.id}-vm`));
    const memory = { totalMiB: 512 * 1024, usedMiB: spec.usedMiB ?? 0 };
    const maintenance = { requested: false };
    const store = memoryStore<HostState>();
    const clock = testClock();
    const agentOptions: HostAgentOptions = {
      hostId: spec.id,
      fleetUrl: fleet.url,
      token: HOST_TOKEN,
      trustedKeys: spec.trustedKeys ?? trustedKeys,
      runtime: fake.runtime,
      releases: releasesFrom(spec.releases ?? [release]),
      snapshots: localSnapshotStore(join(tmp, 'snapshots')),
      diagnostics: localDiagnosticsStore(join(tmp, 'diagnostics')),
      volumes: localVolumeRecovery(tmp),
      maintenance: { requested: async () => maintenance.requested },
      fairUse: basicFairUse(),
      store,
      dataDir,
      kernelPath: join(tmp, 'vmlinux'),
      templatePath: join(tmp, 'template.ext4'),
      createDisk: async (_template, diskPath) => {
        await mkdir(dirname(diskPath), { recursive: true });
        await writeFile(diskPath, 'template\n');
      },
      maxMachines: spec.maxMachines ?? 109,
      hostMemory: () => memory,
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
      clock,
      dataDir,
      store,
      memory,
      maintenance,
      async restart() {
        await host.agent.close();
        host.agent = await createHostAgent(agentOptions);
        host.agent.start();
      },
    };
    host.agent.start();
    hosts.set(spec.id, host);
  }

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
