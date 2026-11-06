/**
 * Boots real microVMs. Needs root, /dev/kvm and the artifacts that `host/fetch-test-artifacts.sh`
 * writes to FLEET_TEST_ARTIFACTS (firecracker, jailer, vmlinux, rootfs.ext4). The test rootfs prints
 * PANE_BOOT_OK on its console once systemd reaches multi-user, then PANE_TICK <n> every 200 ms.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createRuntime, type MachineSpec, type Runtime, type Vm } from './index.js';

const artifacts = process.env.FLEET_TEST_ARTIFACTS ?? '';
const canRun = artifacts !== '' && existsSync('/dev/kvm') && process.getuid?.() === 0;
const bootBudgetMs = Number(process.env.FLEET_BOOT_BUDGET_MS ?? 2000);

async function waitForConsole(path: string, pattern: RegExp, timeoutMs: number, from = 0): Promise<RegExpMatchArray> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = (await readFile(path, 'utf8').catch(() => '')).slice(from);
    const match = text.match(pattern);
    if (match) return match;
    await new Promise((r) => setTimeout(r, 10));
  }
  const tail = (await readFile(path, 'utf8').catch(() => '')).slice(-3000);
  throw new Error(`Console never matched ${pattern} within ${timeoutMs} ms. Tail:\n${tail}`);
}

const lastTick = async (path: string) => {
  const ticks = [...(await readFile(path, 'utf8')).matchAll(/PANE_TICK (\d+)/g)];
  return Number(ticks.at(-1)?.[1] ?? -1);
};

describe.skipIf(!canRun)('fleet runtime on KVM', () => {
  let work: string;
  let runtime: Runtime;
  let slot = 0;
  const vms: Vm[] = [];

  async function spec(name: string): Promise<MachineSpec> {
    slot += 1;
    const diskPath = join(work, 'disks', `${name}.ext4`);
    await copyFile(join(artifacts, 'rootfs.ext4'), diskPath);
    return {
      machineId: name,
      uid: 60_000 + slot,
      gid: 60_000 + slot,
      vcpu: 2,
      memoryMiB: 1024,
      kernelPath: join(work, 'vmlinux'),
      diskPath,
      consoleLogPath: join(work, 'console', `${name}.log`),
      balloon: { deflateOnOom: true, statsPollingIntervalS: 1 },
    };
  }

  beforeAll(async () => {
    // Kernel, disks and jails share one filesystem so the runtime can hard-link them.
    work = await mkdtemp('/srv/fleet-test-');
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

  test(`boots from the template to multi-user within ${bootBudgetMs} ms`, async () => {
    const s = await spec('boot');
    const started = performance.now();
    const vm = await runtime.start(s);
    vms.push(vm);
    await waitForConsole(s.consoleLogPath, /PANE_BOOT_OK/, 30_000);
    const bootMs = performance.now() - started;
    console.log(`boot to multi-user: ${Math.round(bootMs)} ms`);
    expect(bootMs).toBeLessThan(bootBudgetMs);
  }, 60_000);

  test('runs each machine as its own uid inside its jail and cgroup', async () => {
    const s = await spec('jailed');
    const vm = await runtime.start(s);
    vms.push(vm);
    const status = await readFile(`/proc/${vm.pid}/status`, 'utf8');
    expect(status).toMatch(new RegExp(`^Uid:\\s+${s.uid}\\s`, 'm'));
    expect(await readFile(`/proc/${vm.pid}/cgroup`, 'utf8')).toContain(`/fleet-test/${s.machineId}`);
    expect(await readFile(join(vm.cgroupPath, 'cgroup.procs'), 'utf8')).toContain(String(vm.pid));
    // Inside its mount namespace the jail is "/": its root holds the machine's own disk and nothing of the host's.
    expect((await stat(`/proc/${vm.pid}/root/disk.ext4`)).ino).toBe((await stat(s.diskPath)).ino);
    expect(existsSync(`/proc/${vm.pid}/root/srv`)).toBe(false);
    // The machine's uid can't swap its API socket for a link to another machine's.
    const swap = spawnSync('setpriv', ['--reuid', String(s.uid), '--regid', String(s.gid), '--clear-groups', 'ln', '-sf', '/srv', join(vm.chrootPath, 'api.sock')]);
    expect(swap.status).not.toBe(0);
    expect((await lstat(join(vm.chrootPath, 'api.sock'))).isSocket()).toBe(true);
  }, 60_000);

  test('a snapshot resumes the same running guest, not a reboot', async () => {
    const s = await spec('snap');
    const vm = await runtime.start(s);
    await waitForConsole(s.consoleLogPath, /PANE_TICK 5\b/, 30_000);
    const files = await vm.snapshot(join(work, 'snapshots', s.machineId));
    const tickAtSnapshot = await lastTick(s.consoleLogPath);
    await vm.stop();
    expect(await vm.isRunning()).toBe(false);
    expect((await stat(files.memPath)).size).toBeGreaterThanOrEqual(1024 * 1024 ** 2);
    expect(existsSync(s.diskPath)).toBe(true);

    const consoleBefore = (await readFile(s.consoleLogPath, 'utf8')).length;
    const restored = await runtime.restore(s, files);
    vms.push(restored);
    const next = await waitForConsole(s.consoleLogPath, /PANE_TICK (\d+)/, 10_000, consoleBefore);
    // Counting on from where it paused shows memory came back; a reboot would print PANE_BOOT_OK and start at 0.
    expect(Number(next[1])).toBeGreaterThan(tickAtSnapshot);
    expect((await readFile(s.consoleLogPath, 'utf8')).slice(consoleBefore)).not.toContain('PANE_BOOT_OK');
  }, 90_000);

  test('the balloon takes memory back from the guest', async () => {
    const s = await spec('balloon');
    const vm = await runtime.start(s);
    vms.push(vm);
    await waitForConsole(s.consoleLogPath, /PANE_BOOT_OK/, 30_000);
    await vm.setBalloon(512);
    const deadline = Date.now() + 20_000;
    let stats = await vm.balloonStats();
    while (stats.actualMiB < 512 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      stats = await vm.balloonStats();
    }
    expect(stats.targetMiB).toBe(512);
    expect(stats.actualMiB).toBe(512);
  }, 60_000);

  test('the host agent can reattach to a running machine', async () => {
    const s = await spec('attach');
    const vm = await runtime.start(s);
    vms.push(vm);
    const again = await runtime.attach(s);
    expect(again?.pid).toBe(vm.pid);
    await again?.pause();
    await again?.resume();
    expect(await runtime.attach(await spec('never-started'))).toBeNull();
  }, 60_000);
});
