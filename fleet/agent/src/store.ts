import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Where a process keeps the little state it cannot rebuild: one JSON document, written whole. The
 * fleet keeps operation results, machine placement and the event feed; a host keeps its machines,
 * its operations and the events it has not yet handed to the fleet.
 */
export interface StateStore<S> {
  load(): Promise<S | undefined>;
  save(state: S): Promise<void>;
}

/** A JSON file, replaced atomically on every save. */
export function fileStore<S>(path: string): StateStore<S> {
  return {
    async load() {
      try {
        // SAFETY: only this store writes the file, from a value of type S.
        return JSON.parse(await readFile(path, 'utf8')) as S;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },
    async save(state) {
      await mkdir(dirname(path), { recursive: true });
      const partial = `${path}.partial`;
      await writeFile(partial, JSON.stringify(state), { mode: 0o600 });
      await rename(partial, path);
    },
  };
}

export function memoryStore<S>(): StateStore<S> {
  let saved: string | undefined;
  return {
    load: async () => (saved === undefined ? undefined : (JSON.parse(saved) as S)),
    save: async (state) => {
      saved = JSON.stringify(state);
    },
  };
}

/**
 * Saves `read()` after each change. Saves run one at a time, and a save requested while another is
 * running writes the newest state once, so callers can await durability without piling up writes.
 */
export function createSaver<S>(store: StateStore<S>, read: () => S): () => Promise<void> {
  let running: Promise<void> | null = null;
  let queued: Promise<void> | null = null;
  const run = async () => {
    running = store.save(read());
    try {
      await running;
    } finally {
      running = null;
    }
  };
  return () => {
    if (!running) return run();
    queued ??= running.catch(() => undefined).then(() => {
      queued = null;
      return run();
    });
    return queued;
  };
}
