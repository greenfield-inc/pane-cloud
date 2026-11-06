#!/usr/bin/env node
// Operator tooling for the Pane Cloud bridge: one hand-launched EC2 machine per
// user, on today's Pane release, until the fleet is live. See RUNBOOK.md.
//
// The AWS account and region come from the environment (AWS_PROFILE or
// credentials, and AWS_REGION). Every command takes --dry-run, which prints the
// AWS calls it would make and makes none.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// Public limits from the plan (cover sheet, track 5). Abuse thresholds are
// private (D-23) and come from the environment; see abuseLimits().
const LIMITS = {
  instanceType: 'm7g.xlarge',
  diskGb: 50,
  maxMachines: 110,
  maxMonthlyBurnUsd: 15000,
  maxOperatorHoursPerWeek: 10,
};
const AMI_PARAMETER = '/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id';
const GROUPS = { endpoint: 'pane-bridge-eice', setup: 'pane-bridge-setup', closed: 'pane-bridge-closed' };
const TOPIC = 'pane-bridge-alerts';
const OS_USER = 'ubuntu';
const LIVE_STATES = 'pending,running,stopping,stopped';

class BridgeError extends Error {}

// ---------- arguments ----------

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { _: [], user: [] };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--') { opts['--'] = rest.slice(i + 1); break; }
    if (!arg.startsWith('--')) { opts._.push(arg); continue; }
    const name = arg.slice(2);
    if (name === 'dry-run' || name === 'json') { opts[name] = true; continue; }
    const value = rest[++i];
    if (value === undefined) throw new BridgeError(`--${name} needs a value.`);
    if (name === 'user') opts.user.push(value);
    else opts[name] = value;
  }
  return { command, opts };
}

function required(opts, name, hint) {
  if (!opts[name]) throw new BridgeError(`Missing --${name}${hint ? ` (${hint})` : ''}.`);
  return opts[name];
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,38}$/;
function slug(value, what) {
  const lower = String(value).toLowerCase();
  if (!SLUG.test(lower)) throw new BridgeError(`${what} "${value}" must be letters, digits and dashes.`);
  return lower;
}

// ---------- AWS ----------

