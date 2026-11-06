/**
 * Local implementations of the host agent's ports, for development, tests and a single host before
 * the AWS account exists. The README says what each becomes in production.
 */
import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { canonicalJson, PaneRelease } from 'pane-cloud-contract';
import { z } from 'zod';
import { applyCeilings, createCpuBudget, createFileBudgetStore, decideReclaim, readResidentMiB } from '@pane-cloud/fleet-fair-use';
import type { DiagnosticsStore, FairUsePort, HostMetrics, MachineFiles, MaintenanceSignal, ReleaseList, SnapshotStore, VolumeRecovery } from './ports.js';

const run = promisify(execFile);
const exists = (path: string) => access(path, fsConstants.F_OK).then(() => true, () => false);

/**
 * Copies a file, keeping its holes: a 50 GiB machine disk holds a few GiB of data. On Linux this is
 * `cp --sparse=always`, as a reflink where the filesystem supports it; Node's copyFile would write
 * every hole out as zeros.
 */
export async function copySparse(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  if (process.platform === 'linux') await run('cp', ['--reflink=auto', '--sparse=always', from, to]);
  else await copyFile(from, to, fsConstants.COPYFILE_FICLONE);
}

const FILE_NAMES = { diskPath: 'disk.ext4', statePath: 'vmstate', memPath: 'mem' } as const;

/** A directory standing in for the snapshot bucket: `<root>/<machineId>/{disk.ext4,vmstate,mem}`. */
export function localSnapshotStore(root: string): SnapshotStore {
  return {
    async put(machineId, files) {
      const partial = join(root, `${machineId}.partial`);
      await rm(partial, { recursive: true, force: true });
      for (const key of Object.keys(FILE_NAMES) as (keyof MachineFiles)[]) await copySparse(files[key], join(partial, FILE_NAMES[key]));
      await rm(join(root, machineId), { recursive: true, force: true });
      await rename(partial, join(root, machineId));
    },
    async get(machineId, dir) {
      const from = join(root, machineId);
      if (!(await exists(join(from, FILE_NAMES.memPath)))) return null;
      const files = { diskPath: join(dir, FILE_NAMES.diskPath), statePath: join(dir, FILE_NAMES.statePath), memPath: join(dir, FILE_NAMES.memPath) };
      for (const key of Object.keys(FILE_NAMES) as (keyof MachineFiles)[]) await copySparse(join(from, FILE_NAMES[key]), files[key]);
      return files;
    },
    async delete(machineId) {
      await rm(join(root, machineId), { recursive: true, force: true });
    },
  };
}

export function localDiagnosticsStore(root: string): DiagnosticsStore {
  return {
    async put(key, archive) {
      const path = join(root, key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, archive);
    },
  };
}

const ReleaseFile = z.array(PaneRelease);

/**
 * The published releases, from a list, a JSON file (re-read on each check) or an https URL (cached
 * for five minutes). Each entry is a contract `PaneRelease`; a release matches only on all fields.
 */
export function releasesFrom(source: PaneRelease[] | string, fetchImpl: typeof fetch = fetch): ReleaseList {
  let cached: { at: number; releases: PaneRelease[] } | null = null;
  const read = async (): Promise<PaneRelease[]> => {
    if (Array.isArray(source)) return source;
    if (!source.startsWith('https://')) return ReleaseFile.parse(JSON.parse(await readFile(source, 'utf8')));
    if (cached && Date.now() - cached.at < 300_000) return cached.releases;
    const response = await fetchImpl(source);
    if (!response.ok) throw new Error(`The release list at ${source} answered ${response.status}.`);
    cached = { at: Date.now(), releases: ReleaseFile.parse(await response.json()) };
    return cached.releases;
  };
  return {
    async isPublished(release) {
      const wanted = canonicalJson(release);
      return (await read()).some((r) => canonicalJson(r) === wanted);
    },
  };
}

