import { randomUUID } from 'node:crypto';
import type { Machine, ServiceClient } from 'pane-cloud-contract';
import { expectError, waitFor } from 'pane-cloud-contract/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './support/harness';
import { startSwitchableProxy } from './support/switchableProxy';

const machineIn = (client: ServiceClient, id: string, done: (m: Machine) => boolean, what: string) =>
  waitFor(() => client.getMachine(id), done, what, 5000);

let nextGithubId = 9000;
const person = (login: string) => ({ id: (nextGithubId += 1), login, name: login, email: `${login}@example.com` });

describe('Pane Cloud service', () => {
  let harness: Harness;
  let proxy: Awaited<ReturnType<typeof startSwitchableProxy>>;
  beforeAll(async () => {
    let fleetUrl = '';
    proxy = await startSwitchableProxy(() => fleetUrl);
    harness = await startHarness({ fleetUrl: proxy.url });
    fleetUrl = harness.fleet.url;
  });
  afterAll(async () => {
    await harness.close();
    await proxy.close();
  });

  const invitedOwner = async (login: string) => {
    await harness.cohort(login);
    return harness.client(await harness.signIn(person(login)));
  };

  it('signs a cohort member in with a new team, and lets in logins regardless of case', async () => {
    await harness.cohort('Mixed-Case');
    const client = harness.client(await harness.signIn(person('mixed-case')));
    const account = await client.getAccount();
    expect(account.access).toBe('invited');
    expect(account.role).toBe('owner');
    expect((await client.getTeam()).name).toBe("mixed-case's team");
    const billing = await client.getBilling();
    expect(billing).toMatchObject({ plan: 'cohort', seatPriceCents: 4900, foundingPriceLocked: true, status: 'free', seats: 1 });
  });

  it('gives a new machine the latest published release, and shows the owner its tailnet login link until it joins', async () => {
    const owner = await invitedOwner('journey-two');
    const { machine } = await owner.createMachine('my machine', randomUUID());
    expect(machine.state).toBe('creating');
    const running = await machineIn(owner, machine.id, (m) => m.state === 'running' && m.tailnet.loginUrl !== null, 'running with a login link');
    expect(running.paneVersion).toBe('2.4.215');
    expect(running.tailnet).toEqual({ status: 'awaiting_login', loginUrl: `https://login.tailscale.com/a/stub-${machine.id}`, hostname: null });
    const { entries } = await owner.listActionLog(machine.id);
    const bootstrap = entries.find((e) => e.operation === 'bootstrap');
    expect(bootstrap).toMatchObject({
      status: 'succeeded',
      actor: { kind: 'service', accountId: null, githubLogin: null },
      parameters: { release: { version: '2.4.215', arch: 'arm64', debSha256: '2'.repeat(64) } },
    });
    harness.fleet.joinTailnet(machine.id);
    const joined = await owner.getMachine(machine.id);
    expect(joined.tailnet).toEqual({ status: 'joined', loginUrl: null, hostname: `pane-${machine.id}.tailnet.ts.net` });
    harness.fleet.setCpuSecondsUsed(machine.id, 43_200);
    expect((await owner.getMachine(machine.id)).usage).toMatchObject({ cpuSecondsUsed: 43_200, throttled: true });
  });

  it('updates Pane to a named published release, with its checksum in the log', async () => {
    const owner = await invitedOwner('updater');
    const { machine } = await owner.createMachine('m', randomUUID());
    await machineIn(owner, machine.id, (m) => m.state === 'running', 'running');
    const entry = await owner.requestOperation(machine.id, { operation: 'update_pane', parameters: { version: '2.4.214' } });
    expect(entry.parameters).toEqual({ release: { version: '2.4.214', arch: 'arm64', debSha256: '1'.repeat(64) } });
    await machineIn(owner, machine.id, (m) => m.paneVersion === '2.4.214', 'Pane 2.4.214');
  });

  it('logs a stop the fleet makes on its own as the host’s, with the reason, and starts again on request', async () => {
    const owner = await invitedOwner('idle-stop');
    const { machine } = await owner.createMachine('m', randomUUID());
    await machineIn(owner, machine.id, (m) => m.state === 'running', 'running');
    harness.fleet.hostStop(machine.id, 'idle');
    await harness.app.kickWorker();
    const stopped = await owner.getMachine(machine.id);
    expect(stopped).toMatchObject({ state: 'stopped', stateReason: 'idle' });
    const [latest] = (await owner.listActionLog(machine.id)).entries;
    expect(latest).toMatchObject({ operation: 'stop', actor: { kind: 'host' }, reason: 'No agent ran and no one was connected for 30 minutes.', status: 'succeeded' });
    await owner.startMachine(machine.id);
    await machineIn(owner, machine.id, (m) => m.state === 'running', 'running again');
    const operations = (await owner.listActionLog(machine.id)).entries.map((e) => `${e.operation}:${e.actor.kind}`);
    expect(operations).toEqual(['start:user', 'stop:host', 'bootstrap:service', 'create:user']);
  });

  it('answers retries of one create sent at the same time with the same machine', async () => {
    const owner = await invitedOwner('racing-retries');
    const key = randomUUID();
    const answers = await Promise.all(Array.from({ length: 6 }, () => owner.createMachine('m', key)));
    expect(new Set(answers.map((a) => a.machine.id)).size).toBe(1);
    expect(new Set(answers.map((a) => a.operation.id)).size).toBe(1);
  });

  it('pages the action log newest first', async () => {
    const owner = await invitedOwner('pager');
    const { machine } = await owner.createMachine('m', randomUUID());
    await machineIn(owner, machine.id, (m) => m.state === 'running', 'running');
    for (let i = 0; i < 3; i += 1) await owner.requestOperation(machine.id, { operation: 'collect_diagnostics', parameters: {} });
    const first = await owner.listActionLog(machine.id, { limit: 2 });
    expect(first.entries.map((e) => e.operation)).toEqual(['collect_diagnostics', 'collect_diagnostics']);
    expect(first.nextCursor).not.toBeNull();
    const second = await owner.listActionLog(machine.id, { limit: 2, before: first.nextCursor ?? undefined });
    expect(second.entries.map((e) => e.operation)).toEqual(['collect_diagnostics', 'bootstrap']);
    const third = await owner.listActionLog(machine.id, { limit: 2, before: second.nextCursor ?? undefined });
    expect(third.entries.map((e) => e.operation)).toEqual(['create']);
    expect(third.nextCursor).toBeNull();
    await expectError('invalid_request', () => owner.listActionLog(machine.id, { before: 'not-a-cursor' }));
  });

  it('lets an invited teammate create a machine on their own seat', async () => {
    const owner = await invitedOwner('team-lead');
    const mate = harness.client(await harness.signIn(person('new-mate')));
    expect((await mate.getAccount()).access).toBe('waitlisted');
    await expectError('not_invited', () => mate.createMachine('m', randomUUID()));
    const invite = await owner.createInvite('New-Mate');
    expect((await owner.createInvite('new-mate')).id).toBe(invite.id);
    await mate.acceptInvite(invite.id);
    const { machine } = await mate.createMachine('mine', randomUUID());
    expect(machine.ownerAccountId).toBe((await mate.getAccount()).id);
    expect((await owner.getBilling()).seats).toBe(2);
  });

  it('keeps answering while the fleet is unreachable, and sends what was asked once it is back', async () => {
    const owner = await invitedOwner('durable');
    const { machine } = await owner.createMachine('m', randomUUID());
    await machineIn(owner, machine.id, (m) => m.state === 'running', 'running');
    proxy.up = false;
    try {
      const seen = await owner.getMachine(machine.id);
      expect(seen).toMatchObject({ state: 'running', usage: null });
      await owner.stopMachine(machine.id);
      await harness.app.kickWorker();
      expect((await owner.getMachine(machine.id)).state).toBe('stopping');
    } finally {
      proxy.up = true;
    }
    await machineIn(owner, machine.id, (m) => m.state === 'stopped', 'stopped after the fleet came back');
    const { entries } = await owner.listActionLog(machine.id);
    expect(entries.slice(0, 2).map((e) => [e.operation, e.status])).toEqual([['stop', 'succeeded'], ['prepare_to_stop', 'succeeded']]);
  });

  it('keeps no GitHub token anywhere in its database or logs (journey 8)', async () => {
    const owner = await invitedOwner('no-tokens');
    const { machine } = await owner.createMachine('m', randomUUID());
    await machineIn(owner, machine.id, (m) => m.state === 'running', 'running');
    await owner.stopMachine(machine.id);
    await machineIn(owner, machine.id, (m) => m.state === 'stopped', 'stopped');
    const issued = harness.github.issuedTokens();
    expect(issued.length).toBeGreaterThan(0);
    const tables = (await harness.db.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")).rows;
    let dump = '';
    for (const { table_name } of tables) {
      const { rows } = await harness.db.query(`SELECT * FROM ${table_name}`);
      dump += JSON.stringify(rows);
    }
    expect(dump).toContain('no-tokens');
    for (const token of issued) expect(dump).not.toContain(token);
  });
});
