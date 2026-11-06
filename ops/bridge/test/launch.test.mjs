import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ABUSE_ENV, awsCalls, flag, runBridge } from './helpers.mjs';

const ENV = { AWS_REGION: 'us-east-1', ...ABUSE_ENV };
const LAUNCH = ['launch', '--team', 'acme', '--org', 'acme-inc', '--user', 'alice', '--user', 'bob', '--operator', 'op1'];

const LIVE_FIXTURES = {
  'aws sts get-caller-identity': JSON.stringify({ Account: '111122223333' }),
  'aws ec2 describe-instances': JSON.stringify([]),
  'aws ssm get-parameter': JSON.stringify('ami-0ubuntu2404arm'),
  'aws ec2 describe-security-groups': JSON.stringify([{ GroupName: 'pane-bridge-setup', GroupId: 'sg-setup' }]),
  'aws sns create-topic': JSON.stringify('arn:aws:sns:us-east-1:111122223333:pane-bridge-alerts'),
  'aws ec2 run-instances': JSON.stringify(['i-0aaa']),
};

test('launch needs a region from the environment', () => {
  const { code, stderr, calls } = runBridge(LAUNCH, { env: ABUSE_ENV });
  assert.equal(code, 1);
  assert.match(stderr, /AWS_REGION/);
  assert.equal(calls.length, 0);
});

test('launch refuses without the private abuse thresholds', () => {
  const { code, stderr } = runBridge(LAUNCH, { env: { AWS_REGION: 'us-east-1' } });
  assert.equal(code, 1);
  assert.match(stderr, /BRIDGE_EGRESS_GB_PER_DAY/);
});

test('a dry run prints one machine per user and calls nothing', () => {
  const { code, stdout, calls } = runBridge([...LAUNCH, '--dry-run'], { env: ENV });
  assert.equal(code, 0, stdout);
  assert.equal(calls.length, 0);
  assert.equal(stdout.match(/aws ec2 run-instances/g).length, 2);
  assert.match(stdout, /m7g\.xlarge/);
  assert.match(stdout, /pane-bridge-acme-alice/);
  assert.match(stdout, /pane-bridge-acme-bob/);
});

test('launch starts one tagged, locked-down m7g.xlarge per user with stop-on-egress alarms', () => {
  const { code, stdout, stderr, calls } = runBridge(LAUNCH, { env: ENV, fixtures: LIVE_FIXTURES });
  assert.equal(code, 0, stderr);

  const runs = awsCalls(calls, 'ec2', 'run-instances');
  assert.equal(runs.length, 2);
  const alice = runs[0].args;
  assert.equal(flag(alice, '--instance-type'), 'm7g.xlarge');
  assert.equal(flag(alice, '--image-id'), 'ami-0ubuntu2404arm');
  assert.deepEqual(flag(alice, '--security-group-ids'), 'sg-setup');
  assert.ok(alice.includes('--disable-api-termination'));
  assert.deepEqual(JSON.parse(flag(alice, '--metadata-options')), { HttpTokens: 'required', HttpEndpoint: 'enabled', HttpPutResponseHopLimit: 1 });
  const disk = JSON.parse(flag(alice, '--block-device-mappings'))[0].Ebs;
  assert.equal(disk.VolumeSize, 50);
  assert.equal(disk.Encrypted, true);

  const tags = Object.fromEntries(JSON.parse(flag(alice, '--tag-specifications'))[0].Tags.map((t) => [t.Key, t.Value]));
  assert.deepEqual(tags, {
    Name: 'pane-bridge-acme-alice',
    'pane:bridge': 'true',
    'pane:team': 'acme',
    'pane:github-org': 'acme-inc',
    'pane:user': 'alice',
    'pane:operator': 'op1',
    'pane:stage': 'provisioning',
  });

  const alarms = awsCalls(calls, 'cloudwatch', 'put-metric-alarm').map((c) => c.args);
  const egress = alarms.find((a) => flag(a, '--metric-name') === 'NetworkOut' && flag(a, '--dimensions').includes('i-0aaa'));
  assert.equal(flag(egress, '--threshold'), String(10 * 1e9));
  assert.equal(flag(egress, '--period'), '86400');
  assert.ok(egress.includes('arn:aws:automate:us-east-1:ec2:stop'));
  const cpu = alarms.find((a) => flag(a, '--metric-name') === 'CPUUtilization' && flag(a, '--dimensions').includes('i-0aaa'));
  assert.equal(flag(cpu, '--threshold'), '90');
  assert.equal(flag(cpu, '--evaluation-periods'), '6');
  assert.ok(!cpu.some((a) => a.includes(':ec2:stop')), 'the CPU alarm only notifies');
  assert.match(stdout, /i-0aaa/);
});

test('launch refuses when the account is not the one named in PANE_CLOUD_ACCOUNT_ID', () => {
  const { code, stderr, calls } = runBridge(LAUNCH, {
    env: { ...ENV, PANE_CLOUD_ACCOUNT_ID: '999999999999' },
    fixtures: LIVE_FIXTURES,
  });
  assert.equal(code, 1);
  assert.match(stderr, /111122223333/);
  assert.equal(awsCalls(calls, 'ec2', 'run-instances').length, 0);
});

test('launch refuses when the team would take the bridge past 110 machines', () => {
  const existing = Array.from({ length: 109 }, (_, i) => `i-${i}`);
  const { code, stderr, calls } = runBridge(LAUNCH, {
    env: ENV,
    fixtures: { ...LIVE_FIXTURES, 'aws ec2 describe-instances': JSON.stringify(existing) },
  });
  assert.equal(code, 1);
  assert.match(stderr, /pause intake/i);
  assert.equal(awsCalls(calls, 'ec2', 'run-instances').length, 0);
});
