import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CloudApiError, MACHINE_LIMITS, type PaneRelease, signOperation } from 'pane-cloud-contract';
import { createLocalSigner } from 'pane-cloud-contract/testing';
import { afterEach, describe, expect, test } from 'vitest';
import { CAPPED_TX, DEFAULT_EGRESS_POLICY } from './host.js';
import { eventually, type Harness, startHarness, type TestHost } from './testing/harness.js';

let h: Harness;
afterEach(() => h.close());

function hostOf(id: string): TestHost {
  const host = h.hosts.get(id);
  if (!host) throw new Error(`no host ${id}`);
  return host;
}

async function run(machineId: string, operation: Parameters<Harness['sign']>[1], extra?: Parameters<Harness['sign']>[2]) {
  const accepted = await eventually(async () => h.client.submitOperation(await h.sign(machineId, operation, extra)).catch((e: unknown) => e), (r) => !(r instanceof CloudApiError && r.code === 'no_capacity'));
  if (accepted instanceof Error) throw accepted;
  // SAFETY: anything other than an error is the OperationStatus the client parsed.
  const { requestId } = accepted as { requestId: string };
  return eventually(() => h.client.getOperation(requestId), (s) => s.finishedAt !== null);
}

const minutes = (n: number) => n * 60 * 1000;

describe('idle stop', () => {
  test('stops a machine after 30 minutes with no agent running and no client connected, and only then', async () => {
    h = await startHarness({ hosts: [{ id: 'host-a' }] });
    const host = hostOf('host-a');
    await run('idle-one', 'create');
    await run('busy-one', 'create');
    const busy = host.fake.guests.get('busy-one');
    if (!busy) throw new Error('no guest');
    busy.activity.agentsRunning = 1;
    // Let the agent see both guests once at the starting time.
    await eventually(async () => host.fake.guests.get('idle-one')?.received.filter((op) => op === 'status').length ?? 0, (n) => n >= 2);

    host.clock.offsetMs = minutes(29);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await h.client.getMachine('idle-one')).state).toBe('running');

    host.clock.offsetMs = minutes(31);
    const stopped = await eventually(() => h.client.getMachine('idle-one'), (m) => m.state === 'stopped');
    expect(stopped.stateReason).toBe('idle');
    expect((await h.client.getMachine('busy-one')).state).toBe('running');
    const { events } = await h.client.listEvents(undefined, 500);
    expect(events).toContainEqual(expect.objectContaining({ machineId: 'idle-one', kind: 'state_changed', state: 'stopped', reason: 'idle' }));
  });
});

describe('the host agent checks every operation itself', () => {
  test('refuses update_pane for a release its own published list does not hold, and the guest never sees it', async () => {
    const unlisted: PaneRelease = { version: '1.5.0', arch: 'arm64', debSha256: randomBytes(32).toString('hex') };
    h = await startHarness({ hosts: [{ id: 'host-a', releases: [unlisted] }] });
    await run('m-update', 'create');
    const finished = await run('m-update', 'update_pane');
    expect(finished.status).toBe('failed');
    expect(finished.error?.code).toBe('release_not_published');
    expect(hostOf('host-a').fake.guests.get('m-update')?.received).not.toContain('update_pane');
    expect((await h.client.getMachine('m-update')).paneVersion).toBeNull();
  });

  test('refuses an operation signed by a key the fleet trusts but the host does not, and starts nothing', async () => {
    const hostOnlyKey = createLocalSigner('test-key');
    h = await startHarness({ hosts: [{ id: 'host-a', trustedKeys: { 'test-key': hostOnlyKey.publicKeyPem } }] });
    const finished = await run('m-forged', 'create');
    expect(finished.status).toBe('failed');
    expect(finished.error?.code).toBe('signature_invalid');
    expect(hostOf('host-a').fake.started).toEqual([]);
    await eventually(() => h.client.getMachine('m-forged').catch((e: unknown) => e), (r) => r instanceof CloudApiError && r.code === 'machine_not_found');
  });

  test('refuses an envelope that expired before the host received it', async () => {
    h = await startHarness({ hosts: [{ id: 'host-a' }] });
    await run('m-late', 'create');
    const host = hostOf('host-a');
    host.clock.offsetMs = minutes(10);
    const envelope = await signOperation(h.payload('m-late', 'collect_diagnostics'), h.signer.signer);
    await h.client.submitOperation(envelope);
    const finished = await eventually(() => h.client.getOperation(envelope.payload.requestId), (s) => s.finishedAt !== null);
    expect(finished.error?.code).toBe('operation_expired');
    expect(host.fake.guests.get('m-late')?.received).not.toContain('collect_diagnostics');
  });
});

