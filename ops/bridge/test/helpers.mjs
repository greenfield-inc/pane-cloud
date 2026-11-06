import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'bridge.mjs');

export const ABUSE_ENV = {
  BRIDGE_EGRESS_GB_PER_DAY: '10',
  BRIDGE_CPU_PERCENT: '90',
  BRIDGE_CPU_HOURS: '6',
};

// Runs the bridge CLI with fake aws, ssh and gh on PATH.
// Returns its output and every external call it made, in order.
export function runBridge(args, { env = {}, fixtures = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-test-'));
  const log = join(dir, 'calls.jsonl');
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    input: '',
    env: {
      PATH: `${join(here, 'bin')}:${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: dir,
      FAKE_LOG: log,
      FAKE_FIXTURES: JSON.stringify(fixtures),
      ...env,
    },
  });
  const calls = existsSync(log)
    ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [];
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, calls };
}

// The value that follows `flag` in an argument list.
export function flag(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

export function awsCalls(calls, service, op) {
  return calls.filter((c) => c.tool === 'aws' && c.args[0] === service && c.args[1] === op);
}
