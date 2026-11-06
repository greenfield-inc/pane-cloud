import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, chown, copyFile, link, mkdir, open, readFile, rename, rm, rmdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { firecrackerApi, type FirecrackerApi } from './api.js';

/** A token bucket on a network interface, in bytes: `size` bytes refilled every `refillTimeMs`. */
export interface RateLimit {
  size: number;
  refillTimeMs: number;
  oneTimeBurst?: number;
}

export interface MachineNetwork {
  /** The host tap device, created by F3 before start. */
  tapName: string;
  guestMac: string;
  /** Kernel `ip=` argument that configures the guest's eth0 (F3's `kernelIpArg`). */
  kernelIpArg?: string;
  txRateLimit?: RateLimit;
  rxRateLimit?: RateLimit;
}

export interface MachineSpec {
  machineId: string;
  /** The machine's own uid and gid on the host; no two machines share them. */
  uid: number;
  gid: number;
  vcpu: number;
  memoryMiB: number;
  /** Uncompressed guest kernel on the host. */
  kernelPath: string;
  /** The machine's ext4 disk on the host. It must be on the same filesystem as the chroot base. */
  diskPath: string;
  /** Where the guest's serial console is written on the host. */
  consoleLogPath: string;
  network?: MachineNetwork;
  /** Kernel arguments added after the defaults. */
  extraBootArgs?: string;
  /** Balloon device, attached deflated. Firecracker deflates it on guest OOM when `deflateOnOom`. */
  balloon?: { deflateOnOom: boolean; statsPollingIntervalS: number };
  /** cgroup v2 files the jailer writes before Firecracker starts, such as `{ 'cpu.max': '800000 100000' }`. */
  cgroup?: Record<string, string>;
}

export interface RuntimeConfig {
  firecrackerBin: string;
  jailerBin: string;
  /** Jailer `--chroot-base-dir`; each machine's jail is `<chrootBase>/firecracker/<machineId>/root`. */
  chrootBase: string;
  /** Jailer `--parent-cgroup`, relative to the cgroup v2 root; each machine's cgroup is `<parent>/<machineId>`. */
  cgroupParent: string;
  cgroupRoot?: string;
  /** How long to wait for Firecracker's API socket after starting the jailer. */
  startTimeoutMs?: number;
}

/** A full snapshot on the host: the VM state file and the guest memory file. */
export interface SnapshotFiles {
  statePath: string;
  memPath: string;
}

export interface BalloonStats {
  targetMiB: number;
  actualMiB: number;
  /** Guest-reported counters, in bytes; present once the guest driver has reported. */
  freeMemory?: number;
  availableMemory?: number;
  totalMemory?: number;
}

export interface Vm {
  readonly machineId: string;
  readonly pid: number;
  /** cgroup v2 directory of this machine's Firecracker process, for F4. */
  readonly cgroupPath: string;
  /** Host path of the vsock socket; connect and send `CONNECT <port>\n` to reach a guest port. */
  readonly vsockPath: string;
  readonly chrootPath: string;
  pause(): Promise<void>;
  resume(): Promise<void>;
  /** Pauses the VM and writes a full snapshot into `destDir`. The VM stays paused. */
  snapshot(destDir: string): Promise<SnapshotFiles>;
  setBalloon(amountMiB: number): Promise<void>;
  balloonStats(): Promise<BalloonStats>;
  updateNetworkRateLimit(limits: { tx?: RateLimit; rx?: RateLimit }): Promise<void>;
  /** Ends the Firecracker process and removes its jail and cgroup. The disk is kept. */
  stop(): Promise<void>;
  isRunning(): Promise<boolean>;
}

export interface Runtime {
  /** Boots a new microVM from its kernel and disk. */
  start(spec: MachineSpec): Promise<Vm>;
  /** Starts a microVM from a snapshot taken by `Vm.snapshot`, resumed. */
  restore(spec: MachineSpec, snapshot: SnapshotFiles): Promise<Vm>;
  /** Reconnects to a microVM that is already running, for example after the host agent restarts. */
  attach(spec: MachineSpec): Promise<Vm | null>;
}

const DEFAULT_BOOT_ARGS = 'console=ttyS0 reboot=k panic=1 pci=off';
const GUEST_CID = 3;
const JAIL = { kernel: '/vmlinux', disk: '/disk.ext4', apiSock: '/api.sock', vsock: '/v.sock', snapshotDir: '/snapshot' } as const;

