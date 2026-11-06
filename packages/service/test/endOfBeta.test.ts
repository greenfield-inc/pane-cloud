import { randomUUID } from 'node:crypto';
import type { Machine, ServiceClient } from 'pane-cloud-contract';
import { waitFor } from 'pane-cloud-contract/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BetaConfig } from '../src/beta';
import { runCommand } from '../src/cli';
import { type Harness, startHarness } from './support/harness';

const DAY = 86_400_000;
const at = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();
const machineIn = (client: ServiceClient, id: string, done: (m: Machine) => boolean, what: string) =>
  waitFor(() => client.getMachine(id), done, what, 20_000);

let nextGithubId = 7100;
const person = (login: string) => ({ id: (nextGithubId += 1), login, name: login, email: `${login}@example.com` });

/** Journey 18's service side: what happens at E−14 and E that GET /v1/beta alone doesn't cover. */
describe('end of beta: stops, notice and deletion', () => {
  let harness: Harness;
  beforeAll(async () => {
    harness = await startHarness();
  });
  afterAll(() => harness.close());
  beforeEach(() => harness.restart({ betaEndsAt: null }));

  const ownerWithMachine = async (login: string) => {
    await harness.cohort(login);
    const owner = harness.client(await harness.signIn(person(login)));
    const { machine } = await owner.createMachine('m', randomUUID());
    await machineIn(owner, machine.id, (m) => m.state === 'running', 'running');
    return { owner, machine };
  };
  const beta = (endsAt: string, links: Partial<BetaConfig> = {}): BetaConfig => ({ endsAt, announcementUrl: null, ownAwsTemplateUrl: null, ...links });

  it('gives a machine already running when push windows begin one window from then, not an endless one', async () => {
    const { owner, machine } = await ownerWithMachine('already-on');
    await harness.restart({ betaEndsAt: at(10 * DAY) });
    const stopped = await machineIn(owner, machine.id, (m) => m.state === 'stopped', 'stopped: its window from E−14 is long over');
    expect(stopped.pushWindowEndsAt).toBeNull();
    const [stop] = (await owner.listActionLog(machine.id)).entries;
    expect(stop).toMatchObject({ operation: 'stop', actor: { kind: 'service' }, reason: 'Your 60-minute push window before the end of the beta is over.' });
  });

  it('ends a push window at the end date, and stops every machine still running then', async () => {
    const { owner, machine } = await ownerWithMachine('runs-into-end');
    await owner.stopMachine(machine.id);
    await machineIn(owner, machine.id, (m) => m.state === 'stopped', 'stopped');
    // Far enough out that the window is read before the end date even on a busy machine.
    const endsAt = at(8000);
    await harness.restart({ betaEndsAt: endsAt });
    const started = await owner.startMachine(machine.id);
    expect(started.machine.pushWindowEndsAt).toBe(endsAt);
    const stopped = await machineIn(owner, machine.id, (m) => m.state === 'stopped', 'stopped at the end date');
    expect(stopped.pushWindowEndsAt).toBeNull();
    const [stop] = (await owner.listActionLog(machine.id)).entries;
    expect(stop).toMatchObject({ operation: 'stop', actor: { kind: 'service' }, status: 'succeeded' });
    expect(stop?.reason).toBe(`The Pane Cloud beta ended on ${endsAt}, so this machine stopped. Its disk is kept until the machines are deleted.`);
  });

  it('deletes machines and disks after the end date only with a named approval, and lists them first', async () => {
    const { owner, machine } = await ownerWithMachine('delete-at-end');
    await expect(runCommand(harness.db, ['beta', 'delete-machines'], { beta: beta(at(DAY)) })).rejects.toThrow('The beta has not ended');

    const endsAt = at(-1000);
    await harness.restart({ betaEndsAt: endsAt });
    await machineIn(owner, machine.id, (m) => m.state === 'stopped', 'stopped at the end date');
    const plan = await runCommand(harness.db, ['beta', 'delete-machines'], { beta: beta(endsAt) });
    expect(plan).toContain(`${machine.id}\tdelete-at-end\tstopped`);
    expect(plan).toContain('Nothing was deleted. Run again with --approved-by <name> to delete these machines and their disks.');
    expect((await owner.getMachine(machine.id)).state).toBe('stopped');

    await runCommand(harness.db, ['beta', 'delete-machines', '--approved-by', 'parsa'], { beta: beta(endsAt) });
    await machineIn(owner, machine.id, (m) => m.state === 'deleted', 'deleted');
    const [entry] = (await owner.listActionLog(machine.id)).entries;
    expect(entry).toMatchObject({ operation: 'delete', actor: { kind: 'service' }, status: 'succeeded' });
    expect(entry?.reason).toBe(`The Pane Cloud beta ended on ${endsAt}. Deleted with its disk after approval by parsa.`);
    expect(await runCommand(harness.db, ['beta', 'delete-machines'], { beta: beta(endsAt) })).not.toContain(machine.id);
  });

  it('emails everyone with a seat the end date once, and again only when the date changes', async () => {
    await harness.cohort('notice-owner');
    await harness.signIn(person('notice-owner'));
    const outbox: { to: string; subject: string; text: string }[] = [];
    const mailer = { send: async (mail: { to: string; subject: string; text: string }) => void outbox.push(mail) };
    const announce = (config: BetaConfig | null) => runCommand(harness.db, ['beta', 'announce'], { beta: config ?? { endsAt: null, announcementUrl: null, ownAwsTemplateUrl: null }, mailer });
    const mine = () => outbox.filter((m) => m.to === 'notice-owner@example.com');

    await expect(announce(null)).rejects.toThrow('Set BETA_ENDS_AT first');
    const march = beta('2027-03-01T17:00:00.000Z', { announcementUrl: 'https://runpane.com/blog/pane-cloud-beta-ends', ownAwsTemplateUrl: 'https://example.com/pane-cloud.yaml' });
    await announce(march);
    expect(mine()).toHaveLength(1);
    expect(mine()[0]?.subject).toBe('Pane Cloud beta ends March 1, 2027');
    expect(mine()[0]?.text).toContain('From February 15, 2027, machines start only for 60-minute push windows');
    expect(mine()[0]?.text).toContain('https://runpane.com/blog/pane-cloud-beta-ends');
    expect(mine()[0]?.text).toContain('https://example.com/pane-cloud.yaml');

    await announce(march);
    expect(mine()).toHaveLength(1);
    await announce(beta('2027-04-01T17:00:00.000Z'));
    expect(mine()).toHaveLength(2);
  });

  it('refuses to announce without an email transport', async () => {
    await expect(runCommand(harness.db, ['beta', 'announce'], { beta: beta('2027-03-01T17:00:00.000Z') })).rejects.toThrow('No email transport');
  });
});
