import { randomBytes } from 'node:crypto';
import { CloudApiError, type PaneRelease, signOperation } from 'pane-cloud-contract';
import { createLocalSigner } from 'pane-cloud-contract/testing';
import { afterEach, describe, expect, test } from 'vitest';
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
