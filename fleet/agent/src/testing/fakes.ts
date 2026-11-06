/**
 * Test doubles at the package's outer boundaries: F1's `Runtime` (no Firecracker, no KVM) and F5's
 * guest agent, which speaks the real vsock line protocol on a Unix socket.
 */
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import type { MachineSpec, Runtime, SnapshotFiles, Vm } from '@pane-cloud/fleet-runtime';
import type { FleetMachine } from 'pane-cloud-contract';

export interface FakeGuest {
  paneVersion: string | null;
  tailnet: FleetMachine['tailnet'];
  activity: { agentsRunning: number; clientsConnected: number; lastActivityAt: string | null };
  /** Every operation the guest agent received, in order. */
  received: string[];
  /** A broken guest agent: it takes the connection and never answers. */
  silent?: boolean;
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
        if (request.operation === 'collect_diagnostics') {
          result = { files: [{ path: '/var/log/pane-cloud/guest-agent.log', bytes: 12 }], archiveBase64: Buffer.from('fake archive').toString('base64') };
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
  /** VMs started or restored, by machine id. */
  started: string[];
  /** Ends every VM, as a host losing power would. */
  crash(): Promise<void>;
}

/** An F1 Runtime that keeps VMs in memory. A snapshot's memory file carries the guest's state. */
export function createFakeRuntime(dir: string): FakeRuntime {
  const guests = new Map<string, FakeGuest>();
  const vms = new Map<string, Vm>();
  const started: string[] = [];
  let count = 0;

  async function launch(spec: MachineSpec, guest: FakeGuest): Promise<Vm> {
    await access(spec.diskPath);
    const n = ++count;
    const cgroupPath = join(dir, 'cgroup', `${spec.machineId}-${n}`);
    await mkdir(cgroupPath, { recursive: true });
    await writeFile(join(cgroupPath, 'memory.current'), String(3 * 2 ** 30));
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
      updateNetworkRateLimit: async () => undefined,
      stop,
      isRunning: async () => vms.has(spec.machineId),
    };
    vms.set(spec.machineId, vm);
    guests.set(spec.machineId, guest);
    started.push(spec.machineId);
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
    started,
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
