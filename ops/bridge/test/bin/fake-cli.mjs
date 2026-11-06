#!/usr/bin/env node
// Stands in for `aws`, `ssh` and `gh` in tests. Appends each call to
// $FAKE_LOG as one JSON line and answers from $FAKE_FIXTURES, a JSON object
// keyed by "<tool> <first two args>" (for example "aws ec2 run-instances").
// A fixture is a string (stdout), { stdout, stderr, exit }, or an array of
// those answered in turn, one per call.
import { appendFileSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

const tool = basename(process.argv[1]);
const args = process.argv.slice(2);
let stdin = '';
try { if (!process.stdin.isTTY) stdin = readFileSync(0, 'utf8'); } catch { /* no stdin */ }
const fixtures = JSON.parse(process.env.FAKE_FIXTURES || '{}');
const positional = args.filter((a) => !a.startsWith('-'));
const exact = [tool, ...positional.slice(0, 2)].join(' ');
const key = exact in fixtures ? exact : tool;
let earlier = 0;
try {
  earlier = readFileSync(process.env.FAKE_LOG, 'utf8').split('\n').filter(Boolean)
    .filter((line) => JSON.parse(line).key === key).length;
} catch { /* first call */ }
appendFileSync(process.env.FAKE_LOG, JSON.stringify({ tool, args, stdin, key }) + '\n');

let found = fixtures[key] ?? '';
if (Array.isArray(found)) found = found[Math.min(earlier, found.length - 1)];
const answer = typeof found === 'string' ? { stdout: found } : found;
if (answer.stdout) process.stdout.write(answer.stdout);
if (answer.stderr) process.stderr.write(answer.stderr);
process.exit(answer.exit ?? 0);
