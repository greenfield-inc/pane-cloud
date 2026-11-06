/**
 * Host-loss volume adoption on real XFS volumes: two loop devices labelled `fleet-data`, one mounted
 * as this host's own. Needs root, xfsprogs and FLEET_VOLUME_TEST=1; CI runs it in fleet-agent.yml.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { adoptedVolumeRecovery } from './local.js';

const canRun = process.env.FLEET_VOLUME_TEST === '1' && process.platform === 'linux' && process.getuid?.() === 0;
const exec = promisify(execFile);
const sh = async (cmd: string, ...args: string[]) => (await exec(cmd, args)).stdout.trim();
const labelled = async (label: string) => (await sh('blkid', '-c', '/dev/null', '-o', 'device', '-t', `LABEL=${label}`).catch(() => '')).split('\n').filter(Boolean);

describe.skipIf(!canRun)('adopting a lost host data volume', () => {
  let work: string;
  const loops: string[] = [];
  const mounts: string[] = [];

  /** A 300 MiB XFS volume labelled fleet-data on a loop device. */
  async function volume(name: string): Promise<string> {
    const file = join(work, `${name}.img`);
    await sh('truncate', '-s', '300M', file);
    const loop = await sh('losetup', '-f', '--show', file);
    loops.push(loop);
    await sh('mkfs.xfs', '-q', '-L', 'fleet-data', loop);
    return loop;
  }

  beforeAll(async () => {
    work = await mkdtemp('/tmp/fleet-volume-test-');
    const own = await volume('own');
    const lost = await volume('lost');
    // This host's own volume, mounted as host-boot.sh mounts /srv.
    await mkdir(join(work, 'own'));
    await sh('mount', own, join(work, 'own'));
    mounts.push(join(work, 'own'));
    // The lost host's volume, laid out as its agent left it.
    const staging = join(work, 'staging');
    await mkdir(staging);
    await sh('mount', lost, staging);
    await mkdir(join(staging, 'fleet', 'disks'), { recursive: true });
    await writeFile(join(staging, 'fleet', 'host-id'), 'lost-1\n');
    await writeFile(join(staging, 'fleet', 'disks', 'm-1.ext4'), 'committed work\n');
    await sh('umount', staging);
  });

  afterAll(async () => {
    for (const path of [...mounts, join(work, 'adopted', 'lost-1')]) await sh('umount', path).catch(() => undefined);
    for (const loop of loops) await sh('losetup', '-d', loop).catch(() => undefined);
    await rm(work, { recursive: true, force: true });
  });

  test('mounts the lost host volume under its host id and relabels it, leaving one fleet-data volume', async () => {
    const recovery = adoptedVolumeRecovery({ mountRoot: join(work, 'adopted') });
    await expect(recovery.diskOf('other-host', 'm-1')).rejects.toThrow(/No unmounted fleet-data volume from other-host/);

    const disk = await recovery.diskOf('lost-1', 'm-1');
    expect(disk).toBe(join(work, 'adopted', 'lost-1', 'fleet', 'disks', 'm-1.ext4'));
    expect(await readFile(disk, 'utf8')).toBe('committed work\n');
    expect(await labelled('fleet-data')).toEqual([loops[0]]);
    expect(await labelled('fleet-adopt')).toEqual([loops[1]]);
    // A second machine from the same host uses the mounted volume.
    await expect(recovery.diskOf('lost-1', 'm-2')).rejects.toThrow(/No disk for m-2/);
  });
});