describe('host agent restart', () => {
  test('reattaches to machines that kept running and can still stop them', async () => {
    h = await startHarness({ hosts: [{ id: 'host-a' }] });
    await run('m-steady', 'create');
    const host = hostOf('host-a');
    await host.restart();
    expect(host.fake.started).toEqual(['m-steady']);
    expect((await run('m-steady', 'stop')).status).toBe('succeeded');
    expect((await h.client.getMachine('m-steady')).state).toBe('stopped');
  });
});

describe('host maintenance', () => {
  test('stops every machine with reason host_maintenance and takes no new machines', async () => {
    h = await startHarness({ hosts: [{ id: 'host-a' }] });
    await run('m-maint', 'create');
    hostOf('host-a').maintenance.requested = true;
    const stopped = await eventually(() => h.client.getMachine('m-maint'), (m) => m.state === 'stopped');
    expect(stopped.stateReason).toBe('host_maintenance');
    await eventually(async () => h.client.submitOperation(await h.sign('m-new', 'create')).catch((e: unknown) => e), (r) => r instanceof CloudApiError && r.code === 'no_capacity');
  });
});

describe('stop with a broken guest agent', () => {
  test('snapshots and stops a machine whose guest agent never answers', async () => {
    h = await startHarness({ hosts: [{ id: 'host-a' }] });
    await run('m-silent', 'create');
    const guest = hostOf('host-a').fake.guests.get('m-silent');
    if (!guest) throw new Error('no guest');
    guest.silent = true;
    const finished = await run('m-silent', 'stop');
    expect(finished.status).toBe('succeeded');
    expect(guest.received).toContain('prepare_to_stop');
    expect((await h.client.getMachine('m-silent')).state).toBe('stopped');
    expect((await run('m-silent', 'resume')).status).toBe('succeeded');
  });
});

/** Waits until the host agent has polled the machine's guest `n` more times. */
async function polls(host: TestHost, machineId: string, n = 2) {
  const count = () => host.fake.guests.get(machineId)?.received.filter((op) => op === 'status').length ?? 0;
  const target = count() + n;
  await eventually(async () => count(), (c) => c >= target);
}

/** Fills a host to its memory target, so the fleet places nothing more on it. */
async function fill(host: TestHost, full: boolean) {
  host.memory.usedMiB = full ? host.memory.totalMiB * 0.75 : 0;
  // Hosts sync every 10 ms; let the fleet see the new report.
  await new Promise((resolve) => setTimeout(resolve, 100));
}

describe('network', () => {
  test('a machine keeps its address and its month of egress when it resumes on another host', async () => {
    const noAbuse = { ...DEFAULT_EGRESS_POLICY, abuseBytes: Number.POSITIVE_INFINITY };
    h = await startHarness({ hosts: [{ id: 'host-a', egressPolicy: noAbuse }, { id: 'host-b', egressPolicy: noAbuse }] });
    const [a, b] = [hostOf('host-a'), hostOf('host-b')];
    await fill(b, true);
    await run('m-moves', 'create');
    await fill(a, true);
    await fill(b, false);
    await run('m-other', 'create');
    expect((await h.client.getMachine('m-other')).hostId).toBe('host-b');

    // Past 100 GiB this month: capped to about 1 MiB/s.
    a.net.counters.set('m-moves', MACHINE_LIMITS.monthlyEgressBytes + 1);
    await eventually(() => h.client.getMetrics('m-moves'), (m) => m.egressBytesThisMonth > MACHINE_LIMITS.monthlyEgressBytes);
    expect(a.fake.txLimits.get('m-moves')).toEqual([CAPPED_TX]);

    await run('m-moves', 'stop');
    expect((await run('m-moves', 'resume')).status).toBe('succeeded');
    expect((await h.client.getMachine('m-moves')).hostId).toBe('host-b');

    const addressOn = (host: TestHost, machineId: string) => host.net.attached.filter((x) => x.machineId === machineId).map((x) => x.address);
    const [before] = addressOn(a, 'm-moves');
    const [after] = addressOn(b, 'm-moves');
    expect(after).toEqual(before);
    expect(addressOn(b, 'm-other')[0]?.guestIp).not.toBe(before?.guestIp);
    // The restored machine is capped again on its new host.
    expect(b.fake.txLimits.get('m-moves')).toEqual([CAPPED_TX]);
  });

  test('stops a machine that sends 10 GB within an hour, with reason abuse', async () => {
    h = await startHarness({ hosts: [{ id: 'host-a' }] });
    const host = hostOf('host-a');
    await run('m-flood', 'create');
    await polls(host, 'm-flood');
    host.net.counters.set('m-flood', 11e9);
    const stopped = await eventually(() => h.client.getMachine('m-flood'), (m) => m.state === 'stopped');
    expect(stopped.stateReason).toBe('abuse');
    const { events } = await h.client.listEvents(undefined, 500);
    expect(events).toContainEqual(expect.objectContaining({ machineId: 'm-flood', kind: 'state_changed', state: 'stopped', reason: 'abuse' }));
  });
});

