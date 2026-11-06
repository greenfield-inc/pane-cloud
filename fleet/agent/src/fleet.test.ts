import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CloudApiError, operationSigningBytes, signOperation } from 'pane-cloud-contract';
import { fleetContractCases } from 'pane-cloud-contract/testing';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { eventually, type Harness, SERVICE_TOKEN, startHarness } from './testing/harness.js';

describe('the fleet API keeps the contract', () => {
  let h: Harness;
  const target = {
    baseUrl: '',
    token: SERVICE_TOKEN,
    signer: { keyId: '', sign: async (bytes: Buffer) => h.signer.signer.sign(bytes) },
    untrustedSigner: { keyId: '', sign: async (bytes: Buffer) => h.untrusted.signer.sign(bytes) },
    release: { version: '', arch: 'arm64' as const, debSha256: '' },
    timeoutMs: 10_000,
  };
  beforeAll(async () => {
    h = await startHarness({ hosts: [{ id: 'host-a' }, { id: 'host-b' }] });
    target.baseUrl = h.fleet.url;
    target.signer.keyId = h.signer.signer.keyId;
    target.untrustedSigner.keyId = h.untrusted.signer.keyId;
    target.release = h.release;
  });
  afterAll(() => h.close());

  for (const c of fleetContractCases(target)) test(c.name, c.run, 30_000);
});

describe('signed-envelope refusals through the HTTP API', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ hosts: [{ id: 'host-a' }] });
  });
  afterAll(() => h.close());

  const post = (body: unknown, token = SERVICE_TOKEN) =>
    fetch(`${h.fleet.url}/v1/operations`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const cases: { name: string; envelope: () => Promise<unknown>; status: number; code: string }[] = [
    { name: 'unsigned', envelope: async () => ({ payload: h.payload('m-unsigned', 'create') }), status: 400, code: 'invalid_request' },
    {
      name: 'an empty signature',
      envelope: async () => ({ payload: h.payload('m-empty', 'create'), signature: { keyId: 'test-key', algorithm: 'ECDSA_SHA_256', value: '' } }),
      status: 401,
      code: 'signature_invalid',
    },
    { name: 'signed by a key the fleet does not trust', envelope: async () => signOperation(h.payload('m-wrong-key', 'create'), h.untrusted.signer), status: 401, code: 'signature_invalid' },
    {
      name: 'expired',
      envelope: async () => signOperation(h.payload('m-expired', 'create', { issuedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-01T00:02:00.000Z' }), h.signer.signer),
      status: 401,
      code: 'operation_expired',
    },
    {
      name: 'carrying an extra parameter',
      envelope: async () => {
        const envelope = await h.sign('m-extra', 'create');
        const payload = { ...envelope.payload, parameters: { script: 'id' } };
        const value = (await h.signer.signer.sign(operationSigningBytes(payload))).toString('base64');
        return { payload, signature: { ...envelope.signature, value } };
      },
      status: 400,
      code: 'invalid_request',
    },
    {
      name: 'naming an operation outside the allow-list',
      envelope: async () => {
        const payload = { ...h.payload('m-unknown', 'create'), operation: 'run_command', parameters: { command: 'id' } };
        const value = (await h.signer.signer.sign(operationSigningBytes(payload))).toString('base64');
        return { payload, signature: { keyId: 'test-key', algorithm: 'ECDSA_SHA_256', value } };
      },
      status: 400,
      code: 'operation_not_allowed',
    },
  ];

  for (const c of cases) {
    test(`refuses an operation ${c.name} and runs nothing`, async () => {
      const envelope = await c.envelope();
      const response = await post(envelope);
      expect(response.status).toBe(c.status);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(c.code);
      // SAFETY: every case builds a payload with a machineId.
      const { machineId } = (envelope as { payload: { machineId: string } }).payload;
      await expect(h.client.getMachine(machineId)).rejects.toMatchObject({ code: 'machine_not_found' });
      expect(h.hosts.get('host-a')?.fake.started).not.toContain(machineId);
    });
  }

  test('refuses a caller without the service token, and a host token on service routes', async () => {
    const envelope = await h.sign('m-token', 'create');
    for (const token of ['wrong', 'test-host-token']) {
      const response = await post(envelope, token);
      expect(response.status).toBe(401);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe('unauthenticated');
    }
  });
});

describe('requestId idempotency', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ hosts: [{ id: 'host-a' }] });
  });
  afterAll(() => h.close());

  test('a finished operation sent again returns its result and runs nothing new', async () => {
    const envelope = await h.sign('m-once', 'create');
    await h.client.submitOperation(envelope);
    const done = await eventually(() => h.client.getOperation(envelope.payload.requestId), (s) => s.status === 'succeeded');
    const again = await h.client.submitOperation(envelope);
    expect(again).toEqual(done);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(h.hosts.get('host-a')?.fake.started.filter((id) => id === 'm-once')).toHaveLength(1);
  });

  test('a requestId reused for a different operation is refused', async () => {
    const first = await h.sign('m-reuse', 'create');
    await h.client.submitOperation(first);
    const other = await signOperation({ ...first.payload, machineId: 'm-reuse-other' }, h.signer.signer);
    await expect(h.client.submitOperation(other)).rejects.toMatchObject({ code: 'invalid_request' });
  });
});

