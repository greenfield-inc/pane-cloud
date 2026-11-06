import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool, type PoolClient } from 'pg';

export type Db = Pool;

export function createDb(databaseUrl: string): Db {
  return new Pool({ connectionString: databaseUrl, max: 10 });
}

/** The workspace's packages directory: every packages/<name>/migrations folder holds SQL migrations. */
const PACKAGES_DIR = path.join(__dirname, '..', '..');

/** Every packages/<name>/migrations/*.sql file, ordered by file name (its number), then package. */
async function migrationFiles(): Promise<{ name: string; file: string }[]> {
  const found: { name: string; base: string; file: string }[] = [];
  for (const pkg of await readdir(PACKAGES_DIR)) {
    const dir = path.join(PACKAGES_DIR, pkg, 'migrations');
    const files = await readdir(dir).catch(() => [] as string[]);
    for (const base of files.filter((f) => f.endsWith('.sql'))) found.push({ name: `${pkg}/${base}`, base, file: path.join(dir, base) });
  }
  return found.sort((a, b) => (a.base === b.base ? (a.name < b.name ? -1 : 1) : a.base < b.base ? -1 : 1));
}

/**
 * Applies every migration not yet applied, in number order across the workspace's packages, each in
 * its own transaction.
 */
export async function migrate(db: Db): Promise<string[]> {
  const client = await db.connect();
  try {
    // One migrator at a time when several instances start together.
    await client.query('SELECT pg_advisory_lock(7482001)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const applied = new Set((await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const ran: string[] = [];
    for (const { name, file } of await migrationFiles()) {
      if (applied.has(name)) continue;
      const sql = await readFile(file, 'utf8');
      await inTransaction(client, async () => {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      });
      ran.push(name);
    }
    return ran;
  } finally {
    await client.query('SELECT pg_advisory_unlock(7482001)').catch(() => undefined);
    client.release();
  }
}

async function inTransaction<T>(client: PoolClient, body: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    const result = await body();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/** Runs body in one transaction on its own client. */
export async function transaction<T>(db: Db, body: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    return await inTransaction(client, () => body(client));
  } finally {
    client.release();
  }
}
