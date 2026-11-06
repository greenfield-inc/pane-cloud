import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MACHINE_LIMITS } from 'pane-cloud-contract';

const MiB = 1024 ** 2;
const CPU_PERIOD_US = 100_000;

/**
 * Host memory one Firecracker process needs beyond its guest's RAM, so a guest that fills its
 * 16 GiB is OOM-killed inside the guest and never by the host. Page tables for a fully touched
 * 16 GiB guest at 4 KiB pages take 32 MiB on the host and 32 MiB in KVM's stage-2 tables; the VMM's
 * own threads take at most 5 MiB (Firecracker's SPECIFICATION.md); the rest is room for vCPU stacks,
 * vsock buffers and the disk's dirty page cache during a snapshot. It is a ceiling, not a
 * reservation: it costs host memory only while a guest is full. The KVM test measures it.
 */
export const VMM_OVERHEAD_MIB = 256;

/** `cpu.max` for a share of CPUs: quota and period in microseconds. */
export function cpuMax(vcpu: number): string {
  return `${Math.round(vcpu * CPU_PERIOD_US)} ${CPU_PERIOD_US}`;
}

/**
 * The cgroup v2 files every machine starts with; pass as F1's `MachineSpec.cgroup`. Equal
 * `cpu.weight` means machines bursting at once split a busy host evenly.
 */
export const MACHINE_CGROUP: Readonly<Record<string, string>> = {
  'cpu.max': cpuMax(MACHINE_LIMITS.vcpu),
  'cpu.weight': '100',
  'memory.max': String((MACHINE_LIMITS.memoryMiB + VMM_OVERHEAD_MIB) * MiB),
  'memory.swap.max': '0',
  // Firecracker runs one main thread, an API thread and one thread per vCPU, and never forks.
  'pids.max': '64',
};

/**
 * Writes MACHINE_CGROUP into a running machine's cgroup. This sets `cpu.max` back to 8 vCPU, so run
 * the CPU budget's `check` afterwards to restore a throttle.
 */
export async function applyCeilings(cgroupPath: string): Promise<void> {
  for (const [file, value] of Object.entries(MACHINE_CGROUP)) {
    await writeFile(join(cgroupPath, file), value);
  }
}

/**
 * The machine's host-side resident memory: `memory.current` less the host page cache of its disk,
 * which the kernel reclaims on its own. This is the metric's `memoryResidentMiB` and what
 * `decideReclaim` acts on.
 */
export async function readResidentMiB(cgroupPath: string): Promise<number> {
  const current = Number((await readFile(join(cgroupPath, 'memory.current'), 'utf8')).trim());
  const file = statField(await readFile(join(cgroupPath, 'memory.stat'), 'utf8'), 'file');
  return Math.max(0, current - file) / MiB;
}

/** Host memory in MiB from /proc/meminfo; used is total less what the kernel can still hand out. */
export async function readHostMemory(meminfoPath = '/proc/meminfo'): Promise<{ totalMiB: number; usedMiB: number }> {
  const text = await readFile(meminfoPath, 'utf8');
  const totalKiB = statField(text, 'MemTotal:');
  const availableKiB = statField(text, 'MemAvailable:');
  return { totalMiB: totalKiB / 1024, usedMiB: (totalKiB - availableKiB) / 1024 };
}

/** The number after `key` in a "key value" file such as cpu.stat or memory.stat. */
export function statField(text: string, key: string): number {
  for (const line of text.split('\n')) {
    const [name, value] = line.trim().split(/\s+/);
    if (name === key && value !== undefined) return Number(value);
  }
  throw new Error(`No "${key}" field in a cgroup stat file.`);
}
