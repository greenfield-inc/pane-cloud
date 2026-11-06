import { randomUUID } from 'node:crypto';
import { waitFor, expectError } from 'pane-cloud-contract/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './support/harness';

const DAY = 86_400_000;
const inDays = (days: number) => new Date(Date.now() + days * DAY).toISOString();

describe('the end of the beta', () => {
  let harness: Harness;
  beforeAll(async () => {
    harness = await startHarness({ betaEndsAt: '2030-01-31T00:00:00.000Z' });
  });
  afterAll(() => harness.close());

  it('publishes the end date with the notice and push-window dates that follow from it', async () => {
    expect(await harness.client().getBeta()).toEqual({
      endsAt: '2030-01-31T00:00:00.000Z',
      noticeAt: '2030-01-01T00:00:00.000Z',
      pushWindowsFrom: '2030-01-17T00:00:00.000Z',
      phase: 'open',
      pushWindowMinutes: 60,
      announcementUrl: null,
      ownAwsTemplateUrl: null,
    });
  });

  it('starts machines only for a 60-minute push window from 14 days out, stops them after it, and starts none once the beta ends', async () => {
    await harness.restart({ betaEndsAt: inDays(20) });
    await harness.cohort('late-pusher');
    await harness.cohort('latecomer');
    const owner = harness.client(await harness.signIn({ id: 7001, login: 'late-pusher' }));
    expect((await owner.getBeta()).phase).toBe('notice');
    const { machine } = await owner.createMachine('m', randomUUID());
    await waitFor(() => owner.getMachine(machine.id), (m) => m.state === 'running', 'running', 5000);
    await owner.stopMachine(machine.id);
    await waitFor(() => owner.getMachine(machine.id), (m) => m.state === 'stopped', 'stopped', 5000);

    await harness.restart({ betaEndsAt: inDays(10) });
    expect((await owner.getBeta()).phase).toBe('push_windows');
    const latecomer = harness.client(await harness.signIn({ id: 7002, login: 'latecomer' }));
    await expectError('invalid_state', () => latecomer.createMachine('m', randomUUID()));
    const started = await owner.startMachine(machine.id);
    expect(started.operation.reason).toBe('You started this machine for a 60-minute push window before the beta ends.');
    expect(Date.parse(started.machine.pushWindowEndsAt ?? '')).toBe(Date.parse(started.operation.requestedAt) + 60 * 60_000);
    await waitFor(() => owner.getMachine(machine.id), (m) => m.state === 'running', 'running in its push window', 5000);

    // An hour passes: move the start back past its window.
    await harness.db.query("UPDATE action_log SET requested_at = now() - interval '61 minutes' WHERE machine_id = $1 AND operation = 'start'", [machine.id]);
    await waitFor(() => owner.getMachine(machine.id), (m) => m.state === 'stopped', 'stopped when the window ends', 5000);
    const [stop] = (await owner.listActionLog(machine.id)).entries;
    expect(stop).toMatchObject({ operation: 'stop', actor: { kind: 'service' }, reason: 'Your 60-minute push window before the end of the beta is over.' });

    await harness.restart({ betaEndsAt: inDays(-1) });
    expect((await owner.getBeta()).phase).toBe('ended');
    await expectError('invalid_state', () => owner.startMachine(machine.id));
  });
});
