import { test } from 'node:test';
import assert from 'node:assert/strict';
import { awsCalls, flag, runBridge } from './helpers.mjs';

const ENV = { AWS_REGION: 'us-east-1' };

// Trimmed from a real `tailscale status --json` on a node a user owns.
const OWNED_BY_ALICE = JSON.stringify({
  BackendState: 'Running',
  Self: { HostName: 'pane-bridge', DNSName: 'pane-bridge.tail1234.ts.net.', UserID: 6281, Online: true },
  User: { 6281: { ID: 6281, LoginName: 'alice@github', DisplayName: 'Alice' } },
});
const TAGGED = JSON.stringify({
  BackendState: 'Running',
  Self: { HostName: 'pane-bridge', UserID: 6281, Tags: ['tag:server'] },
  User: { 6281: { ID: 6281, LoginName: 'tagged-devices' } },
});

const sshTo = (calls) => calls.filter((c) => c.tool === 'ssh');

test('ssh pushes a one-minute key through EC2 Instance Connect and tunnels through the endpoint', () => {
  const { code, calls } = runBridge(['ssh', 'i-0aaa', '--', 'cloud-init status --wait'], { env: ENV });
  assert.equal(code, 0);
  const push = awsCalls(calls, 'ec2-instance-connect', 'send-ssh-public-key')[0].args;
  assert.equal(flag(push, '--instance-id'), 'i-0aaa');
  assert.equal(flag(push, '--instance-os-user'), 'ubuntu');
  const ssh = sshTo(calls)[0].args;
  assert.ok(ssh.some((a) => a.includes('ec2-instance-connect open-tunnel --instance-id i-0aaa')));
  assert.equal(ssh.at(-1), 'cloud-init status --wait');
});

test('login-link prints the Tailscale sign-in link the user must open', () => {
  const { code, stdout } = runBridge(['login-link', 'i-0aaa'], {
    env: ENV,
    fixtures: { ssh: 'https://login.tailscale.com/a/1f2e3d4c\n' },
  });
  assert.equal(code, 0);
  assert.match(stdout, /https:\/\/login\.tailscale\.com\/a\/1f2e3d4c/);
});

test('check-owner passes when the intended user owns the untagged node', () => {
  const { code, stdout } = runBridge(['check-owner', 'i-0aaa', '--login', 'alice@github'], {
    env: ENV, fixtures: { ssh: OWNED_BY_ALICE },
  });
  assert.equal(code, 0, stdout);
  assert.match(stdout, /alice@github/);
});

test('check-owner fails when someone else opened the link', () => {
  const { code, stderr } = runBridge(['check-owner', 'i-0aaa', '--login', 'bob@github'], {
    env: ENV, fixtures: { ssh: OWNED_BY_ALICE },
  });
  assert.equal(code, 1);
  assert.match(stderr, /alice@github/);
});

test('check-owner fails on a tagged node', () => {
  const { code, stderr } = runBridge(['check-owner', 'i-0aaa', '--login', 'alice@github'], {
    env: ENV, fixtures: { ssh: TAGGED },
  });
  assert.equal(code, 1);
  assert.match(stderr, /tag:server/);
});

const GROUPS = JSON.stringify([{ GroupName: 'pane-bridge-closed', GroupId: 'sg-closed' }]);

test('hand-over closes the machine to the operator and proves it', () => {
  const { code, stdout, stderr, calls } = runBridge(['hand-over', 'i-0aaa', '--login', 'alice@github'], {
    env: ENV,
    fixtures: {
      'aws ec2 describe-security-groups': GROUPS,
      ssh: [OWNED_BY_ALICE, '0\n', { exit: 255, stderr: 'Connection timed out during banner exchange' }],
    },
  });
  assert.equal(code, 0, stderr);
  const swap = awsCalls(calls, 'ec2', 'modify-instance-attribute')[0].args;
  assert.equal(flag(swap, '--instance-id'), 'i-0aaa');
  assert.equal(flag(swap, '--groups'), 'sg-closed');
  const tag = awsCalls(calls, 'ec2', 'create-tags')[0].args;
  assert.ok(tag.includes('Key=pane:stage,Value=handed-over'));
  assert.equal(sshTo(calls).length, 3, 'owner check, code check, then the refused attempt');
  assert.match(stdout, /refused/i);
});

test('hand-over stops before closing anything when the owner is wrong', () => {
  const { code, calls } = runBridge(['hand-over', 'i-0aaa', '--login', 'bob@github'], {
    env: ENV, fixtures: { 'aws ec2 describe-security-groups': GROUPS, ssh: OWNED_BY_ALICE },
  });
  assert.equal(code, 1);
  assert.equal(awsCalls(calls, 'ec2', 'modify-instance-attribute').length, 0);
});

test('hand-over stops when the machine holds a connection code', () => {
  const { code, stderr, calls } = runBridge(['hand-over', 'i-0aaa', '--login', 'alice@github'], {
    env: ENV, fixtures: { 'aws ec2 describe-security-groups': GROUPS, ssh: [OWNED_BY_ALICE, '1\n'] },
  });
  assert.equal(code, 1);
  assert.match(stderr, /connection code/i);
  assert.equal(awsCalls(calls, 'ec2', 'modify-instance-attribute').length, 0);
});

test('hand-over fails loudly when the operator can still connect afterwards', () => {
  const { code, stderr } = runBridge(['hand-over', 'i-0aaa', '--login', 'alice@github'], {
    env: ENV, fixtures: { 'aws ec2 describe-security-groups': GROUPS, ssh: [OWNED_BY_ALICE, '0\n', 'still here\n'] },
  });
  assert.equal(code, 1);
  assert.match(stderr, /still connect/i);
});