function quote(arg) {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

function makeAws({ dryRun, region, out }) {
  const tail = ['--region', region, '--output', 'json'];
  const run = (args) => {
    const result = spawnSync('aws', [...args, ...tail], { encoding: 'utf8', input: '' });
    if (result.error) throw new BridgeError(`Could not run the AWS CLI: ${result.error.message}. Install AWS CLI v2.`);
    if (result.status !== 0) throw new BridgeError(`aws ${args.slice(0, 2).join(' ')} failed: ${result.stderr.trim()}`);
    const text = result.stdout.trim();
    return text ? JSON.parse(text) : null;
  };
  return {
    // A lookup. In a dry run it is shown and answered with the placeholder.
    read(args, placeholder) {
      if (dryRun) { out(`# lookup: aws ${args.map(quote).join(' ')}`); return placeholder; }
      return run(args);
    },
    // A change. In a dry run it is shown and not made.
    write(args, placeholder = null) {
      if (dryRun) { out(`aws ${args.map(quote).join(' ')}`); return placeholder; }
      return run(args);
    },
  };
}

function regionFromEnv(env) {
  const region = env.AWS_REGION || env.AWS_DEFAULT_REGION;
  if (!region) throw new BridgeError('Set AWS_REGION (for example AWS_REGION=us-east-1) and AWS_PROFILE for the Pane Cloud account.');
  return region;
}

function checkAccount(aws, env) {
  const account = aws.read(['sts', 'get-caller-identity'], { Account: '<account>' }).Account;
  const expected = env.PANE_CLOUD_ACCOUNT_ID;
  if (expected && account !== '<account>' && account !== expected) {
    throw new BridgeError(`These credentials are for account ${account}, but PANE_CLOUD_ACCOUNT_ID is ${expected}. Check AWS_PROFILE.`);
  }
  return account;
}

function abuseLimits(env) {
  const names = ['BRIDGE_EGRESS_GB_PER_DAY', 'BRIDGE_CPU_PERCENT', 'BRIDGE_CPU_HOURS'];
  const missing = names.filter((n) => !(Number(env[n]) > 0));
  if (missing.length) {
    throw new BridgeError(`Set ${missing.join(', ')} from the bridge's private abuse config (RUNBOOK.md, "Before the first team"). They are kept out of this public repo (D-23).`);
  }
  return { egressGbPerDay: Number(env.BRIDGE_EGRESS_GB_PER_DAY), cpuPercent: Number(env.BRIDGE_CPU_PERCENT), cpuHours: Number(env.BRIDGE_CPU_HOURS) };
}

function bridgeInstanceIds(aws, states = LIVE_STATES) {
  return aws.read([
    'ec2', 'describe-instances',
    '--filters', 'Name=tag:pane:bridge,Values=true', `Name=instance-state-name,Values=${states}`,
    '--query', 'Reservations[].Instances[].InstanceId',
  ], []);
}

function groupId(aws, name) {
  const groups = aws.read([
    'ec2', 'describe-security-groups', '--filters', `Name=group-name,Values=${name}`,
    '--query', 'SecurityGroups[].{GroupName:GroupName,GroupId:GroupId}',
  ], [{ GroupName: name, GroupId: `<${name} id>` }]);
  const found = groups.find((g) => g.GroupName === name);
  if (!found) throw new BridgeError(`Security group ${name} is missing. Run "bridge account-setup" first.`);
  return found.GroupId;
}

function topicArn(aws) {
  return aws.write(['sns', 'create-topic', '--name', TOPIC, '--query', 'TopicArn'], `<${TOPIC} topic arn>`);
}

// ---------- commands ----------

function launch(opts, { env, out }) {
  const team = slug(required(opts, 'team', 'a short team slug'), 'Team');
  const org = required(opts, 'org', "the team's GitHub organization");
  const operator = required(opts, 'operator', 'your name, for the inventory');
  if (!opts.user.length) throw new BridgeError('Name each seat with --user <github login>.');
  const users = opts.user.map((u) => slug(u, 'GitHub login'));
  const region = regionFromEnv(env);
  const limits = abuseLimits(env);
  const aws = makeAws({ dryRun: opts['dry-run'], region, out });

  checkAccount(aws, env);
  const existing = bridgeInstanceIds(aws).length;
  if (existing + users.length > LIMITS.maxMachines) {
    throw new BridgeError(`The bridge has ${existing} machines; ${users.length} more would pass ${LIMITS.maxMachines}. Pause intake and send this team to the waitlist (RUNBOOK.md, "Too much load").`);
  }
  const ami = aws.read(['ssm', 'get-parameter', '--name', AMI_PARAMETER, '--query', 'Parameter.Value'], '<ubuntu 24.04 arm64 ami>');
  const setupGroup = groupId(aws, GROUPS.setup);
  const topic = topicArn(aws);

  const launched = [];
  for (const user of users) {
    const name = `pane-bridge-${team}-${user}`;
    const userData = writeUserData(name, env.PANE_VERSION);
    const tags = {
      Name: name,
      'pane:bridge': 'true',
      'pane:team': team,
      'pane:github-org': org,
      'pane:user': user,
      'pane:operator': operator,
      'pane:stage': 'provisioning',
    };
    const toTags = (type) => ({ ResourceType: type, Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })) });
    const ids = aws.write([
      'ec2', 'run-instances',
      '--image-id', ami,
      '--instance-type', LIMITS.instanceType,
      '--count', '1',
      '--security-group-ids', setupGroup,
      '--metadata-options', JSON.stringify({ HttpTokens: 'required', HttpEndpoint: 'enabled', HttpPutResponseHopLimit: 1 }),
      '--block-device-mappings', JSON.stringify([{ DeviceName: '/dev/sda1', Ebs: { VolumeSize: LIMITS.diskGb, VolumeType: 'gp3', Encrypted: true, DeleteOnTermination: true } }]),
      '--disable-api-termination',
      '--instance-initiated-shutdown-behavior', 'stop',
      '--user-data', `file://${userData}`,
      '--tag-specifications', JSON.stringify([toTags('instance'), toTags('volume')]),
      '--query', 'Instances[].InstanceId',
    ], [`<instance id for ${user}>`]);
    const id = ids[0];
    putAlarms(aws, { id, name, region, topic, limits });
    launched.push({ user, name, id });
  }

  out('');
  for (const m of launched) out(`${m.user}: ${m.id} (${m.name})`);
  out(`Next: wait for "bridge ssh <id> -- cloud-init status --wait", then "bridge login-link <id>" for each user (RUNBOOK.md, step 2).`);
}

function writeUserData(name, paneVersion) {
  const script = readFileSync(join(HERE, 'bootstrap.sh'), 'utf8');
  const header = [
    '#!/bin/bash',
    `export BRIDGE_MACHINE_NAME=${quote(name)}`,
    `export PANE_VERSION=${quote(paneVersion || 'latest')}`,
  ].join('\n');
  const path = join(mkdtempSync(join(tmpdir(), 'pane-bridge-')), `${name}.user-data.sh`);
  writeFileSync(path, `${header}\n${script.replace(/^#!.*\n/, '')}`);
  return path;
}

