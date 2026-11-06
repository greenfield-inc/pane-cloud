/**
 * Test doubles at the package's outer boundaries: F1's `Runtime` (no Firecracker, no KVM), F5's
 * guest agent, which speaks the real vsock line protocol on a Unix socket, and F3's network, whose
 * real implementation drives `ip` and `nft` as root.
 */
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { type AddressInfo, createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { addressForSlot, type MachineAddress } from '@pane-cloud/fleet-network';
import type { MachineSpec, RateLimit, Runtime, SnapshotFiles, Vm } from '@pane-cloud/fleet-runtime';
import type { FleetMachine } from 'pane-cloud-contract';
import type { NetworkPort } from '../ports.js';

export interface FakeGuest {
  paneVersion: string | null;
  tailnet: FleetMachine['tailnet'];
  activity: { agentsRunning: number; clientsConnected: number; lastActivityAt: string | null };
  /** Every operation the guest agent received, in order. */
  received: string[];
  /** A broken guest agent: it takes the connection and never answers. */
  silent?: boolean;
  /** A diagnostics archive that does not match the SHA-256 the guest sends with it. */
  corruptDiagnostics?: boolean;
}

/** Serves the guest agent protocol; the returned function ends it as a VM's process ending would. */
function serveGuest(socketPath: string, guest: FakeGuest): Promise<() => Promise<void>> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    let connected = false;
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        if (!connected) {
          connected = line === 'CONNECT 1024';
          socket.write(connected ? 'OK 1073741824\n' : 'ERR\n');
          continue;
        }
        const request = JSON.parse(line) as { id: string; operation: string; parameters: { release?: { version: string } } };
        guest.received.push(request.operation);
        if (guest.silent) continue;
        let result: unknown = {};
        if (request.operation === 'status') result = { paneVersion: guest.paneVersion, tailnet: guest.tailnet, activity: guest.activity };
        if (request.operation === 'bootstrap' || request.operation === 'update_pane') {
          guest.paneVersion = request.parameters.release?.version ?? null;
          guest.tailnet = { status: 'awaiting_login', loginUrl: 'https://login.tailscale.com/a/fake', hostname: null };
        }
        if (request.operation === 'bootstrap') result = { paneVersion: guest.paneVersion, firstBoot: 'done' };
        if (request.operation === 'collect_diagnostics') {
          const archive = Buffer.from('fake archive');
          const sent = guest.corruptDiagnostics ? Buffer.from('other archive') : archive;
          result = {
            files: [{ path: '/var/log/pane-cloud/guest-agent.log', bytes: 12 }],
            skipped: [],
            archive: { format: 'tar+gzip', bytes: sent.length, sha256: createHash('sha256').update(archive).digest('hex'), base64: sent.toString('base64') },
          };
        }
        socket.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
      }
    });
  });
  const close = async () => {
    const closed = new Promise((resolve) => server.close(resolve));
    for (const socket of sockets) socket.destroy();
    await closed;
  };
  return new Promise((resolve) => server.listen(socketPath, () => resolve(close)));
}

export interface FakeRuntime {
  runtime: Runtime;
  /** The guest of each machine with a running VM. */
  guests: Map<string, FakeGuest>;
  /** Each machine's running VM. */
  vms: Map<string, Vm>;
  /** VMs started or restored, by machine id. */
  started: string[];
  /** The spec of every start and restore, in order. */
  specs: MachineSpec[];
  /** Every rate limit set on a running VM, by machine id. */
  txLimits: Map<string, (RateLimit | undefined)[]>;
  /** Ends every VM, as a host losing power would. */
  crash(): Promise<void>;
}

