import { execFile } from 'node:child_process';
import { mkdir, rm, truncate } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Creates a machine's disk from the guest template: a reflink copy (instant on XFS or btrfs, a full
 * copy elsewhere), grown to `sizeGiB` as a sparse file, with its ext4 filesystem resized to fill it.
 */
export async function createDiskFromTemplate(templatePath: string, diskPath: string, sizeGiB: number): Promise<void> {
  await mkdir(dirname(diskPath), { recursive: true });
  const partial = `${diskPath}.partial`;
  await rm(partial, { force: true });
  await run('cp', ['--reflink=auto', '--sparse=always', templatePath, partial]);
  await truncate(partial, sizeGiB * 1024 ** 3);
  await run('e2fsck', ['-fy', partial]).catch((error: { code?: number }) => {
    // e2fsck exits 1 when it fixed something, which is fine for a fresh copy.
    if (error.code !== 1) throw error;
  });
  await run('resize2fs', [partial]);
  await run('mv', ['-f', partial, diskPath]);
}