function putAlarms(aws, { id, name, region, topic, limits }) {
  const common = ['--namespace', 'AWS/EC2', '--dimensions', `Name=InstanceId,Value=${id}`, '--comparison-operator', 'GreaterThanThreshold', '--treat-missing-data', 'notBreaching'];
  aws.write([
    'cloudwatch', 'put-metric-alarm',
    '--alarm-name', `${name}-egress`,
    '--alarm-description', `Bridge machine ${id} sent more than the daily egress limit. Stopped; check it for abuse.`,
    '--metric-name', 'NetworkOut', '--statistic', 'Sum',
    '--period', '86400', '--evaluation-periods', '1',
    '--threshold', String(limits.egressGbPerDay * 1e9),
    ...common,
    '--alarm-actions', topic, `arn:aws:automate:${region}:ec2:stop`,
  ]);
  aws.write([
    'cloudwatch', 'put-metric-alarm',
    '--alarm-name', `${name}-cpu`,
    '--alarm-description', `Bridge machine ${id} has run near full CPU for hours. Check it for mining.`,
    '--metric-name', 'CPUUtilization', '--statistic', 'Average',
    '--period', '3600', '--evaluation-periods', String(limits.cpuHours), '--datapoints-to-alarm', String(limits.cpuHours),
    '--threshold', String(limits.cpuPercent),
    ...common,
    '--alarm-actions', topic,
  ]);
}

// ---------- account ----------

// Cost Explorer and Budgets answer only in us-east-1.
const BILLING_REGION = 'us-east-1';
const MONTHLY_BUDGET = 'pane-bridge-gross-monthly';
// aws-setup.md step 5 makes the same $5K/$10K/$15K budget under this name.
const SETUP_BUDGET = 'pane-cloud-gross-15k';
const CREDITS_BUDGET = 'pane-cloud-credits-used';

