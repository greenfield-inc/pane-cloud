/**
 * Create, stop and resume a real microVM through the fleet API, on F3's network and F4's cgroup
 * ceilings. Needs root, /dev/kvm, nft and the artifacts F1's `host/fetch-test-artifacts.sh` writes to
 * FLEET_TEST_ARTIFACTS. The test rootfs has no guest agent, so guest calls time out and the host
 * agent carries on without them.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createHostNetwork } from '@pane-cloud/fleet-network';
import { createRuntime } from '@pane-cloud/fleet-runtime';
import { createFleetClient, type FleetMachine, signOperation } from 'pane-cloud-contract';
import { createLocalSigner } from 'pane-cloud-contract/testing';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { type Fleet, type FleetState, startFleet } from './fleet.js';
import { createHostAgent, type HostAgent, type HostState } from './host.js';
import { fleetFairUse, localDiagnosticsStore, localSnapshotStore, localVolumeRecovery, noHostMetrics, releasesFrom } from './local.js';
import { stsHostAuth, stsHostCredential } from './identity.js';
import { memoryStore } from './store.js';
import { type FakeSts, startFakeSts } from './testing/fakes.js';
import { eventually } from './testing/harness.js';

const artifacts = process.env.FLEET_TEST_ARTIFACTS ?? '';
const canRun = artifacts !== '' && existsSync('/dev/kvm') && process.getuid?.() === 0;
const exec = promisify(execFile);

/** The owner of a tap device, or null when there is no such device. */
async function tapOwner(name: string): Promise<number | null> {
  const out = await exec('ip', ['-d', '-j', 'link', 'show', 'dev', name]).catch(() => null);
  if (!out) return null;
  const [link] = JSON.parse(out.stdout) as { linkinfo?: { info_data?: { user?: number } } }[];
  return link?.linkinfo?.info_data?.user ?? -1;
}

describe.skipIf(!canRun)('host agent on KVM', () => {
  let work: string;
  let fleet: Fleet;
  let agent: HostAgent;
  let sts: FakeSts;
  const signer = createLocalSigner('kvm-key');

  beforeAll(async () => {
    work = await mkdtemp('/srv/fleet-agent-test-');
    await copyFile(join(artifacts, 'vmlinux'), join(work, 'vmlinux'));
    const quiet = () => undefined;
    sts = await startFakeSts();
    fleet = await startFleet({
      serviceToken: 'kvm-service',
      hostAuth: stsHostAuth({ endpoint: sts.url, fleetId: 'pane-cloud', hostRoleArn: sts.hostRoleArn }),
      trustedKeys: { 'kvm-key': signer.publicKeyPem },
      releases: releasesFrom([]),
      store: memoryStore<FleetState>(),
      checkIntervalMs: 100,
      log: quiet,
    });
    agent = await createHostAgent({
      hostId: 'kvm-host',
      fleetUrl: fleet.url,
      credential: stsHostCredential({ endpoint: sts.url, region: 'us-east-1', fleetId: 'pane-cloud', credentials: sts.credentialsFor('kvm-host') }).token,
      trustedKeys: { 'kvm-key': signer.publicKeyPem },
      runtime: createRuntime({ firecrackerBin: join(artifacts, 'firecracker'), jailerBin: join(artifacts, 'jailer'), chrootBase: join(work, 'jail'), cgroupParent: 'fleet-test' }),
      releases: releasesFrom([]),
      snapshots: localSnapshotStore(join(work, 'snapshot-store')),
      diagnostics: localDiagnosticsStore(join(work, 'diagnostics')),
      volumes: localVolumeRecovery(join(work, 'recovered')),
      maintenance: { requested: async () => false },
      fairUse: fleetFairUse(join(work, 'cpu-budget')),
      network: createHostNetwork(),
      hostMetrics: noHostMetrics,
      store: memoryStore<HostState>(),
      dataDir: join(work, 'data'),
      kernelPath: join(work, 'vmlinux'),
      templatePath: join(artifacts, 'rootfs.ext4'),
      machineSize: { vcpu: 1, memoryMiB: 512 },
      syncIntervalMs: 50,
      pollIntervalMs: 1_000,
      guestTimeoutMs: 1_000,
      log: (entry) => console.log(JSON.stringify(entry)),
    });
    agent.start();
  });

  afterAll(async () => {
    await agent?.close();
    await fleet?.close();
    await sts?.close();
    if (work) await rm(work, { recursive: true, force: true });
  }, 60_000);

  test('creates a machine, stops it to a snapshot and resumes it without a reboot', async () => {
    const client = createFleetClient({ baseUrl: fleet.url, token: 'kvm-service' });
    const machineId = 'kvm-1';
    const run = async (operation: 'create' | 'stop' | 'resume' | 'delete') => {
      const issuedAt = new Date();
      const envelope = await signOperation(
        { requestId: crypto.randomUUID(), machineId, operation, parameters: {}, reason: `kvm test: ${operation}`, issuedAt: issuedAt.toISOString(), expiresAt: new Date(issuedAt.getTime() + 120_000).toISOString() },
        signer.signer,
      );
      const accepted = await eventually(() => client.submitOperation(envelope).catch((e: unknown) => e), (r) => !(r instanceof Error), 10_000);
      // SAFETY: anything other than an error is the OperationStatus the client parsed.
      const { requestId } = accepted as { requestId: string };
      const finished = await eventually(() => client.getOperation(requestId), (s) => s.finishedAt !== null, 120_000);
      expect(finished.error?.message ?? null).toBeNull();
    };
    const machineIn = (state: FleetMachine['state']) => eventually(() => client.getMachine(machineId), (m) => m.state === state, 30_000);
    const consolePath = join(work, 'data', 'console', `${machineId}.log`);
    const bootCount = async () => ((await readFile(consolePath, 'utf8').catch(() => '')).match(/PANE_BOOT_OK/g) ?? []).length;

    await run('create');
    await machineIn('running');
    await eventually(bootCount, (n) => n === 1, 60_000);
    // The fleet's first slot: tap fctap0, owned by the machine's uid (uidBase 200,000 + slot 0).
    expect(await tapOwner('fctap0')).toBe(200_000);
    // F4 charges the machine's CPU and F3 meters its egress.
    const metrics = await eventually(() => client.getMetrics(machineId), (m) => m.cpuSecondsUsed > 0, 30_000);
    expect(metrics.egressBytesThisMonth).toBeGreaterThanOrEqual(0);

    await run('stop');
    expect((await machineIn('stopped')).stateReason).toBe('user');
    expect(existsSync(join(work, 'snapshot-store', machineId, 'mem'))).toBe(true);
    expect(existsSync(join(work, 'data', 'disks', `${machineId}.ext4`))).toBe(false);
    expect(await tapOwner('fctap0')).toBeNull();

    await run('resume');
    await machineIn('running');
    const ticksBefore = (await readFile(consolePath, 'utf8')).length;
    await eventually(async () => (await readFile(consolePath, 'utf8')).slice(ticksBefore), (text) => /PANE_TICK \d+/.test(text), 30_000);
    expect(await bootCount()).toBe(1);

    expect(await tapOwner('fctap0')).toBe(200_000);

    await run('delete');
    await machineIn('deleted');
    expect(await tapOwner('fctap0')).toBeNull();
    expect(existsSync(join(work, 'snapshot-store', machineId))).toBe(false);
  }, 300_000);
});
