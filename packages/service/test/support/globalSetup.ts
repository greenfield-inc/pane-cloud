import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TestProject } from 'vitest/node' with { 'resolution-mode': 'import' };

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

declare module 'vitest' {
  export interface ProvidedContext {
    adminDatabaseUrl: string;
  }
}

/**
 * Gives the tests a Postgres server: TEST_DATABASE_URL when set (CI), otherwise a throwaway cluster
 * made with initdb in a temp directory and removed afterwards.
 */
export default async function setup(project: TestProject) {
  const given = process.env.TEST_DATABASE_URL;
  if (given) {
    project.provide('adminDatabaseUrl', given);
    return;
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'pane-cloud-pg-'));
  const data = path.join(dir, 'data');
  execFileSync('initdb', ['-D', data, '-U', 'postgres', '--auth=trust', '--no-sync'], { stdio: 'ignore' });
  const port = await freePort();
  const server = spawn('postgres', ['-D', data, '-p', String(port), '-k', dir, '-c', 'listen_addresses=127.0.0.1', '-c', 'fsync=off'], { stdio: 'ignore' });
  const url = `postgres://postgres@127.0.0.1:${port}/postgres`;
  for (let i = 0; i < 100; i += 1) {
    try {
      execFileSync('pg_isready', ['-h', '127.0.0.1', '-p', String(port)], { stdio: 'ignore' });
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  project.provide('adminDatabaseUrl', url);
  return async () => {
    server.kill('SIGINT');
    await new Promise((resolve) => server.once('exit', resolve));
    rmSync(dir, { recursive: true, force: true });
  };
}
