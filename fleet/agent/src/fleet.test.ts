import { appendFile, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { CloudApiError, operationSigningBytes, signOperation } from 'pane-cloud-contract';
import { fleetContractCases } from 'pane-cloud-contract/testing';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { HostReport } from './sync.js';
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
    const hostToken = await h.hosts.get('host-a')?.token();
    for (const token of ['wrong', hostToken ?? '']) {
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

describe('host identity on sync', () => {
  let h: Harness;
  beforeAll(async () => {
    // host-a holds one machine, so the second goes to host-b.
    h = await startHarness({ hosts: [{ id: 'host-a', maxMachines: 1 }, { id: 'host-b', usedMiB: 100 * 1024 }] });
  });
  afterAll(() => h.close());

  const syncAs = async (hostId: string, path: string, report: Partial<HostReport> = {}) => {
    const body: HostReport = { hostId, draining: false, maxMachines: 1, activeMachines: 1, memoryTargetMiB: 0, memoryUsedMiB: 0, machines: [], operations: [], events: [], ...report };
    const token = await h.hosts.get(hostId)?.token();
    return fetch(`${h.fleet.url}/v1/hosts/${path}/sync`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  };

  test('a host cannot sync as another host, speak for its machines, or change what an operation was', async () => {
    const run = async (machineId: string, operation: 'create' | 'prepare_to_stop') => {
      const envelope = await h.sign(machineId, operation);
      await h.client.submitOperation(envelope);
      return envelope.payload.requestId;
    };
    await run('m-on-a', 'create');
    await eventually(() => h.client.getMachine('m-on-a'), (m) => m.state === 'running' && m.hostId === 'host-a');
    await run('m-on-b', 'create');
    await eventually(() => h.client.getMachine('m-on-b'), (m) => m.state === 'running' && m.hostId === 'host-b');

    // host-a's credential, on host-b's path or with host-b's name in the report.
    for (const response of [await syncAs('host-a', 'host-b', { hostId: 'host-b' }), await syncAs('host-a', 'host-b'), await syncAs('host-a', 'host-a', { hostId: 'host-b' })]) {
      expect(response.status).toBe(401);
      expect(((await response.json()) as { work?: unknown }).work).toBeUndefined();
    }

    // An operation on host-a that stays running while its guest agent stays silent.
    const guest = h.hosts.get('host-a')?.fake.guests.get('m-on-a');
    if (!guest) throw new Error('no guest');
    guest.silent = true;
    const requestId = await run('m-on-a', 'prepare_to_stop');
    await eventually(() => h.client.getOperation(requestId), (s) => s.status === 'running');
    const forgedAt = '2020-01-01T00:00:00.000Z';
    const accepted = await syncAs('host-a', 'host-a', {
      operations: [
        {
          requestId,
          machineId: 'm-on-b',
          operation: 'collect_diagnostics',
          status: 'succeeded',
          error: null,
          result: { files: [], archiveKey: 'diagnostics/m-on-b/stolen.tar.gz' },
          acceptedAt: forgedAt,
          finishedAt: new Date().toISOString(),
        },
      ],
      events: [
        { id: '900000', machineId: 'm-on-b', kind: 'state_changed', state: 'stopped', reason: 'abuse', requestId: null, at: forgedAt },
        { id: '900001', machineId: 'm-on-a', kind: 'budget_exhausted', state: null, reason: null, requestId: null, at: forgedAt },
      ],
    });
    expect(accepted.status).toBe(200);

    const op = await h.client.getOperation(requestId);
    expect(op).toMatchObject({ requestId, machineId: 'm-on-a', operation: 'prepare_to_stop', status: 'succeeded', result: null });
    expect(op.acceptedAt).not.toBe(forgedAt);
    const { events } = await h.client.listEvents(undefined, 500);
    expect(events.filter((e) => e.machineId === 'm-on-b' && e.reason === 'abuse')).toEqual([]);
    const budget = events.find((e) => e.machineId === 'm-on-a' && e.kind === 'budget_exhausted');
    expect(budget?.at).toBeDefined();
    expect(budget?.at).not.toBe(forgedAt);
    expect((await h.client.getMachine('m-on-b')).state).toBe('running');
  });

  test('refuses a token that is not a presigned GetCallerIdentity for its STS, without fetching it', async () => {
    let hits = 0;
    const elsewhere = createServer((_request, response) => {
      hits += 1;
      response.end('{}');
    });
    await new Promise<void>((resolve) => elsewhere.listen(0, '127.0.0.1', resolve));
    // SAFETY: a server listening on a TCP port reports an AddressInfo.
    const { port } = elsewhere.address() as AddressInfo;
    const genuine = new URL(Buffer.from((await h.hosts.get('host-a')?.token())?.slice('pane-sts-v1.'.length) ?? '', 'base64url').toString());
    const moved = new URL(genuine);
    moved.host = `127.0.0.1:${port}`;
    const otherAction = new URL(genuine);
    otherAction.searchParams.set('Action', 'AssumeRole');
    const extraParam = new URL(genuine);
    extraParam.searchParams.set('RoleArn', 'arn:aws:iam::123456789012:role/admin');
    try {
      for (const url of [moved, otherAction, extraParam]) {
        const token = `pane-sts-v1.${Buffer.from(url.toString()).toString('base64url')}`;
        const response = await fetch(`${h.fleet.url}/v1/hosts/host-a/sync`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
        expect(response.status).toBe(401);
      }
      expect(hits).toBe(0);
    } finally {
      await new Promise((resolve) => elsewhere.close(resolve));
    }
  });
});