function accountSetup(opts, { env, out }) {
  const email = required(opts, 'alert-email', 'where budget, egress and CPU alarms go; the abuse contact');
  const region = regionFromEnv(env);
  const dryRun = Boolean(opts['dry-run']);
  const aws = makeAws({ dryRun, region, out });
  const billing = makeAws({ dryRun, region: BILLING_REGION, out });
  const account = checkAccount(aws, env);

  // Alarms reach the abuse contact through one topic. AWS emails a confirmation link first.
  const topic = topicArn(aws);
  aws.write(['sns', 'subscribe', '--topic-arn', topic, '--protocol', 'email', '--notification-endpoint', email]);
  out(`Alarm email: ${email} must click the confirmation link AWS sends.`);

  if (aws.read(['guardduty', 'list-detectors', '--query', 'DetectorIds'], []).length === 0) {
    aws.write(['guardduty', 'create-detector', '--enable', '--finding-publishing-frequency', 'FIFTEEN_MINUTES']);
  } else out('GuardDuty: already on.');
  // GuardDuty findings of medium severity and up reach the same email.
  aws.write(['sns', 'set-topic-attributes', '--topic-arn', topic, '--attribute-name', 'Policy', '--attribute-value', JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      { Sid: 'owner', Effect: 'Allow', Principal: { AWS: `arn:aws:iam::${account}:root` }, Action: 'sns:Publish', Resource: topic },
      { Sid: 'alarms-and-findings', Effect: 'Allow', Principal: { Service: ['cloudwatch.amazonaws.com', 'events.amazonaws.com'] }, Action: 'sns:Publish', Resource: topic },
    ],
  })]);
  aws.write(['events', 'put-rule', '--name', 'pane-bridge-guardduty', '--event-pattern',
    JSON.stringify({ source: ['aws.guardduty'], 'detail-type': ['GuardDuty Finding'], detail: { severity: [{ numeric: ['>=', 4] }] } })]);
  aws.write(['events', 'put-targets', '--rule', 'pane-bridge-guardduty', '--targets', JSON.stringify([{ Id: 'alerts', Arn: topic }])]);

  // Budgets count gross spend (IncludeCredit false), so credits don't hide the burn.
  const budgets = billing.read(['budgets', 'describe-budgets', '--account-id', account, '--query', 'Budgets[].BudgetName'], []) ?? [];
  const notify = (threshold, type) => ({
    Notification: { NotificationType: 'ACTUAL', ComparisonOperator: 'GREATER_THAN', Threshold: threshold, ThresholdType: type },
    Subscribers: [{ SubscriptionType: 'EMAIL', Address: email }],
  });
  if (!budgets.includes(MONTHLY_BUDGET) && !budgets.includes(SETUP_BUDGET)) {
    billing.write(['budgets', 'create-budget', '--account-id', account,
      '--budget', JSON.stringify({ BudgetName: MONTHLY_BUDGET, BudgetType: 'COST', TimeUnit: 'MONTHLY', BudgetLimit: { Amount: String(LIMITS.maxMonthlyBurnUsd), Unit: 'USD' }, CostTypes: { IncludeCredit: false, IncludeRefund: false } }),
      '--notifications-with-subscribers', JSON.stringify([5000, 10000, 15000].map((usd) => notify(usd, 'ABSOLUTE_VALUE'))),
    ]);
  } else out('Monthly burn budget: already set.');
  if (opts['credits-usd'] && !budgets.includes(CREDITS_BUDGET)) {
    const start = opts['credits-start'] ?? new Date().toISOString().slice(0, 10);
    billing.write(['budgets', 'create-budget', '--account-id', account,
      '--budget', JSON.stringify({ BudgetName: CREDITS_BUDGET, BudgetType: 'COST', TimeUnit: 'ANNUALLY', TimePeriod: { Start: `${start}T00:00:00Z` }, BudgetLimit: { Amount: String(Number(opts['credits-usd'])), Unit: 'USD' }, CostTypes: { IncludeCredit: false, IncludeRefund: false } }),
      '--notifications-with-subscribers', JSON.stringify([50, 75].map((pct) => notify(pct, 'PERCENTAGE'))),
    ]);
  } else if (!opts['credits-usd']) out('Credits budget: skipped; pass --credits-usd <total> once aws-setup.md step 1 gives it.');

  // Network: machines take no traffic from the internet. While an operator sets
  // one up, SSH reaches it only from the EC2 Instance Connect Endpoint; at
  // hand-over it moves to a group with no inbound rules at all.
  const vpc = aws.read(['ec2', 'describe-vpcs', '--filters', 'Name=is-default,Values=true', '--query', 'Vpcs[].VpcId'], ['<default vpc>'])[0];
  if (!vpc) throw new BridgeError(`No default VPC in ${region}. Create one with "aws ec2 create-default-vpc".`);
  const existing = aws.read(['ec2', 'describe-security-groups', '--filters', `Name=vpc-id,Values=${vpc}`, 'Name=group-name,Values=pane-bridge-*',
    '--query', 'SecurityGroups[].{GroupName:GroupName,GroupId:GroupId}'], []);
  const ids = {};
  for (const [role, name] of Object.entries(GROUPS)) {
    const found = existing.find((g) => g.GroupName === name);
    ids[role] = found ? found.GroupId : aws.write(['ec2', 'create-security-group', '--group-name', name, '--vpc-id', vpc,
      '--description', `Pane bridge: ${role}`, '--query', 'GroupId'], `<${name} id>`);
    if (!found && role === 'setup') {
      aws.write(['ec2', 'authorize-security-group-ingress', '--group-id', ids.setup, '--protocol', 'tcp', '--port', '22', '--source-group', ids.endpoint]);
    }
  }
  const endpoints = aws.read(['ec2', 'describe-instance-connect-endpoints', '--filters', `Name=vpc-id,Values=${vpc}`,
    '--query', 'InstanceConnectEndpoints[].InstanceConnectEndpointId'], []);
  if (endpoints.length === 0) {
    const subnet = aws.read(['ec2', 'describe-subnets', '--filters', `Name=vpc-id,Values=${vpc}`, '--query', 'Subnets[].SubnetId'], ['<subnet>'])[0];
    aws.write(['ec2', 'create-instance-connect-endpoint', '--subnet-id', subnet, '--security-group-ids', ids.endpoint]);
  } else out('Instance Connect Endpoint: already there.');

  out(`Account ${account} in ${region} is ready for bridge machines.`);
  return 0;
}

const money = (usd) => `$${Math.floor(usd).toLocaleString('en-US')}`;