/** Lost hosts' data volumes mounted under `<root>/<hostId>`, laid out like `/srv/fleet`. */
export function localVolumeRecovery(root: string): VolumeRecovery {
  return {
    async diskOf(lostHostId, machineId) {
      const path = join(root, lostHostId, 'disks', `${machineId}.ext4`);
      if (!(await exists(path))) throw new Error(`No disk for ${machineId} on ${lostHostId}'s data volume.`);
      return path;
    },
  };
}

/** Maintenance is requested while `path` exists. */
export function fileMaintenanceSignal(path: string): MaintenanceSignal {
  return { requested: () => exists(path) };
}

/** F4's package as the host agent's fair-use port, keeping each machine's CPU budget in `budgetDir`. */
export function fleetFairUse(budgetDir: string, now?: () => Date): FairUsePort {
  return { ...createCpuBudget(createFileBudgetStore(budgetDir), now ? { now } : {}), applyCeilings, readResidentMiB, decideReclaim };
}

/** Host metrics off: for development and tests, and a host with no AWS region. */
export const noHostMetrics: HostMetrics = { publish: async () => undefined };

/** The label `host-boot.sh` mounts at /srv. Only this host's own data volume may carry it. */
export const DATA_LABEL = 'fleet-data';
/** An adopted volume's label: an XFS label holds at most 12 characters. */
export const ADOPTED_LABEL = 'fleet-adopt';

/**
 * A lost host's data volume, attached to this host (F6 attaches it), mounted at
 * `<mountRoot>/<lostHostId>`. The volume is found by its `fleet-data` label among unmounted block
 * devices and must hold `<dataSubdir>/host-id` naming the lost host. It is relabelled
 * `fleet-adopt` once mounted, so `host-boot.sh` never sees two `fleet-data` volumes.
 */
export function adoptedVolumeRecovery(options: { mountRoot?: string; dataSubdir?: string } = {}): VolumeRecovery {
  const mountRoot = options.mountRoot ?? '/srv/adopted';
  const dataSubdir = options.dataSubdir ?? 'fleet';
  const mounting = new Map<string, Promise<string>>();

  async function adopt(lostHostId: string): Promise<string> {
    const target = join(mountRoot, lostHostId);
    if (await isMountpoint(target)) return target;
    await mkdir(target, { recursive: true });
    // -c /dev/null: probe every device now instead of trusting blkid's cache.
    const labelled = async (label: string) => (await run('blkid', ['-c', '/dev/null', '-o', 'device', '-t', `LABEL=${label}`]).catch(() => ({ stdout: '' }))).stdout.split('\n').filter(Boolean);
    const devices = [...(await labelled(DATA_LABEL)), ...(await labelled(ADOPTED_LABEL))];
    for (const device of devices) {
      if ((await run('findmnt', ['-rn', '-S', device]).catch(() => ({ stdout: '' }))).stdout.trim()) continue;
      // Mounting replays the log of a volume whose host died, which a relabel needs.
      await run('mount', ['-o', 'noatime,nodev,nosuid', device, target]);
      const owner = (await readFile(join(target, dataSubdir, 'host-id'), 'utf8').catch(() => '')).trim();
      if (owner !== lostHostId) {
        await run('umount', [target]);
        continue;
      }
      await run('xfs_io', ['-c', `label -s ${ADOPTED_LABEL}`, target]);
      return target;
    }
    throw new Error(`No unmounted ${DATA_LABEL} volume from ${lostHostId} is attached to this host.`);
  }

  return {
    async diskOf(lostHostId, machineId) {
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(lostHostId) || lostHostId.startsWith('.')) throw new Error(`"${lostHostId}" is not a host id.`);
      let mounted = mounting.get(lostHostId);
      if (!mounted) {
        mounted = adopt(lostHostId);
        mounting.set(lostHostId, mounted);
        mounted.catch(() => mounting.delete(lostHostId));
      }
      const path = join(await mounted, dataSubdir, 'disks', `${machineId}.ext4`);
      if (!(await exists(path))) throw new Error(`No disk for ${machineId} on ${lostHostId}'s data volume.`);
      return path;
    },
  };
}

async function isMountpoint(path: string): Promise<boolean> {
  return run('mountpoint', ['-q', path]).then(
    () => true,
    () => false,
  );
}
