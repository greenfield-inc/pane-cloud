/**
 * Journey 5 on real microVMs, scaled to a CI runner. Needs root, /dev/kvm and FLEET_TEST_ARTIFACTS
 * holding F1's test artifacts plus rootfs-hog.ext4 (see .github/workflows/fleet-fair-use.yml): the
 * test rootfs with a unit that, given `pane.hog_mib=<n>` on the kernel command line, holds n MiB in
 * one process, lets it go, and prints `PANE_HOG_DONE <exit status>` on the console.
 */
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createRuntime, type MachineSpec, type Runtime, type Vm } from '@pane-cloud/fleet-runtime';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { MACHINE_CGROUP, VMM_OVERHEAD_MIB, decideReclaim, readResidentMiB } from './index.js';

const MiB = 1024 ** 2;
const artifacts = process.env.FLEET_TEST_ARTIFACTS ?? '';
const canRun = artifacts !== '' && existsSync(join(artifacts, 'rootfs-hog.ext4')) && existsSync('/dev/kvm') && process.getuid?.() === 0;

async function waitForConsole(path: string, pattern: RegExp, timeoutMs: number): Promise<RegExpMatchArray> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = (await readFile(path, 'utf8').catch(() => '')).match(pattern);
    if (match) return match;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Console never matched ${pattern} within ${timeoutMs} ms. Tail:\n${(await readFile(path, 'utf8').catch(() => '')).slice(-3000)}`);
}

const statOf = async (cgroup: string, file: string) =>
  Object.fromEntries((await readFile(join(cgroup, file), 'utf8')).trim().split('\n').map((l) => l.split(' ') as [string, string]).map(([k, v]) => [k, Number(v)]));

/** Resident MiB of the guest's RAM in the Firecracker process: its large anonymous mappings. */
async function guestRamResidentMiB(pid: number): Promise<number> {
  const smaps = await readFile(`/proc/${pid}/smaps`, 'utf8');
  let total = 0;
  for (const block of smaps.split(/\n(?=[0-9a-f]+-[0-9a-f]+ )/)) {
    const size = Number(block.match(/^Size:\s+(\d+) kB/m)?.[1] ?? 0);
    if (size >= 256 * 1024) total += Number(block.match(/^Rss:\s+(\d+) kB/m)?.[1] ?? 0);
  }
  return total / 1024;
}

describe.skipIf(!canRun)('fair use on KVM', () => {
  let work: string;
  let runtime: Runtime;
  let slot = 0;
  const vms: Vm[] = [];

  async function start(name: string, memoryMiB: number, hogMiB: number, cgroup: Record<string, string>): Promise<{ vm: Vm; spec: MachineSpec }> {
    slot += 1;
    const diskPath = join(work, 'disks', `${name}.ext4`);
    await copyFile(join(artifacts, 'rootfs-hog.ext4'), diskPath);
    const spec: MachineSpec = {
      machineId: name,
      uid: 61_000 + slot,
      gid: 61_000 + slot,
      vcpu: 2,
      memoryMiB,
      kernelPath: join(work, 'vmlinux'),
      diskPath,
      consoleLogPath: join(work, 'console', `${name}.log`),
      extraBootArgs: `pane.hog_mib=${hogMiB}`,
      balloon: { deflateOnOom: true, statsPollingIntervalS: 1 },
      cgroup,
    };
    const vm = await runtime.start(spec);
    vms.push(vm);
    return { vm, spec };
  }

  beforeAll(async () => {
    work = await mkdtemp('/srv/fleet-fair-use-test-');
    await copyFile(join(artifacts, 'vmlinux'), join(work, 'vmlinux'));
    await mkdir(join(work, 'disks'));
    runtime = createRuntime({
      firecrackerBin: join(artifacts, 'firecracker'),
      jailerBin: join(artifacts, 'jailer'),
      chrootBase: join(work, 'jail'),
      cgroupParent: 'fleet-test',
    });
  });

  afterAll(async () => {
    for (const vm of vms) await vm.stop().catch(() => undefined);
    if (work) await rm(work, { recursive: true, force: true });
  });

  test('a guest that allocates more than its memory is OOM-killed inside the guest, and the VMM fits its headroom', async () => {
    // The production ceiling is 16 GiB plus the headroom; here 1 GiB plus the same headroom.
    const guestMiB = 1024;
    const { vm, spec } = await start('oom', guestMiB, 2 * guestMiB, { ...MACHINE_CGROUP, 'memory.max': String((guestMiB + VMM_OVERHEAD_MIB) * MiB) });
    const done = await waitForConsole(spec.consoleLogPath, /PANE_HOG_DONE (\d+)/, 120_000);
    expect(Number(done[1])).toBe(137); // SIGKILL from the guest's OOM killer

    expect(await vm.isRunning()).toBe(true);
    expect((await statOf(vm.cgroupPath, 'memory.events')).oom_kill).toBe(0);

    const current = Number((await readFile(join(vm.cgroupPath, 'memory.current'), 'utf8')).trim()) / MiB;
    const stat = await statOf(vm.cgroupPath, 'memory.stat');
    const guestRam = await guestRamResidentMiB(vm.pid);
    const overhead = current - (stat.file ?? 0) / MiB - guestRam;
    console.log(
      `guest RAM resident ${guestRam.toFixed(0)} MiB of ${guestMiB}; VMM overhead ${overhead.toFixed(1)} MiB ` +
        `(kernel ${((stat.kernel ?? 0) / MiB).toFixed(1)}, pagetables ${((stat.pagetables ?? 0) / MiB).toFixed(1)}, ` +
        `sec_pagetables ${((stat.sec_pagetables ?? 0) / MiB).toFixed(1)}, anon ${((stat.anon ?? 0) / MiB).toFixed(1)}, file ${((stat.file ?? 0) / MiB).toFixed(1)})`,
    );
    expect(guestRam).toBeGreaterThan(guestMiB * 0.8);
    // A full 16 GiB guest adds 64 MiB of page tables (host and stage-2, 4 KiB pages) to what a 1 GiB guest needs.
    expect(overhead + 64).toBeLessThanOrEqual(VMM_OVERHEAD_MIB);
  }, 180_000);

  test('after a large build on an idle machine, the balloon brings host-side memory down', async () => {
    const guestMiB = 4096;
    const { vm, spec } = await start('reclaim', guestMiB, 3000, { ...MACHINE_CGROUP });
    expect((await waitForConsole(spec.consoleLogPath, /PANE_HOG_DONE (\d+)/, 120_000))[1]).toBe('0');

    let stats = await vm.balloonStats();
    for (let i = 0; i < 30 && stats.availableMemory === undefined; i++) {
      await new Promise((r) => setTimeout(r, 1_000));
      stats = await vm.balloonStats();
    }
    const before = await readResidentMiB(vm.cgroupPath);
    expect(before).toBeGreaterThan(3000);

    const actions = decideReclaim({ totalMiB: 512 * 1024, usedMiB: 64 * 1024 }, [{ machineId: spec.machineId, residentMiB: before, idle: true, balloon: stats, residentAboveLimitForMs: 0 }]);
    const inflate = actions.find((a) => a.kind === 'inflate');
    expect(inflate?.targetMiB).toBeGreaterThan(0);
    const target = inflate?.targetMiB ?? 0;
    await vm.setBalloon(target);

    // Journey 5 allows 5 minutes.
    const deadline = Date.now() + 5 * 60_000;
    while ((await vm.balloonStats()).actualMiB < target && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1_000));
    const after = await readResidentMiB(vm.cgroupPath);
    console.log(`resident ${before.toFixed(0)} MiB before the balloon, ${after.toFixed(0)} MiB after a ${target} MiB balloon`);
    expect(after).toBeLessThanOrEqual(guestMiB - target + VMM_OVERHEAD_MIB);
  }, 600_000);
});