function status(opts, { env, out }) {
  const region = regionFromEnv(env);
  const dryRun = Boolean(opts['dry-run']);
  const aws = makeAws({ dryRun, region, out });
  const billing = makeAws({ dryRun, region: BILLING_REGION, out });

  const machines = aws.read([
    'ec2', 'describe-instances',
    '--filters', 'Name=tag:pane:bridge,Values=true', `Name=instance-state-name,Values=${LIVE_STATES}`,
    '--query', "Reservations[].Instances[].{Id:InstanceId,State:State.Name,Team:Tags[?Key=='pane:team']|[0].Value,User:Tags[?Key=='pane:user']|[0].Value,Stage:Tags[?Key=='pane:stage']|[0].Value}",
  ], []);
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const tomorrow = new Date(now.getTime() + 86400000).toISOString().slice(0, 10);
  const burn = Number(billing.read([
    'ce', 'get-cost-and-usage',
    '--time-period', `Start=${monthStart},End=${tomorrow}`,
    '--granularity', 'MONTHLY', '--metrics', 'UnblendedCost',
    '--filter', JSON.stringify({ Not: { Dimensions: { Key: 'RECORD_TYPE', Values: ['Credit', 'Refund'] } } }),
    '--query', 'ResultsByTime[0].Total.UnblendedCost.Amount',
  ], '0'));
  const hours = opts['operator-hours'] === undefined ? undefined : Number(opts['operator-hours']);

  for (const m of machines) out(`${m.Id}  ${m.State.padEnd(8)}  ${m.Stage ?? '-'}  ${m.Team}/${m.User}`);
  out('');
  const reasons = [];
  out(`Machines: ${machines.length} of ${LIMITS.maxMachines}`);
  if (machines.length > LIMITS.maxMachines) reasons.push('too many machines');
  out(`Gross spend this month: ${money(burn)} of ${money(LIMITS.maxMonthlyBurnUsd)}`);
  if (burn > LIMITS.maxMonthlyBurnUsd) reasons.push('monthly burn');
  if (hours === undefined) out(`Operator hours this week: not given (pass --operator-hours; the limit is ${LIMITS.maxOperatorHoursPerWeek})`);
  else {
    out(`Operator hours this week: ${hours} of ${LIMITS.maxOperatorHoursPerWeek}`);
    if (hours > LIMITS.maxOperatorHoursPerWeek) reasons.push('operator hours');
  }
  out(reasons.length ? `Pause intake: yes (${reasons.join(', ')}). Send new teams to the waitlist.` : 'Pause intake: no');
  return 0;
}

// ---------- machine access (EC2 Instance Connect Endpoint) ----------

function instanceArg(opts) {
  const id = opts._[0];
  if (!/^i-[0-9a-z<>]+$/.test(id ?? '')) throw new BridgeError('Name the machine by its instance id (i-...). "bridge status" lists them.');
  return id;
}