describe('scheduler', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ hosts: [{ id: 'busy', usedMiB: 300 * 1024, maxMachines: 2 }, { id: 'quiet', usedMiB: 100 * 1024, maxMachines: 1 }] });
    await eventually(async () => h.client.submitOperation(await h.sign('warmup', 'create')).catch((e: unknown) => e), (r) => !(r instanceof CloudApiError));
  });
  afterAll(() => h.close());

  test('places each machine on the host with the most memory headroom, and answers no_capacity when every host is full', async () => {
    // 'warmup' went to the quiet host and filled its one slot; the busy host has room for two.
    expect((await h.client.getMachine('warmup')).hostId).toBe('quiet');
    await h.client.submitOperation(await h.sign('second', 'create'));
    await h.client.submitOperation(await h.sign('third', 'create'));
    expect((await h.client.getMachine('second')).hostId).toBe('busy');
    expect((await h.client.getMachine('third')).hostId).toBe('busy');
    await expect(h.client.submitOperation(await h.sign('fourth', 'create'))).rejects.toMatchObject({ code: 'no_capacity' });
  });
});

describe('host loss', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ hosts: [{ id: 'doomed', usedMiB: 0 }, { id: 'spare', usedMiB: 200 * 1024 }], hostLostAfterMs: 1_000 });
  });
  afterAll(() => h.close());

  test('brings each running machine back on another host from its own disk, and says so in events', async () => {
    const machineId = 'm-survivor';
    await eventually(async () => h.client.submitOperation(await h.sign(machineId, 'create')).catch((e: unknown) => e), (r) => !(r instanceof CloudApiError));
    await eventually(() => h.client.getMachine(machineId), (m) => m.state === 'running');
    expect((await h.client.getMachine(machineId)).hostId).toBe('doomed');
    // The user commits a file; the guest writes it to the machine's disk.
    const doomed = h.hosts.get('doomed');
    if (!doomed) throw new Error('no host');
    await appendFile(join(doomed.dataDir, 'disks', `${machineId}.ext4`), 'committed work\n');

    await doomed.agent.close();
    await doomed.fake.crash();

    const back = await eventually(() => h.client.getMachine(machineId), (m) => m.state === 'running' && m.hostId === 'spare');
    expect(back.stateReason).toBeNull();
    expect(await readFile(join(h.tmp, 'spare', 'disks', `${machineId}.ext4`), 'utf8')).toBe('template\ncommitted work\n');
    const { events } = await h.client.listEvents(undefined, 500);
    const mine = events.filter((e) => e.machineId === machineId && e.kind === 'state_changed').map((e) => [e.state, e.reason]);
    expect(mine).toContainEqual(['error', 'host_lost']);
    expect(mine.slice(mine.findIndex(([state]) => state === 'error'))).toContainEqual(['running', null]);
  });
});
