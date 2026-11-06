import { test } from 'node:test';
import assert from 'node:assert/strict';
import { awsCalls, flag, runBridge } from './helpers.mjs';

const ENV = { AWS_REGION: 'us-east-1' };

const EMPTY_ACCOUNT = {
  'aws sts get-caller-identity': JSON.stringify({ Account: '111122223333' }),
  'aws sns create-topic': JSON.stringify('arn:aws:sns:us-east-1:111122223333:pane-bridge-alerts'),
  'aws guardduty list-detectors': JSON.stringify([]),
  'aws budgets describe-budgets': JSON.stringify([]),
  'aws ec2 describe-vpcs': JSON.stringify(['vpc-default']),
  'aws ec2 describe-subnets': JSON.stringify(['subnet-a']),
  'aws ec2 describe-security-groups': JSON.stringify([]),
  'aws ec2 create-security-group': [JSON.stringify('sg-eice'), JSON.stringify('sg-setup'), JSON.stringify('sg-closed')],
  'aws ec2 describe-instance-connect-endpoints': JSON.stringify([]),
};

test('account-setup on a fresh account turns on every alarm and the closed network', () => {
  const { code, stderr, calls } = runBridge(['account-setup', '--alert-email', 'alerts@example.com', '--credits-usd', '100000'], {
    env: ENV, fixtures: EMPTY_ACCOUNT,
  });
  assert.equal(code, 0, stderr);

  const sub = awsCalls(calls, 'sns', 'subscribe')[0].args;
  assert.equal(flag(sub, '--notification-endpoint'), 'alerts@example.com');
  assert.equal(awsCalls(calls, 'guardduty', 'create-detector').length, 1);
  const findings = awsCalls(calls, 'events', 'put-targets')[0].args;
  assert.equal(JSON.parse(flag(findings, '--targets'))[0].Arn, 'arn:aws:sns:us-east-1:111122223333:pane-bridge-alerts');

  const budgets = awsCalls(calls, 'budgets', 'create-budget').map((c) => ({
    budget: JSON.parse(flag(c.args, '--budget')),
    notes: JSON.parse(flag(c.args, '--notifications-with-subscribers')),
  }));
  const monthly = budgets.find((b) => b.budget.TimeUnit === 'MONTHLY');
  assert.equal(monthly.budget.BudgetLimit.Amount, '15000');
  assert.equal(monthly.budget.CostTypes.IncludeCredit, false, 'gross spend, so credits do not hide the burn');
  assert.deepEqual(monthly.notes.map((n) => [n.Notification.Threshold, n.Notification.ThresholdType]), [
    [5000, 'ABSOLUTE_VALUE'], [10000, 'ABSOLUTE_VALUE'], [15000, 'ABSOLUTE_VALUE'],
  ]);
  const credits = budgets.find((b) => b.budget.TimeUnit === 'ANNUALLY');
  assert.equal(credits.budget.BudgetLimit.Amount, '100000');
  assert.deepEqual(credits.notes.map((n) => n.Notification.Threshold), [50, 75]);

  const groups = awsCalls(calls, 'ec2', 'create-security-group').map((c) => flag(c.args, '--group-name'));
  assert.deepEqual(groups, ['pane-bridge-eice', 'pane-bridge-setup', 'pane-bridge-closed']);
  const ingress = awsCalls(calls, 'ec2', 'authorize-security-group-ingress').map((c) => c.args);
  assert.equal(ingress.length, 1, 'only the setup group takes inbound traffic');
  assert.equal(flag(ingress[0], '--group-id'), 'sg-setup');
  assert.equal(flag(ingress[0], '--source-group'), 'sg-eice');
  assert.equal(flag(ingress[0], '--port'), '22');

  const endpoint = awsCalls(calls, 'ec2', 'create-instance-connect-endpoint')[0].args;
  assert.equal(flag(endpoint, '--subnet-id'), 'subnet-a');
  assert.equal(flag(endpoint, '--security-group-ids'), 'sg-eice');
});

test('account-setup run again changes nothing that already exists', () => {
  const { code, stderr, calls } = runBridge(['account-setup', '--alert-email', 'alerts@example.com'], {
    env: ENV,
    fixtures: {
      ...EMPTY_ACCOUNT,
      'aws guardduty list-detectors': JSON.stringify(['det-1']),
      'aws budgets describe-budgets': JSON.stringify(['pane-bridge-gross-monthly']),
      'aws ec2 describe-security-groups': JSON.stringify([
        { GroupName: 'pane-bridge-eice', GroupId: 'sg-eice' },
        { GroupName: 'pane-bridge-setup', GroupId: 'sg-setup' },
        { GroupName: 'pane-bridge-closed', GroupId: 'sg-closed' },
      ]),
      'aws ec2 describe-instance-connect-endpoints': JSON.stringify(['eice-1']),
    },
  });
  assert.equal(code, 0, stderr);
  for (const [service, op] of [
    ['guardduty', 'create-detector'], ['budgets', 'create-budget'], ['ec2', 'create-security-group'],
    ['ec2', 'authorize-security-group-ingress'], ['ec2', 'create-instance-connect-endpoint'],
  ]) assert.equal(awsCalls(calls, service, op).length, 0, `${service} ${op}`);
});

test('status says to pause intake when the month burns past $15K', () => {
  const { code, stdout } = runBridge(['status', '--operator-hours', '4'], {
    env: ENV,
    fixtures: {
      'aws ec2 describe-instances': JSON.stringify([
        { Id: 'i-1', State: 'running', Team: 'acme', User: 'alice', Stage: 'handed-over' },
      ]),
      'aws ce get-cost-and-usage': JSON.stringify('15210.55'),
    },
  });
  assert.equal(code, 0);
  assert.match(stdout, /i-1/);
  assert.match(stdout, /\$15,210/);
  assert.match(stdout, /Pause intake: yes/);
});

test('status keeps intake open under every limit', () => {
  const { stdout } = runBridge(['status', '--operator-hours', '4'], {
    env: ENV,
    fixtures: {
      'aws ec2 describe-instances': JSON.stringify([]),
      'aws ce get-cost-and-usage': JSON.stringify('812.00'),
    },
  });
  assert.match(stdout, /Pause intake: no/);
});

test('status says to pause intake past 10 operator-hours a week', () => {
  const { stdout } = runBridge(['status', '--operator-hours', '11'], {
    env: ENV,
    fixtures: { 'aws ec2 describe-instances': JSON.stringify([]), 'aws ce get-cost-and-usage': JSON.stringify('10') },
  });
  assert.match(stdout, /Pause intake: yes/);
  assert.match(stdout, /operator/i);
});