// Runs one command on the machine as the setup user, through a key that EC2
// Instance Connect accepts for 60 seconds. Without a command, opens a shell.
function sshRun({ aws, region, id, command, capture = true, dryRun }) {
  const dir = mkdtempSync(join(tmpdir(), 'pane-bridge-ssh-'));
  const key = join(dir, 'key');
  if (!dryRun) {
    const made = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'pane-bridge-operator', '-f', key], { encoding: 'utf8' });
    if (made.status !== 0) throw new BridgeError(`ssh-keygen failed: ${made.stderr}`);
  }
  aws.write(['ec2-instance-connect', 'send-ssh-public-key', '--instance-id', id, '--instance-os-user', OS_USER, '--ssh-public-key', `file://${key}.pub`]);
  const args = [
    '-i', key,
    '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${join(dir, 'known_hosts')}`,
    '-o', 'ConnectTimeout=20',
    '-o', `ProxyCommand=aws ec2-instance-connect open-tunnel --instance-id ${id} --region ${region}`,
    `${OS_USER}@${id}`,
    ...(command ? [command] : []),
  ];
  if (dryRun) return { status: 0, stdout: '', stderr: '', shown: `ssh ${args.map(quote).join(' ')}` };
  const result = spawnSync('ssh', args, capture ? { encoding: 'utf8', input: '' } : { stdio: 'inherit' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function machineContext(opts, env, out) {
  const region = regionFromEnv(env);
  const dryRun = Boolean(opts['dry-run']);
  const aws = makeAws({ dryRun, region, out });
  const id = instanceArg(opts);
  const remote = (command, extra = {}) => {
    const result = sshRun({ aws, region, id, command, dryRun, ...extra });
    if (result.shown) out(result.shown);
    return result;
  };
  return { region, dryRun, aws, id, remote };
}

function ssh(opts, { env, out }) {
  const { remote } = machineContext(opts, env, out);
  const command = opts['--']?.join(' ');
  const result = remote(command, { capture: false });
  return result.status ?? 1;
}

const LOGIN_LINK_SCRIPT = (hostname) => `set -u
state=$(tailscale status --json 2>/dev/null | jq -r '.BackendState // empty')
if [ "$state" = Running ]; then echo "ALREADY_SIGNED_IN"; exit 0; fi
(sudo nohup tailscale up --hostname=${hostname} --operator=${OS_USER} >/tmp/pane-bridge-tailscale-up.log 2>&1 &)
for i in $(seq 1 30); do
  url=$(tailscale status --json 2>/dev/null | jq -r '.AuthURL // empty')
  if [ -n "$url" ]; then echo "$url"; exit 0; fi
  sleep 1
done
echo "No sign-in link after 30 seconds; see /tmp/pane-bridge-tailscale-up.log" >&2
exit 1`;

function loginLink(opts, { env, out }) {
  const hostname = slug(opts.hostname ?? 'pane-bridge', 'Hostname');
  const { remote, dryRun } = machineContext(opts, env, out);
  const result = remote(LOGIN_LINK_SCRIPT(hostname));
  if (dryRun) return 0;
  if (result.status !== 0) throw new BridgeError(`Could not get a sign-in link: ${result.stderr.trim() || result.stdout.trim()}`);
  const text = result.stdout.trim();
  if (text === 'ALREADY_SIGNED_IN') {
    out('This machine is already signed in to a tailnet. Run "bridge check-owner" to see whose.');
    return 0;
  }
  out(text);
  out('Send this link to the user privately. Whoever opens it first owns the machine; then run "bridge check-owner".');
  return 0;
}

// The node's owner, from `tailscale status --json`. Throws unless the node is
// running, untagged, and owned by `login`.
function confirmOwner(statusJson, login) {
  let status;
  try { status = JSON.parse(statusJson); } catch { throw new BridgeError(`Could not read tailscale status: ${statusJson.slice(0, 200)}`); }
  const self = status.Self ?? {};
  if (status.BackendState !== 'Running') throw new BridgeError(`Tailscale is ${status.BackendState ?? 'not running'} on this machine. Send the user a new sign-in link.`);
  const tags = self.Tags ?? [];
  if (tags.length) throw new BridgeError(`The machine is tagged (${tags.join(', ')}), so no user owns it. Run "sudo tailscale logout" on it and send a new link.`);
  const owner = status.User?.[String(self.UserID)]?.LoginName;
  if (!owner) throw new BridgeError('Tailscale status names no owner for this machine.');
  if (owner.toLowerCase() !== login.toLowerCase()) {
    throw new BridgeError(`The machine is owned by ${owner}, not ${login}. Stop: run "sudo tailscale logout" on it, then send ${login} a new link.`);
  }
  return { owner, dnsName: (self.DNSName ?? '').replace(/\.$/, '') };
}

function checkOwnerOn(remote, dryRun, login) {
  const result = remote('tailscale status --json');
  if (dryRun) return { owner: login, dnsName: '<machine>.ts.net' };
  if (result.status !== 0) throw new BridgeError(`Could not reach the machine: ${result.stderr.trim()}`);
  return confirmOwner(result.stdout, login);
}

function checkOwner(opts, { env, out }) {
  const login = required(opts, 'login', "the user's Tailscale login, for example alice@github");
  const { remote, dryRun } = machineContext(opts, env, out);
  const { owner, dnsName } = checkOwnerOn(remote, dryRun, login);
  out(`OK: ${dnsName || 'the machine'} is owned by ${owner}, untagged.`);
  return 0;
}

const PAIRED_CLIENTS = `jq '[.remoteDaemon.host.clients[]? | select(.kind != "glasses")] | length' ~/.pane_remote/config.json 2>/dev/null || echo 0`;

function handOver(opts, { env, out }) {
  const login = required(opts, 'login', "the user's Tailscale login");
  const { aws, remote, dryRun, id } = machineContext(opts, env, out);
  const closed = groupId(aws, GROUPS.closed);

  const { owner } = checkOwnerOn(remote, dryRun, login);
  const clients = remote(PAIRED_CLIENTS);
  if (!dryRun && Number(clients.stdout.trim()) !== 0) {
    throw new BridgeError(`The machine holds ${clients.stdout.trim()} connection code(s) the user did not make. Ask the user to create their own and clear these first (RUNBOOK.md, step 3).`);
  }

  aws.write(['ec2', 'modify-instance-attribute', '--instance-id', id, '--groups', closed]);
  aws.write(['ec2', 'create-tags', '--resources', id, '--tags', 'Key=pane:stage,Value=handed-over', `Key=pane:handed-over-at,Value=${new Date().toISOString()}`]);

  const attempt = remote('true');
  if (dryRun) { out('Dry run: nothing changed.'); return 0; }
  if (attempt.status === 0) {
    throw new BridgeError(`The operator can still connect to ${id} after hand-over. Check that ${GROUPS.closed} has no inbound rules and that the instance has no other security group.`);
  }
  out(`Handed over to ${owner}. An operator connection attempt was refused (${attempt.stderr.trim() || 'no answer'}).`);
  return 0;
}

// ---------- moving to the fleet (R3) ----------

const RETIRE_AFTER_DAYS = 14;
const tag = (key) => `Tags[?Key=='${key}']|[0].Value`;

function inventory(aws, ids) {
  return aws.read([
    'ec2', 'describe-instances',
    ...(ids ? ['--instance-ids', ...ids] : ['--filters', 'Name=tag:pane:bridge,Values=true', `Name=instance-state-name,Values=${LIVE_STATES}`]),
    '--query', `Reservations[].Instances[].{Id:InstanceId,Name:${tag('Name')},Team:${tag('pane:team')},User:${tag('pane:user')},Stage:${tag('pane:stage')},DeleteAfter:${tag('pane:delete-after')}}`,
  ], (ids ?? []).map((Id) => ({ Id, Name: `<name of ${Id}>`, User: '<user>', Stage: 'moving', DeleteAfter: '2000-01-01' })));
}

const isoDay = (date) => date.toISOString().slice(0, 10);
const longDay = (day) => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' });

// Marks that a user's Pane Cloud machine is live. Their bridge machine is
// deleted 14 days later; the printed notice is the email that starts that clock.
function moved(opts, { env, out }) {
  const id = instanceArg(opts);
  const liveOn = required(opts, 'live-on', "the day the user's Pane Cloud machine went live, yyyy-mm-dd");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(liveOn) || Number.isNaN(Date.parse(liveOn))) throw new BridgeError('--live-on must be a date like 2026-11-12.');
  const aws = makeAws({ dryRun: Boolean(opts['dry-run']), region: regionFromEnv(env), out });
  const [machine] = inventory(aws, [id]);
  if (!machine) throw new BridgeError(`No bridge machine ${id}.`);
  const deleteAfter = isoDay(new Date(Date.parse(`${liveOn}T00:00:00Z`) + RETIRE_AFTER_DAYS * 86400000));
  aws.write(['ec2', 'create-tags', '--resources', id, '--tags', 'Key=pane:stage,Value=moving',
    `Key=pane:fleet-live-on,Value=${liveOn}`, `Key=pane:delete-after,Value=${deleteAfter}`]);
  out(`Email ${machine.User} today (MIGRATION.md has the full text):`);
  out('');
  out(`  Your Pane Cloud machine is live. Your bridge machine (${machine.Name}) will be deleted on ${longDay(deleteAfter)}.`);
  out('  Before then, hand off your tasks to the Pane Cloud machine with runpane handoff, and push every branch you want to keep.');
  out('  Anything left only on the bridge machine is deleted with it.');
  return 0;
}

// Writes the machines past their delete date to a batch file for Parsa to approve.
function retireBatch(opts, { env, out }) {
  const path = required(opts, 'out', 'where to write the batch file');
  const aws = makeAws({ dryRun: Boolean(opts['dry-run']), region: regionFromEnv(env), out });
  const today = isoDay(new Date());
  const due = inventory(aws).filter((m) => m.Stage === 'moving' && m.DeleteAfter && m.DeleteAfter <= today);
  writeFileSync(path, `${JSON.stringify({ created: new Date().toISOString(), instances: due.map((m) => ({ id: m.Id, team: m.Team, user: m.User, deleteAfter: m.DeleteAfter })) }, null, 2)}\n`);
  for (const m of due) out(`${m.Id}  ${m.Team}/${m.User}  due ${m.DeleteAfter}`);
  out(`${due.length} machine(s) in ${path}. Send it to Parsa; after his written OK run: bridge retire --batch ${path} --approved-by parsa`);
  return 0;
}

// Deletes an approved batch. Every machine must still be due, or nothing is deleted.
function retire(opts, { env, out }) {
  const path = required(opts, 'batch', 'the file retire-batch wrote');
  const approver = required(opts, 'approved-by', 'who approved this batch in writing; deletion waits on Parsa per batch');
  const ids = JSON.parse(readFileSync(path, 'utf8')).instances.map((m) => m.id);
  if (!ids.length) { out('The batch is empty.'); return 0; }
  const region = regionFromEnv(env);
  const aws = makeAws({ dryRun: Boolean(opts['dry-run']), region, out });
  const today = isoDay(new Date());
  const machines = inventory(aws, ids);
  const notDue = ids.filter((id) => {
    const m = machines.find((x) => x.Id === id);
    return !m || m.Stage !== 'moving' || !m.DeleteAfter || m.DeleteAfter > today;
  });
  if (notDue.length) throw new BridgeError(`Not due for deletion: ${notDue.join(', ')}. Make a new batch with retire-batch.`);

  for (const m of machines) {
    aws.write(['ec2', 'create-tags', '--resources', m.Id, '--tags', `Key=pane:retire-approved-by,Value=${approver}`, `Key=pane:retired-on,Value=${today}`]);
    aws.write(['ec2', 'modify-instance-attribute', '--instance-id', m.Id, '--no-disable-api-termination']);
    aws.write(['cloudwatch', 'delete-alarms', '--alarm-names', `${m.Name}-egress`, `${m.Name}-cpu`]);
    aws.write(['ec2', 'terminate-instances', '--instance-ids', m.Id]);
    out(`Deleted ${m.Id} (${m.Team}/${m.User}) and its disk.`);
  }
  return 0;
}

// ---------- intake ----------

const MIN_ACCOUNT_AGE_DAYS = 90;

function ghApi(path) {
  const result = spawnSync('gh', ['api', path], { encoding: 'utf8', input: '' });
  if (result.error) throw new BridgeError(`Could not run the GitHub CLI: ${result.error.message}.`);
  if (result.status !== 0) return null;
  return JSON.parse(result.stdout);
}

// Checks a team against the intake rule: a real GitHub organization, and a
// GitHub account older than 90 days for every seat.
function vet(opts, { out }) {
  const org = required(opts, 'org', "the team's GitHub organization");
  if (!opts.user.length) throw new BridgeError('Name each seat with --user <github login>.');
  const ageDays = (iso) => Math.floor((Date.now() - Date.parse(iso)) / 86400000);
  const problems = [];

  const orgInfo = ghApi(`orgs/${encodeURIComponent(org)}`);
  if (!orgInfo) problems.push(`${org}: organization not found on GitHub`);
  else out(`${org}: organization, ${ageDays(orgInfo.created_at)} days old, ${orgInfo.public_repos} public repos`);

  for (const login of opts.user) {
    const user = ghApi(`users/${encodeURIComponent(login)}`);
    if (!user) { problems.push(`${login}: GitHub account not found`); continue; }
    const age = ageDays(user.created_at);
    if (age < MIN_ACCOUNT_AGE_DAYS) problems.push(`${login}: account is ${age} days old (needs ${MIN_ACCOUNT_AGE_DAYS})`);
    else out(`${login}: ${age} days old`);
  }
  for (const p of problems) out(`FAIL ${p}`);
  out(problems.length ? 'Vetting: fail' : 'Vetting: pass');
  return problems.length ? 1 : 0;
}

// ---------- main ----------

const COMMANDS = { vet, 'account-setup': accountSetup, status, launch, ssh, 'login-link': loginLink, 'check-owner': checkOwner, 'hand-over': handOver, moved, 'retire-batch': retireBatch, retire };

const USAGE = `Usage: bridge <command> [options] [--dry-run]

Commands (in runbook order):
  vet --org <github org> --user <login> [--user ...]       Check a team at intake
  account-setup --alert-email <addr> [--credits-usd <n> --credits-start <yyyy-mm-dd>]
                                                         Once per account: alarms, GuardDuty, budgets, network
  status [--operator-hours <n>]                          Machines, monthly burn, and whether to pause intake
  launch --team <slug> --org <github org> --user <login> [--user ...] --operator <name>
                                                         One m7g.xlarge per user
  ssh <instance> [-- <command>]                          Shell on a machine before hand-over
  login-link <instance> [--hostname <name>]              Tailscale sign-in link for the user
  check-owner <instance> --login <tailscale login>       Confirm the user owns the node, untagged
  hand-over <instance> --login <tailscale login>         Remove operator access and prove it
  moved <instance> --live-on <yyyy-mm-dd>                The user's Pane Cloud machine is live; start the 14 days
  retire-batch --out <file>                              Machines past their delete date, for Parsa's approval
  retire --batch <file> --approved-by <name>             Delete an approved batch

Environment: AWS_PROFILE, AWS_REGION; PANE_CLOUD_ACCOUNT_ID (optional check);
PANE_VERSION (default latest); BRIDGE_EGRESS_GB_PER_DAY, BRIDGE_CPU_PERCENT and
BRIDGE_CPU_HOURS from the private abuse config. See RUNBOOK.md.`;

export function main(argv, { env = process.env, out = (s) => console.log(s) } = {}) {
  const { command, opts } = parseArgs(argv);
  const run = COMMANDS[command];
  if (!run) { out(USAGE); return command && command !== '--help' && command !== 'help' ? 1 : 0; }
  return run(opts, { env, out }) ?? 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof BridgeError)) throw error;
    console.error(`bridge: ${error.message}`);
    process.exitCode = 1;
  }
}
