import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { awsCalls, flag, runBridge } from './helpers.mjs';

const ENV = { AWS_REGION: 'us-east-1' };
const tagsOf = (call) => call.args.slice(call.args.indexOf('--tags') + 1);

test('moved starts the 14-day clock and prints the notice to email', () => {
  const { code, stdout, calls } = runBridge(['moved', 'i-0aaa', '--live-on', '2026-11-12'], {
    env: ENV,
    fixtures: { 'aws ec2 describe-instances': JSON.stringify([{ Id: 'i-0aaa', User: 'alice', Team: 'acme', Name: 'pane-bridge-acme-alice' }]) },
  });
  assert.equal(code, 0);
  const tags = tagsOf(awsCalls(calls, 'ec2', 'create-tags')[0]);
  assert.ok(tags.includes('Key=pane:stage,Value=moving'));
  assert.ok(tags.includes('Key=pane:fleet-live-on,Value=2026-11-12'));
  assert.ok(tags.includes('Key=pane:delete-after,Value=2026-11-26'));
  assert.match(stdout, /November 26, 2026/);
});

const INVENTORY = JSON.stringify([
  { Id: 'i-due', User: 'alice', Team: 'acme', Stage: 'moving', DeleteAfter: '2026-11-01' },
  { Id: 'i-early', User: 'bob', Team: 'acme', Stage: 'moving', DeleteAfter: '2099-01-01' },
  { Id: 'i-active', User: 'carol', Team: 'acme', Stage: 'handed-over' },
]);

test('retire-batch lists only machines past their delete date', () => {
  const dir = mkdtempSync(join(tmpdir(), 'batch-'));
  const out = join(dir, 'batch.json');
  const { code, stdout } = runBridge(['retire-batch', '--out', out], {
    env: ENV, fixtures: { 'aws ec2 describe-instances': INVENTORY },
  });
  assert.equal(code, 0);
  const batch = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual(batch.instances.map((m) => m.id), ['i-due']);
  assert.match(stdout, /Parsa/);
});

function batchFile(ids) {
  const dir = mkdtempSync(join(tmpdir(), 'batch-'));
  const path = join(dir, 'batch.json');
  writeFileSync(path, JSON.stringify({ instances: ids.map((id) => ({ id })) }));
  return path;
}

test('retire needs the name of whoever approved the batch', () => {
  const { code, stderr, calls } = runBridge(['retire', '--batch', batchFile(['i-due'])], {
    env: ENV, fixtures: { 'aws ec2 describe-instances': INVENTORY },
  });
  assert.equal(code, 1);
  assert.match(stderr, /approved-by/);
  assert.equal(awsCalls(calls, 'ec2', 'terminate-instances').length, 0);
});

test('retire deletes a due machine: protection off, alarms gone, terminated', () => {
  const { code, stderr, calls } = runBridge(['retire', '--batch', batchFile(['i-due']), '--approved-by', 'parsa'], {
    env: ENV,
    fixtures: { 'aws ec2 describe-instances': JSON.stringify([{ Id: 'i-due', User: 'alice', Team: 'acme', Stage: 'moving', DeleteAfter: '2026-11-01', Name: 'pane-bridge-acme-alice' }]) },
  });
  assert.equal(code, 0, stderr);
  const unprotect = awsCalls(calls, 'ec2', 'modify-instance-attribute')[0].args;
  assert.ok(unprotect.includes('--no-disable-api-termination'));
  const alarms = awsCalls(calls, 'cloudwatch', 'delete-alarms')[0].args;
  assert.ok(alarms.includes('pane-bridge-acme-alice-egress') && alarms.includes('pane-bridge-acme-alice-cpu'));
  assert.equal(flag(awsCalls(calls, 'ec2', 'terminate-instances')[0].args, '--instance-ids'), 'i-due');
  const tags = tagsOf(awsCalls(calls, 'ec2', 'create-tags')[0]);
  assert.ok(tags.includes('Key=pane:retire-approved-by,Value=parsa'));
});

test('retire refuses the whole batch when any machine is not yet due', () => {
  const { code, stderr, calls } = runBridge(['retire', '--batch', batchFile(['i-due', 'i-early']), '--approved-by', 'parsa'], {
    env: ENV, fixtures: { 'aws ec2 describe-instances': INVENTORY },
  });
  assert.equal(code, 1);
  assert.match(stderr, /i-early/);
  assert.equal(awsCalls(calls, 'ec2', 'terminate-instances').length, 0);
});