export function createRuntime(config: RuntimeConfig): Runtime {
  const cgroupRoot = config.cgroupRoot ?? '/sys/fs/cgroup';
  const execName = basename(config.firecrackerBin);
  const jailDir = (id: string) => join(config.chrootBase, execName, id);
  const chrootOf = (id: string) => join(jailDir(id), 'root');

  async function prepareJail(spec: MachineSpec): Promise<string> {
    const chroot = chrootOf(spec.machineId);
    await rm(jailDir(spec.machineId), { recursive: true, force: true });
    await mkdir(join(chroot, JAIL.snapshotDir), { recursive: true });
    await linkOrCopy(spec.kernelPath, join(chroot, JAIL.kernel));
    // The disk is hard-linked, never copied: the guest must write to the machine's own disk file.
    await link(spec.diskPath, join(chroot, JAIL.disk));
    await chown(spec.diskPath, spec.uid, spec.gid);
    await chown(join(chroot, JAIL.snapshotDir), spec.uid, spec.gid);
    return chroot;
  }

  async function launch(spec: MachineSpec, stage?: (chroot: string) => Promise<void>): Promise<{ api: FirecrackerApi; pid: number; chroot: string }> {
    const chroot = await prepareJail(spec);
    await stage?.(chroot);
    await mkdir(dirname(spec.consoleLogPath), { recursive: true });
    const consoleFile = await open(spec.consoleLogPath, 'a');
    const cgroupArgs = Object.entries(spec.cgroup ?? { 'cpu.weight': '100' }).flatMap(([file, value]) => ['--cgroup', `${file}=${value}`]);
    const child = spawn(
      config.jailerBin,
      [
        '--id', spec.machineId,
        '--exec-file', config.firecrackerBin,
        '--uid', String(spec.uid),
        '--gid', String(spec.gid),
        '--chroot-base-dir', config.chrootBase,
        '--cgroup-version', '2',
        '--parent-cgroup', config.cgroupParent,
        ...cgroupArgs,
        '--new-pid-ns',
        '--',
        '--api-sock', JAIL.apiSock,
        '--level', 'Warning',
      ],
      { detached: true, stdio: ['ignore', consoleFile.fd, consoleFile.fd] },
    );
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    child.unref();
    await consoleFile.close();
    const pid = await waitForPid(chroot, execName, exited, config.startTimeoutMs ?? 10_000);
    const api = firecrackerApi(join(chroot, JAIL.apiSock));
    await waitForApi(api, join(chroot, JAIL.apiSock), config.startTimeoutMs ?? 10_000, spec.consoleLogPath);
    return { api, pid, chroot };
  }

  function vmFor(spec: MachineSpec, api: FirecrackerApi, pid: number, chroot: string): Vm {
    const cgroupPath = join(cgroupRoot, config.cgroupParent, spec.machineId);
    return {
      machineId: spec.machineId,
      pid,
      cgroupPath,
      vsockPath: join(chroot, JAIL.vsock),
      chrootPath: chroot,
      pause: async () => {
        await api.call('PATCH', '/vm', { state: 'Paused' });
      },
      resume: async () => {
        await api.call('PATCH', '/vm', { state: 'Resumed' });
      },
      snapshot: async (destDir) => {
        await api.call('PATCH', '/vm', { state: 'Paused' });
        const state = join(JAIL.snapshotDir, 'vmstate');
        const mem = join(JAIL.snapshotDir, 'mem');
        await api.call('PUT', '/snapshot/create', { snapshot_type: 'Full', snapshot_path: state, mem_file_path: mem });
        await mkdir(destDir, { recursive: true });
        const files = { statePath: join(destDir, 'vmstate'), memPath: join(destDir, 'mem') };
        await rename(join(chroot, state), files.statePath);
        await rename(join(chroot, mem), files.memPath);
        return files;
      },
      setBalloon: async (amountMiB) => {
        await api.call('PATCH', '/balloon', { amount_mib: Math.max(0, Math.floor(amountMiB)) });
      },
      balloonStats: async () => {
        const s = await api.call<{ target_mib: number; actual_mib: number; free_memory?: number; available_memory?: number; total_memory?: number }>('GET', '/balloon/statistics');
        return { targetMiB: s.target_mib, actualMiB: s.actual_mib, freeMemory: s.free_memory, availableMemory: s.available_memory, totalMemory: s.total_memory };
      },
      updateNetworkRateLimit: async ({ tx, rx }) => {
        await api.call('PATCH', '/network-interfaces/eth0', {
          iface_id: 'eth0',
          ...(tx ? { tx_rate_limiter: rateLimiter(tx) } : {}),
          ...(rx ? { rx_rate_limiter: rateLimiter(rx) } : {}),
        });
      },
      stop: async () => {
        await killAndWait(pid);
        await rm(jailDir(spec.machineId), { recursive: true, force: true });
        await rmdir(cgroupPath).catch(() => undefined);
      },
      isRunning: () => isAlive(pid),
    };
  }

  return {
    async start(spec) {
      const { api, pid, chroot } = await launch(spec);
      try {
        await api.call('PUT', '/machine-config', { vcpu_count: spec.vcpu, mem_size_mib: spec.memoryMiB, smt: false });
        await api.call('PUT', '/boot-source', {
          kernel_image_path: JAIL.kernel,
          boot_args: [DEFAULT_BOOT_ARGS, spec.network?.kernelIpArg, spec.extraBootArgs].filter(Boolean).join(' '),
        });
        // Writeback honours the guest's flushes, so a file the guest synced survives a host crash.
        await api.call('PUT', '/drives/rootfs', { drive_id: 'rootfs', path_on_host: JAIL.disk, is_root_device: true, is_read_only: false, cache_type: 'Writeback' });
        if (spec.network) {
          await api.call('PUT', '/network-interfaces/eth0', {
            iface_id: 'eth0',
            host_dev_name: spec.network.tapName,
            guest_mac: spec.network.guestMac,
            ...(spec.network.txRateLimit ? { tx_rate_limiter: rateLimiter(spec.network.txRateLimit) } : {}),
            ...(spec.network.rxRateLimit ? { rx_rate_limiter: rateLimiter(spec.network.rxRateLimit) } : {}),
          });
        }
        await api.call('PUT', '/vsock', { guest_cid: GUEST_CID, uds_path: JAIL.vsock });
        if (spec.balloon) {
          await api.call('PUT', '/balloon', { amount_mib: 0, deflate_on_oom: spec.balloon.deflateOnOom, stats_polling_interval_s: spec.balloon.statsPollingIntervalS });
        }
        await api.call('PUT', '/entropy', {});
        await api.call('PUT', '/actions', { action_type: 'InstanceStart' });
      } catch (error) {
        await killAndWait(pid);
        throw error;
      }
      return vmFor(spec, api, pid, chroot);
    },

    async restore(spec, snapshot) {
      const { api, pid, chroot } = await launch(spec, async (jail) => {
        for (const [from, name] of [
          [snapshot.statePath, 'vmstate'],
          [snapshot.memPath, 'mem'],
        ] as const) {
          const target = join(jail, JAIL.snapshotDir, name);
          await linkOrCopy(from, target);
          await chown(target, spec.uid, spec.gid);
        }
      });
      try {
        await api.call('PUT', '/snapshot/load', {
          snapshot_path: join(JAIL.snapshotDir, 'vmstate'),
          mem_backend: { backend_type: 'File', backend_path: join(JAIL.snapshotDir, 'mem') },
          resume_vm: true,
        });
      } catch (error) {
        await killAndWait(pid);
        throw error;
      }
      return vmFor(spec, api, pid, chroot);
    },

    async attach(spec) {
      const chroot = chrootOf(spec.machineId);
      const pid = await readPid(chroot, execName);
      if (pid === null || !(await isAlive(pid))) return null;
      return vmFor(spec, firecrackerApi(join(chroot, JAIL.apiSock)), pid, chroot);
    },
  };
}