describe('fair use', () => {
  test('throttles a machine that used its daily CPU budget, and it resumes throttled', async () => {
    h = await startHarness({ hosts: [{ id: 'host-a' }] });
    const host = hostOf('host-a');
    await run('m-burner', 'create');
    const vm = host.fake.vms.get('m-burner');
    if (!vm) throw new Error('no vm');
    // F4 counts a machine's day from its first check.
    await polls(host, 'm-burner');
    await writeFile(join(vm.cgroupPath, 'cpu.stat'), `usage_usec ${(MACHINE_LIMITS.dailyCpuSeconds + 60) * 1e6}\n`);

    const metrics = await eventually(() => h.client.getMetrics('m-burner'), (m) => m.throttled);
    expect(metrics.cpuSecondsUsed).toBeGreaterThanOrEqual(MACHINE_LIMITS.dailyCpuSeconds);
    // Each poll writes F4's ceilings and then the budget's cpu.max, so read between polls.
    await eventually(async () => (await readFile(join(vm.cgroupPath, 'cpu.max'), 'utf8')).trim(), (cpuMax) => cpuMax === '50000 100000');
    const { events } = await h.client.listEvents(undefined, 500);
    expect(events).toContainEqual(expect.objectContaining({ machineId: 'm-burner', kind: 'budget_exhausted' }));

    await run('m-burner', 'stop');
    await run('m-burner', 'resume');
    expect(host.fake.specs.at(-1)?.cgroup?.['cpu.max']).toBe('50000 100000');
  });

  test('stops idle machines with reason memory_pressure when host memory reaches 85%, and leaves busy ones', async () => {
    h = await startHarness({ hosts: [{ id: 'host-a' }] });
    const host = hostOf('host-a');
    await run('m-idle', 'create');
    await run('m-busy', 'create');
    const busy = host.fake.guests.get('m-busy');
    if (!busy) throw new Error('no guest');
    busy.activity.agentsRunning = 1;
    await polls(host, 'm-busy');

    host.memory.usedMiB = host.memory.totalMiB * 0.9;
    const stopped = await eventually(() => h.client.getMachine('m-idle'), (m) => m.state === 'stopped');
    expect(stopped.stateReason).toBe('memory_pressure');
    expect((await h.client.getMachine('m-busy')).state).toBe('running');
    const { events } = await h.client.listEvents(undefined, 500);
    expect(events).toContainEqual(expect.objectContaining({ machineId: 'm-idle', kind: 'state_changed', state: 'stopped', reason: 'memory_pressure' }));
  });
});

describe('collect_diagnostics', () => {
  test('stores the guest archive, and refuses one that does not match its SHA-256', async () => {
    h = await startHarness({ hosts: [{ id: 'host-a' }] });
    await run('m-diag', 'create');
    const good = await run('m-diag', 'collect_diagnostics');
    expect(good.status).toBe('succeeded');
    const archiveKey = good.result?.archiveKey ?? '';
    expect(await readFile(join(h.tmp, 'diagnostics', archiveKey), 'utf8')).toBe('fake archive');

    const guest = hostOf('host-a').fake.guests.get('m-diag');
    if (!guest) throw new Error('no guest');
    guest.corruptDiagnostics = true;
    const bad = await run('m-diag', 'collect_diagnostics');
    expect(bad.status).toBe('failed');
    expect(bad.error?.message).toMatch(/SHA-256/);
  });
});