/** An F1 Runtime that keeps VMs in memory. A snapshot's memory file carries the guest's state. */
export function createFakeRuntime(dir: string): FakeRuntime {
  const guests = new Map<string, FakeGuest>();
  const vms = new Map<string, Vm>();
  const started: string[] = [];
  const specs: MachineSpec[] = [];
  const txLimits = new Map<string, (RateLimit | undefined)[]>();
  let count = 0;

  async function launch(spec: MachineSpec, guest: FakeGuest): Promise<Vm> {
    await access(spec.diskPath);
    const n = ++count;
    const cgroupPath = join(dir, 'cgroup', `${spec.machineId}-${n}`);
    await mkdir(cgroupPath, { recursive: true });
    // What the jailer writes, then what the kernel reports.
    for (const [file, value] of Object.entries(spec.cgroup ?? {})) await writeFile(join(cgroupPath, file), value);
    await writeFile(join(cgroupPath, 'memory.current'), String(3 * 2 ** 30));
    await writeFile(join(cgroupPath, 'memory.stat'), 'anon 3221225472\nfile 0\n');
    await writeFile(join(cgroupPath, 'cpu.stat'), 'usage_usec 1500000\n');
    const vsockPath = join(dir, `v${n}.sock`);
    const closeGuest = await serveGuest(vsockPath, guest);
    const stop = async () => {
      vms.delete(spec.machineId);
      guests.delete(spec.machineId);
      await closeGuest();
    };
    const vm: Vm = {
      machineId: spec.machineId,
      pid: 10_000 + n,
      cgroupPath,
      vsockPath,
      chrootPath: join(dir, 'jail', spec.machineId),
      pause: async () => undefined,
      resume: async () => undefined,
      async snapshot(destDir): Promise<SnapshotFiles> {
        await mkdir(destDir, { recursive: true });
        const files = { statePath: join(destDir, 'vmstate'), memPath: join(destDir, 'mem') };
        await writeFile(files.statePath, spec.machineId);
        await writeFile(files.memPath, JSON.stringify(guest));
        return files;
      },
      setBalloon: async () => undefined,
      balloonStats: async () => ({ targetMiB: 0, actualMiB: 0 }),
      updateNetworkRateLimit: async ({ tx }) => {
        txLimits.set(spec.machineId, [...(txLimits.get(spec.machineId) ?? []), tx]);
      },
      stop,
      isRunning: async () => vms.has(spec.machineId),
    };
    vms.set(spec.machineId, vm);
    guests.set(spec.machineId, guest);
    started.push(spec.machineId);
    specs.push(spec);
    return vm;
  }

  const freshGuest = (): FakeGuest => ({
    paneVersion: null,
    tailnet: { status: 'awaiting_login', loginUrl: null, hostname: null },
    activity: { agentsRunning: 0, clientsConnected: 0, lastActivityAt: null },
    received: [],
  });

  return {
    guests,
    vms,
    started,
    specs,
    txLimits,
    runtime: {
      start: (spec) => launch(spec, freshGuest()),
      async restore(spec, snapshot) {
        const guest = JSON.parse(await readFile(snapshot.memPath, 'utf8')) as FakeGuest;
        return launch(spec, { ...guest, received: [] });
      },
      attach: async (spec) => vms.get(spec.machineId) ?? null,
    },
    async crash() {
      for (const vm of [...vms.values()]) await vm.stop();
    },
  };
}

export interface FakeNetwork {
  network: NetworkPort;
  /** Each attached machine's egress counter, in bytes; a test sets it to make traffic. */
  counters: Map<string, number>;
  /** Every attach, in order. */
  attached: { machineId: string; slot: number; uid: number; address: MachineAddress }[];
}

/** F3 without `ip` and `nft`: F3's own address plan, and counters a test sets. */
export function createFakeNetwork(): FakeNetwork {
  const counters = new Map<string, number>();
  const attached: FakeNetwork['attached'] = [];
  return {
    counters,
    attached,
    network: {
      installHostRules: async () => undefined,
      async attach(machineId, slot, { uid }) {
        const address = addressForSlot(machineId, slot);
        attached.push({ machineId, slot, uid, address });
        counters.set(machineId, 0);
        return address;
      },
      async egressBytes(machineId) {
        const bytes = counters.get(machineId);
        if (bytes === undefined) throw new Error(`No egress counter for machine ${machineId}; it is not attached.`);
        return bytes;
      },
      async detach(machineId) {
        counters.delete(machineId);
      },
    },
  };
}

export interface FakeSts {
  url: string;
  /** The host role every fake session belongs to. */
  hostRoleArn: string;
  /** Credentials whose session name is `hostId`, as an instance role's is its instance id. */
  credentialsFor(hostId: string): { accessKeyId: string; secretAccessKey: string };
  close(): Promise<void>;
}

/**
 * STS's GetCallerIdentity for presigned requests. It trusts the access key instead of checking the
 * signature, and answers only requests that signed and sent `x-pane-fleet-id`, as real STS would.
 */
export async function startFakeSts(): Promise<FakeSts> {
  const account = '123456789012';
  const role = 'fleet-host';
  const server = createHttpServer((request, response) => {
    const query = new URL(request.url ?? '/', 'http://sts').searchParams;
    const accessKeyId = (query.get('X-Amz-Credential') ?? '').split('/')[0] ?? '';
    const signed = (query.get('X-Amz-SignedHeaders') ?? '').split(';');
    const ok = query.get('Action') === 'GetCallerIdentity' && accessKeyId.startsWith('host:') && signed.includes('x-pane-fleet-id') && request.headers['x-pane-fleet-id'] === 'pane-cloud';
    response.writeHead(ok ? 200 : 403, { 'content-type': 'application/json' });
    const arn = `arn:aws:sts::${account}:assumed-role/${role}/${accessKeyId.slice('host:'.length)}`;
    response.end(JSON.stringify(ok ? { GetCallerIdentityResponse: { GetCallerIdentityResult: { Arn: arn, Account: account, UserId: 'AROAFAKE' } } } : { Error: { Code: 'SignatureDoesNotMatch' } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  // SAFETY: a server listening on a TCP port reports an AddressInfo.
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    hostRoleArn: `arn:aws:iam::${account}:role/${role}`,
    credentialsFor: (hostId) => ({ accessKeyId: `host:${hostId}`, secretAccessKey: 'fake' }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
