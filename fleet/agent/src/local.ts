/**
 * Local implementations of the host agent's ports, for development, tests and a single host before
 * the AWS account exists. The README says what each becomes in production.
 */
import { constants as fsConstants } from 'node:fs';
import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { canonicalJson, MACHINE_LIMITS, PaneRelease } from 'pane-cloud-contract';
import { z } from 'zod';
import type { CpuUse, DiagnosticsStore, FairUsePort, MachineFiles, MaintenanceSignal, ReleaseList, SnapshotStore, VolumeRecovery } from './ports.js';

const exists = (path: string) => access(path, fsConstants.F_OK).then(() => true, () => false);

/** Copies a file, as a reflink where the filesystem supports it. */
export async function copySparse(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to, fsConstants.COPYFILE_FICLONE);
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

/**
 * Fair use until F4 lands: no ceilings written and no reclaim, but CPU is charged from the cgroup's
 * `cpu.stat` against the daily budget, so metrics and budget events are real.
 */
export function basicFairUse(): FairUsePort {
  const days = new Map<string, { day: string; seconds: number; lastUsageUsec: number | null }>();
  return {
    applyCeilings: async () => undefined,
    async chargeCpu(machineId, cgroupPath, now): Promise<CpuUse> {
      const day = now.toISOString().slice(0, 10);
      const stat = await readFile(join(cgroupPath, 'cpu.stat'), 'utf8').catch(() => '');
      const usage = Number(/^usage_usec (\d+)$/m.exec(stat)?.[1] ?? 0);
      let entry = days.get(machineId);
      if (!entry || entry.day !== day) {
        entry = { day, seconds: 0, lastUsageUsec: entry?.lastUsageUsec ?? null };
        days.set(machineId, entry);
      }
      // A restored machine has a new cgroup whose counter starts again from zero.
      const delta = entry.lastUsageUsec === null || usage < entry.lastUsageUsec ? usage : usage - entry.lastUsageUsec;
      entry.lastUsageUsec = usage;
      entry.seconds += delta / 1e6;
      return { day, cpuSecondsUsed: entry.seconds, throttled: entry.seconds >= MACHINE_LIMITS.dailyCpuSeconds };
    },
    decideReclaim: () => [],
  };
}