function rateLimiter(limit: RateLimit) {
  return { bandwidth: { size: limit.size, refill_time: limit.refillTimeMs, ...(limit.oneTimeBurst ? { one_time_burst: limit.oneTimeBurst } : {}) } };
}

async function linkOrCopy(from: string, to: string): Promise<void> {
  try {
    await link(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await copyFile(from, to);
  }
}

async function readPid(chroot: string, execName: string): Promise<number | null> {
  try {
    const pid = Number.parseInt((await readFile(join(chroot, `${execName}.pid`), 'utf8')).trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function waitForPid(chroot: string, execName: string, exited: Promise<number | null>, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let exitCode: number | null | undefined;
  void exited.then((code) => (exitCode = code));
  while (Date.now() < deadline) {
    const pid = await readPid(chroot, execName);
    if (pid !== null) return pid;
    if (exitCode !== undefined && exitCode !== 0) throw new Error(`The jailer exited with code ${exitCode} before Firecracker started.`);
    await sleep(5);
  }
  throw new Error(`Firecracker did not start within ${timeoutMs} ms.`);
}

async function waitForApi(api: FirecrackerApi, socketPath: string, timeoutMs: number, consoleLogPath: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(socketPath, fsConstants.F_OK);
      await api.call('GET', '/');
      return;
    } catch {
      await sleep(5);
    }
  }
  const tail = await readFile(consoleLogPath, 'utf8').then((t) => t.slice(-2000)).catch(() => '');
  throw new Error(`Firecracker's API socket did not answer within ${timeoutMs} ms. Console:\n${tail}`);
}

async function isAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    // A zombie still answers kill(0); check its state.
    const status = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
    return !/^\d+ \(.*\) Z/.test(status);
  } catch {
    return false;
  }
}

async function killAndWait(pid: number, timeoutMs = 5_000): Promise<void> {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    return;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && (await isAlive(pid))) await sleep(10);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

