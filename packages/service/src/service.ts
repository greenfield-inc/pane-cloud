/**
 * The service API's handlers. Sign-in proves a GitHub identity; every machine change is queued in the
 * machine's action log and sent to the fleet by the worker as a signed, allow-listed operation.
 * Nothing here grants anyone access to a machine.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  type Account,
  type BillingStatus,
  CloudApiError,
  CONNECTION_CODE_MAX_SECONDS,
  type FleetClient,
  type Invite,
  type Machine,
  parseUserOperation,
  serviceRoutes,
  type SharedMachine,
  type Team,
} from 'pane-cloud-contract';
import type { PoolClient } from 'pg';
import { type Db, transaction } from './db';
import type { Github } from './github';
import { assertCanCreate, assertCanStart, type BetaConfig, betaStatus } from './beta';
import { actionView, type ActionRow, logSteps, machineView, type MachineRow, newId, pushWindowEndsAt, type Step } from './records';
import { bind, type BoundRoute } from './router';
import type { Worker } from './worker';

const SESSION_DAYS = 30;
const INVITE_DAYS = 14;
const SEAT_PRICE_CENTS = 4900;

interface CallerRow {
  id: string;
  github_id: string;
  github_login: string;
  name: string | null;
  email: string | null;
  tailscale_login: string | null;
  team_id: string | null;
  role: 'owner' | 'member' | null;
}

interface InviteRow {
  id: string;
  team_id: string;
  github_login: string;
  invited_by_account_id: string;
  status: Invite['status'];
  created_at: Date;
  expires_at: Date;
}

export interface ServiceDeps {
  db: Db;
  github: Github;
  fleet: FleetClient;
  worker: Pick<Worker, 'kick'>;
  beta: BetaConfig;
}

const hashToken = (token: string) => createHash('sha256').update(token).digest();

const inviteView = (row: InviteRow): Invite => ({
  id: row.id,
  githubLogin: row.github_login,
  invitedByAccountId: row.invited_by_account_id,
  status: row.status,
  createdAt: row.created_at.toISOString(),
  expiresAt: row.expires_at.toISOString(),
});

const notFound = (machineId: string) => new CloudApiError('machine_not_found', `You have no machine ${machineId}.`, 'List your machines to find its id.');
const notOnTeam = () => new CloudApiError('not_team_member', 'This account is not on a team yet.', 'Accept a team invite, or ask to join the cohort.');

const CALLER_SQL = `SELECT a.id, a.github_id, a.github_login, a.name, a.email, a.tailscale_login, s.team_id, s.role
  FROM accounts a LEFT JOIN seats s ON s.account_id = a.id`;

export function serviceHandlers({ db, github, fleet, worker, beta }: ServiceDeps): BoundRoute[] {
  const view = async (row: MachineRow, usage: Machine['usage']) => machineView(row, usage, await pushWindowEndsAt(db, row, beta));
  const caller = async (token: string | null): Promise<CallerRow> => {
    const { rows } = await db.query<CallerRow>(
      `${CALLER_SQL} JOIN sessions t ON t.account_id = a.id WHERE t.token_hash = $1 AND t.expires_at > now()`,
      [hashToken(token ?? '')],
    );
    const row = rows[0];
    if (!row) throw new CloudApiError('unauthenticated', 'The token is unknown, expired or signed out.', 'Sign in again.');
    return row;
  };
  const reloadCaller = async (accountId: string): Promise<CallerRow> => {
    const { rows } = await db.query<CallerRow>(`${CALLER_SQL} WHERE a.id = $1`, [accountId]);
    const row = rows[0];
    if (!row) throw new Error(`account ${accountId} vanished`);
    return row;
  };
  const requireTeam = (who: CallerRow): string => {
    if (!who.team_id) throw notOnTeam();
    return who.team_id;
  };
  const requireOwner = (who: CallerRow): string => {
    const teamId = requireTeam(who);
    if (who.role !== 'owner') throw new CloudApiError('not_team_owner', 'Only the team owner can do this.', 'Ask your team owner.');
    return teamId;
  };

  /** A cohort login with no seat and no pending invite gets a new team, as its owner. */
  const ensureCohortTeam = async (who: CallerRow): Promise<CallerRow> => {
    if (who.team_id) return who;
    const inCohort = await db.query(
      `SELECT 1 FROM cohort WHERE github_login_lower = lower($1)
       AND NOT EXISTS (SELECT 1 FROM invites WHERE lower(github_login) = lower($1) AND status = 'pending' AND expires_at > now())`,
      [who.github_login],
    );
    if (inCohort.rowCount === 0) return who;
    await transaction(db, async (client) => {
      // Lock the account so concurrent first requests create one team, not one each.
      await client.query('SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE', [who.id]);
      const seated = await client.query('SELECT 1 FROM seats WHERE account_id = $1', [who.id]);
      if (seated.rowCount !== 0) return;
      const teamId = newId('team');
      await client.query('INSERT INTO teams (id, name, owner_account_id) VALUES ($1, $2, $3)', [teamId, `${who.github_login}'s team`, who.id]);
      await client.query(
        "INSERT INTO seats (account_id, team_id, role, founding_price) VALUES ($1, $2, 'owner', true)",
        [who.id, teamId],
      );
    });
    return reloadCaller(who.id);
  };

  const accountView = async (who: CallerRow): Promise<Account> => {
    const { rows } = await db.query<InviteRow>(
      "SELECT * FROM invites WHERE lower(github_login) = lower($1) AND status = 'pending' AND expires_at > now() ORDER BY created_at",
      [who.github_login],
    );
    return {
      id: who.id,
      githubId: Number(who.github_id),
      githubLogin: who.github_login,
      name: who.name,
      email: who.email,
      access: who.team_id ? 'invited' : 'waitlisted',
      teamId: who.team_id,
      role: who.role,
      tailscaleLogin: who.tailscale_login,
      pendingInvites: rows.map(inviteView),
    };
  };

  const machineRow = async (client: Pick<PoolClient, 'query'>, who: CallerRow, machineId: string, lock = false): Promise<MachineRow> => {
    const { rows } = await client.query<MachineRow>(`SELECT * FROM machines WHERE id = $1 AND owner_account_id = $2${lock ? ' FOR UPDATE' : ''}`, [machineId, who.id]);
    const row = rows[0];
    if (!row) throw notFound(machineId);
    return row;
  };

  /** Today's usage, read live from the fleet; null when the fleet has none or does not answer. */
  const usageFor = async (row: MachineRow): Promise<Machine['usage']> => {
    if (row.state === 'creating' || row.state === 'deleted' || row.state === 'deleting') return null;
    try {
      const metrics = await fleet.getMetrics(row.id);
      const reset = new Date(`${metrics.day}T00:00:00.000Z`);
      reset.setUTCDate(reset.getUTCDate() + 1);
      return {
        day: metrics.day,
        cpuSecondsUsed: metrics.cpuSecondsUsed,
        throttled: metrics.throttled,
        resetsAt: reset.toISOString(),
        egressBytesThisMonth: metrics.egressBytesThisMonth,
        diskUsedBytes: metrics.diskUsedBytes,
      };
    } catch {
      return null;
    }
  };

  /**
   * The owner's view of a machine. The tailnet login link and hostname change without a fleet event,
   * so they are read live and kept; when the fleet does not answer, the last known values stand.
   */
  const ownerView = async (row: MachineRow): Promise<Machine> => {
    let current = row;
    if (row.state !== 'creating' && row.state !== 'deleted') {
      try {
        const found = await fleet.getMachine(row.id);
        const { rows } = await db.query<MachineRow>(
          `UPDATE machines SET pane_version = $2, tailnet_status = $3, tailnet_login_url = $4, tailnet_hostname = $5 WHERE id = $1 RETURNING *`,
          [row.id, found.paneVersion, found.tailnet.status, found.tailnet.loginUrl, found.tailnet.hostname],
        );
        current = rows[0] ?? row;
      } catch {
        // The fleet is unreachable; the stored state is still the best answer.
      }
    }
    return view(current, await usageFor(current));
  };

  /** Checks the machine's state and queues steps for it in one transaction, then wakes the worker. */
  const queue = async (who: CallerRow, machineId: string, plan: (machine: MachineRow) => { steps: Step[]; state?: Machine['state']; userStep: number }) => {
    const { machine, entry } = await transaction(db, async (client) => {
      const current = await machineRow(client, who, machineId, true);
      const { steps, state, userStep } = plan(current);
      const rows = await logSteps(client, machineId, steps);
      let updated = current;
      if (state) {
        const result = await client.query<MachineRow>(
          `UPDATE machines SET state = $2, state_reason = NULL, shared_at = CASE WHEN $2 = 'deleting' THEN NULL ELSE shared_at END, updated_at = now() WHERE id = $1 RETURNING *`,
          [machineId, state],
        );
        updated = result.rows[0] ?? current;
      }
      const userRow = rows[userStep];
      if (!userRow) throw new Error('queued no user step');
      return { machine: updated, entry: userRow };
    });
    void worker.kick();
    return { machine, entry };
  };

  const userActor = (who: CallerRow) => ({ kind: 'user' as const, accountId: who.id, githubLogin: who.github_login });
  const requireState = (machine: MachineRow, state: Machine['state'], action: string) => {
    if (machine.state !== state) {
      throw new CloudApiError('invalid_state', `${action} needs a ${state} machine; it is ${machine.state}.`, 'Refresh the machine and try the action that fits its state.');
    }
  };
  const releaseFor = async (version?: string) => {
    const found = await github.release(version);
    if ('published' in found) {
      throw new CloudApiError(
        'release_not_published',
        version ? `Pane ${version} is not a published release.` : 'No published Pane release is available.',
        found.published.length ? `Pick one of: ${found.published.join(', ')}.` : 'Try again once a Pane release is published.',
      );
    }
    return found;
  };

  const teamView = async (teamId: string): Promise<Team> => {
    const team = (await db.query<{ id: string; name: string }>('SELECT id, name FROM teams WHERE id = $1', [teamId])).rows[0];
    if (!team) throw notOnTeam();
    const members = await db.query<{ id: string; github_login: string; name: string | null; tailscale_login: string | null; role: 'owner' | 'member'; status: 'free' | 'active' | 'grace' | 'canceled'; founding_price: boolean; joined_at: Date }>(
      `SELECT a.id, a.github_login, a.name, a.tailscale_login, s.role, s.status, s.founding_price, s.joined_at
       FROM seats s JOIN accounts a ON a.id = s.account_id WHERE s.team_id = $1 ORDER BY s.joined_at, a.id`,
      [teamId],
    );
    const invites = await db.query<InviteRow>("SELECT * FROM invites WHERE team_id = $1 AND status = 'pending' AND expires_at > now() ORDER BY created_at", [teamId]);
    return {
      id: team.id,
      name: team.name,
      members: members.rows.map((m) => ({
        accountId: m.id,
        githubLogin: m.github_login,
        name: m.name,
        role: m.role,
        tailscaleLogin: m.tailscale_login,
        seat: { status: m.status, foundingPrice: m.founding_price },
        joinedAt: m.joined_at.toISOString(),
      })),
      invites: invites.rows.map(inviteView),
    };
  };

  const r = serviceRoutes;
  return [
    bind(r.startDeviceSignIn, async () => github.startDeviceFlow()),

    bind(r.pollDeviceSignIn, async ({ body }) => {
      const outcome = await github.pollDeviceFlow(body.deviceCode);
      if (outcome.status !== 'complete') return { status: outcome.status };
      const { identity } = outcome;
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO accounts (id, github_id, github_login, name, email) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (github_id) DO UPDATE SET github_login = EXCLUDED.github_login, name = EXCLUDED.name, email = EXCLUDED.email, updated_at = now()
         RETURNING id`,
        [newId('acct'), identity.id, identity.login, identity.name, identity.email],
      );
      const accountId = rows[0]?.id;
      if (!accountId) throw new Error('account upsert returned nothing');
      const token = `pcs_${randomBytes(32).toString('base64url')}`;
      const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
      await db.query('INSERT INTO sessions (token_hash, account_id, expires_at) VALUES ($1, $2, $3)', [hashToken(token), accountId, expiresAt]);
      const who = await ensureCohortTeam(await reloadCaller(accountId));
      return { status: 'complete' as const, token, expiresAt: expiresAt.toISOString(), account: await accountView(who) };
    }),

    bind(r.signOut, async ({ token }) => {
      await caller(token);
      await db.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token ?? '')]);
      return { signedOut: true as const };
    }),

    bind(r.getAccount, async ({ token }) => accountView(await ensureCohortTeam(await caller(token)))),

    bind(r.setTailscaleLogin, async ({ token, body }) => {
      const who = await caller(token);
      await db.query('UPDATE accounts SET tailscale_login = $2, updated_at = now() WHERE id = $1', [who.id, body.tailscaleLogin]);
      return accountView(await reloadCaller(who.id));
    }),

    bind(r.listMachines, async ({ token }) => {
      const who = await caller(token);
      const { rows } = await db.query<MachineRow>("SELECT * FROM machines WHERE owner_account_id = $1 AND state <> 'deleted' ORDER BY created_at", [who.id]);
      return { machines: await Promise.all(rows.map(ownerView)) };
    }),

    bind(r.createMachine, async ({ token, body }) => {
      const who = await caller(token);
      /** The machine a create with this idempotency key already made, as that create answered. */
      const repeated = async () => {
        const repeat = await db.query<MachineRow>('SELECT * FROM machines WHERE owner_account_id = $1 AND idempotency_key = $2', [who.id, body.idempotencyKey]);
        const existing = repeat.rows[0];
        if (!existing) return null;
        const entry = await db.query<ActionRow>("SELECT * FROM action_log WHERE machine_id = $1 AND operation = 'create' ORDER BY id LIMIT 1", [existing.id]);
        const first = entry.rows[0];
        return first ? { machine: await view(existing, await usageFor(existing)), operation: actionView(first) } : null;
      };
      const earlier = await repeated();
      if (earlier) return earlier;
      if (!who.team_id) {
        throw new CloudApiError('not_invited', "You're on the list. Pane Cloud is invite-only for now.", 'Wait for your invite, or ask a team owner to invite your GitHub login.');
      }
      assertCanCreate(beta);
      const release = await releaseFor();
      const seatTaken = () => new CloudApiError('seat_has_machine', 'Your seat already has a machine.', 'Open your existing machine, or delete it before creating another.');
      let created;
      try {
        created = await transaction(db, async (client) => {
          const machineId = newId('m');
          try {
            await client.query(
              `INSERT INTO machines (id, owner_account_id, name, idempotency_key, state) VALUES ($1, $2, $3, $4, 'creating')`,
              [machineId, who.id, body.name, body.idempotencyKey],
            );
          } catch (error) {
            if ((error as { code?: string }).code === '23505') throw seatTaken();
            throw error;
          }
          const rows = await logSteps(client, machineId, [
            { operation: 'create', fleetOperation: 'create', parameters: {}, actor: userActor(who), reason: 'You created this machine.' },
            { operation: 'bootstrap', fleetOperation: 'bootstrap', parameters: { release }, actor: { kind: 'service' }, reason: `First boot: install Pane ${release.version} and wait for your tailnet login.` },
          ]);
          const machine = (await client.query<MachineRow>('SELECT * FROM machines WHERE id = $1', [machineId])).rows[0];
          const entry = rows[0];
          if (!machine || !entry) throw new Error('create wrote nothing');
          return { machine, entry };
        });
      } catch (error) {
        // A concurrent create with the same key won the race: answer as it did.
        if (error instanceof CloudApiError && error.code === 'seat_has_machine') {
          const raced = await repeated();
          if (raced) return raced;
        }
        throw error;
      }
      void worker.kick();
      return { machine: await view(created.machine, null), operation: actionView(created.entry) };
    }),

    bind(r.getMachine, async ({ token, params }) => ownerView(await machineRow(db, await caller(token), params.machineId ?? ''))),

    bind(r.startMachine, async ({ token, params }) => {
      const who = await caller(token);
      assertCanStart(beta);
      const pushWindow = betaStatus(beta).phase === 'push_windows';
      const { machine, entry } = await queue(who, params.machineId ?? '', (m) => {
        requireState(m, 'stopped', 'Start');
        const reason = pushWindow ? 'You started this machine for a 60-minute push window before the beta ends.' : 'You started this machine.';
        return { steps: [{ operation: 'start', fleetOperation: 'resume', parameters: {}, actor: userActor(who), reason }], state: 'resuming', userStep: 0 };
      });
      return { machine: await view(machine, null), operation: actionView(entry) };
    }),

    bind(r.stopMachine, async ({ token, params }) => {
      const who = await caller(token);
      const { machine, entry } = await queue(who, params.machineId ?? '', (m) => {
        requireState(m, 'running', 'Stop');
        return {
          steps: [
            { operation: 'prepare_to_stop', fleetOperation: 'prepare_to_stop', parameters: {}, actor: { kind: 'service' }, reason: 'Let Pane finish writing before the stop.' },
            { operation: 'stop', fleetOperation: 'stop', parameters: {}, actor: userActor(who), reason: 'You stopped this machine.' },
          ],
          state: 'stopping',
          userStep: 1,
        };
      });
      return { machine: await view(machine, null), operation: actionView(entry) };
    }),

    bind(r.deleteMachine, async ({ token, params }) => {
      const who = await caller(token);
      const { machine, entry } = await queue(who, params.machineId ?? '', (m) => {
        // A deleting machine whose delete failed (state reason `failed`) can be deleted again.
        if (m.state === 'deleted' || (m.state === 'deleting' && m.state_reason !== 'failed')) {
          throw new CloudApiError('invalid_state', 'This machine is already deleted.', 'Nothing to do.');
        }
        return { steps: [{ operation: 'delete', fleetOperation: 'delete', parameters: {}, actor: userActor(who), reason: 'You deleted this machine and its disk.' }], state: 'deleting', userStep: 0 };
      });
      await db.query('DELETE FROM connection_codes WHERE machine_id = $1', [machine.id]);
      return { machine: await view(machine, null), operation: actionView(entry) };
    }),

    bind(r.requestOperation, async ({ token, params, body }) => {
      const who = await caller(token);
      const request = parseUserOperation(body);
      const release = request.operation === 'update_pane' ? await releaseFor(request.parameters.version) : null;
      const { entry } = await queue(who, params.machineId ?? '', (m) => {
        requireState(m, 'running', request.operation);
        const step: Step = release
          ? { operation: 'update_pane', fleetOperation: 'update_pane', parameters: { release }, actor: userActor(who), reason: `You updated Pane to ${release.version}.` }
          : { operation: 'collect_diagnostics', fleetOperation: 'collect_diagnostics', parameters: {}, actor: userActor(who), reason: 'You collected diagnostics.' };
        return { steps: [step], userStep: 0 };
      });
      return actionView(entry);
    }),

    bind(r.listActionLog, async ({ token, params, query }) => {
      const machine = await machineRow(db, await caller(token), params.machineId ?? '');
      const before = query.before === undefined ? null : /^act_\d{1,18}$/.test(query.before) ? query.before.slice(4) : undefined;
      if (before === undefined) throw new CloudApiError('invalid_request', 'The before cursor is not one this service gave out.', 'Pass the nextCursor from the previous page.');
      const limit = query.limit ?? 50;
      const { rows } = await db.query<ActionRow>(
        'SELECT * FROM action_log WHERE machine_id = $1 AND ($2::bigint IS NULL OR id < $2::bigint) ORDER BY id DESC LIMIT $3',
        [machine.id, before, limit + 1],
      );
      const page = rows.slice(0, limit);
      return { entries: page.map(actionView), nextCursor: rows.length > limit ? `act_${page.at(-1)?.id}` : null };
    }),

    bind(r.setSharing, async ({ token, params, body }) => {
      const who = await caller(token);
      requireTeam(who);
      const machine = await machineRow(db, who, params.machineId ?? '');
      if (machine.state === 'deleted' || machine.state === 'deleting') throw new CloudApiError('invalid_state', 'A deleted machine cannot be shared.', 'Share a machine you still have.');
      await db.query(
        `UPDATE machines SET shared_at = CASE WHEN $2 THEN COALESCE(shared_at, now()) ELSE NULL END, updated_at = now() WHERE id = $1`,
        [machine.id, body.shared],
      );
      if (!body.shared) await db.query('DELETE FROM connection_codes WHERE machine_id = $1', [machine.id]);
      return ownerView(await machineRow(db, who, machine.id));
    }),

    bind(r.leaveConnectionCode, async ({ token, params, body }) => {
      const who = await caller(token);
      const teamId = requireTeam(who);
      const machine = await machineRow(db, who, params.machineId ?? '');
      if (!machine.shared_at) throw new CloudApiError('invalid_state', 'This machine is not shared with your team.', 'Turn on sharing for it first.');
      const mate = await db.query('SELECT 1 FROM seats WHERE account_id = $1 AND team_id = $2', [body.forAccountId, teamId]);
      if (mate.rowCount === 0 || body.forAccountId === who.id) throw new CloudApiError('not_team_member', 'That account is not a teammate.', 'Invite them to your team first.');
      const expires = Date.parse(body.expiresAt);
      if (expires <= Date.now() || expires > Date.now() + CONNECTION_CODE_MAX_SECONDS * 1000) {
        throw new CloudApiError('invalid_request', `A connection code must expire within ${CONNECTION_CODE_MAX_SECONDS / 60} minutes.`, 'Mint a fresh code on the host and leave it again.');
      }
      const id = newId('cc');
      await db.query(
        `INSERT INTO connection_codes (machine_id, for_account_id, id, code, expires_at) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (machine_id, for_account_id) DO UPDATE SET id = EXCLUDED.id, code = EXCLUDED.code, expires_at = EXCLUDED.expires_at`,
        [machine.id, body.forAccountId, id, body.code, body.expiresAt],
      );
      return { id, machineId: machine.id, forAccountId: body.forAccountId, expiresAt: new Date(expires).toISOString() };
    }),

    bind(r.claimConnectionCode, async ({ token, params }) => {
      const who = await caller(token);
      const { rows } = await db.query<{ code: string; expires_at: Date; tailnet_hostname: string | null; shared_at: Date | null; owner_team: string | null }>(
        `DELETE FROM connection_codes c USING machines m LEFT JOIN seats s ON s.account_id = m.owner_account_id
         WHERE c.machine_id = $1 AND c.for_account_id = $2 AND m.id = c.machine_id
         RETURNING c.code, c.expires_at, m.tailnet_hostname, m.shared_at, s.team_id AS owner_team`,
        [params.machineId ?? '', who.id],
      );
      const handoff = rows[0];
      if (!handoff || handoff.expires_at.getTime() <= Date.now() || !handoff.shared_at || !who.team_id || handoff.owner_team !== who.team_id) {
        throw new CloudApiError('connection_code_not_found', 'No connection code is waiting for you on this machine.', 'Ask the machine owner to approve you from their Pane.');
      }
      return { machineId: params.machineId ?? '', code: handoff.code, tailnetHostname: handoff.tailnet_hostname, expiresAt: handoff.expires_at.toISOString() };
    }),

    bind(r.getBeta, async () => betaStatus(beta)),

    bind(r.getBilling, async ({ token }): Promise<BillingStatus> => {
      const who = await caller(token);
      const teamId = requireTeam(who);
      const { rows } = await db.query<{ founding: boolean; seats: string }>(
        'SELECT t.founding, (SELECT count(*) FROM seats s WHERE s.team_id = t.id) AS seats FROM teams t WHERE t.id = $1',
        [teamId],
      );
      const team = rows[0];
      if (!team) throw notOnTeam();
      return {
        teamId,
        plan: 'cohort',
        seatPriceCents: SEAT_PRICE_CENTS,
        currency: 'usd',
        foundingPriceLocked: team.founding,
        status: 'free',
        seats: Number(team.seats),
        chargesStartAt: null,
        graceEndsAt: null,
        currentPeriodEnd: null,
        manageUrl: null,
      };
    }),

    bind(r.getTeam, async ({ token }) => teamView(requireTeam(await caller(token)))),

    bind(r.createInvite, async ({ token, body }) => {
      const who = await caller(token);
      const teamId = requireOwner(who);
      const member = await db.query('SELECT 1 FROM seats s JOIN accounts a ON a.id = s.account_id WHERE s.team_id = $1 AND lower(a.github_login) = lower($2)', [teamId, body.githubLogin]);
      if (member.rowCount !== 0) throw new CloudApiError('already_member', `${body.githubLogin} is already on this team.`, 'Nothing to do.');
      const pending = await db.query<InviteRow>(
        "SELECT * FROM invites WHERE team_id = $1 AND lower(github_login) = lower($2) AND status = 'pending' AND expires_at > now()",
        [teamId, body.githubLogin],
      );
      const already = pending.rows[0];
      if (already) return inviteView(already);
      const { rows } = await db.query<InviteRow>(
        `INSERT INTO invites (id, team_id, github_login, invited_by_account_id, status, expires_at) VALUES ($1, $2, $3, $4, 'pending', now() + $5::interval) RETURNING *`,
        [newId('inv'), teamId, body.githubLogin, who.id, `${INVITE_DAYS} days`],
      );
      const invite = rows[0];
      if (!invite) throw new Error('invite insert returned nothing');
      return inviteView(invite);
    }),

    bind(r.revokeInvite, async ({ token, params }) => {
      const teamId = requireOwner(await caller(token));
      const { rows } = await db.query<InviteRow>(
        "UPDATE invites SET status = 'revoked' WHERE id = $1 AND team_id = $2 AND status = 'pending' RETURNING *",
        [params.inviteId ?? '', teamId],
      );
      const invite = rows[0];
      if (!invite) throw new CloudApiError('invite_not_found', 'No pending invite with that id on your team.', 'List your team to see its invites.');
      return inviteView(invite);
    }),

    bind(r.acceptInvite, async ({ token, params }) => {
      const who = await caller(token);
      if (who.team_id) throw new CloudApiError('already_member', 'You are already on a team.', 'Leave your current team first.');
      await transaction(db, async (client) => {
        const { rows } = await client.query<InviteRow & { founding: boolean }>(
          `SELECT i.*, t.founding FROM invites i JOIN teams t ON t.id = i.team_id
           WHERE i.id = $1 AND i.status = 'pending' AND i.expires_at > now() AND lower(i.github_login) = lower($2) FOR UPDATE OF i`,
          [params.inviteId ?? '', who.github_login],
        );
        const invite = rows[0];
        if (!invite) throw new CloudApiError('invite_not_found', 'No pending invite for you with that id.', 'Ask the team owner to invite your GitHub login.');
        await client.query("UPDATE invites SET status = 'accepted' WHERE id = $1", [invite.id]);
        const seat = await client.query(
          "INSERT INTO seats (account_id, team_id, role, founding_price) VALUES ($1, $2, 'member', $3) ON CONFLICT (account_id) DO NOTHING",
          [who.id, invite.team_id, invite.founding],
        );
        if (seat.rowCount === 0) throw new CloudApiError('already_member', 'You are already on a team.', 'Leave your current team first.');
      });
      return accountView(await reloadCaller(who.id));
    }),

    bind(r.removeMember, async ({ token, params }) => {
      const who = await caller(token);
      const teamId = requireOwner(who);
      const accountId = params.accountId ?? '';
      if (accountId === who.id) throw new CloudApiError('invalid_request', 'The owner cannot be removed.', 'Remove other members only.');
      await transaction(db, async (client) => {
        const removed = await client.query("DELETE FROM seats WHERE account_id = $1 AND team_id = $2 AND role = 'member'", [accountId, teamId]);
        if (removed.rowCount === 0) throw new CloudApiError('not_team_member', 'That account is not on your team.', 'List your team to see its members.');
        await client.query('UPDATE machines SET shared_at = NULL, updated_at = now() WHERE owner_account_id = $1 AND shared_at IS NOT NULL', [accountId]);
        await client.query(
          'DELETE FROM connection_codes WHERE for_account_id = $1 OR machine_id IN (SELECT id FROM machines WHERE owner_account_id = $1)',
          [accountId],
        );
      });
      return teamView(teamId);
    }),

    bind(r.listSharedMachines, async ({ token }) => {
      const teamId = requireTeam(await caller(token));
      const { rows } = await db.query<{
        id: string; name: string; state: Machine['state']; tailnet_hostname: string | null; shared_at: Date;
        account_id: string; github_login: string; owner_name: string | null; tailscale_login: string | null;
      }>(
        `SELECT m.id, m.name, m.state, m.tailnet_hostname, m.shared_at, a.id AS account_id, a.github_login, a.name AS owner_name, a.tailscale_login
         FROM seats s JOIN machines m ON m.owner_account_id = s.account_id JOIN accounts a ON a.id = s.account_id
         WHERE s.team_id = $1 AND m.shared_at IS NOT NULL AND m.state <> 'deleted'
         ORDER BY m.shared_at, m.id`,
        [teamId],
      );
      const machines: SharedMachine[] = rows.map((m) => ({
        machineId: m.id,
        name: m.name,
        state: m.state,
        owner: { accountId: m.account_id, githubLogin: m.github_login, name: m.owner_name, tailscaleLogin: m.tailscale_login },
        tailnetHostname: m.tailnet_hostname,
        sharedAt: m.shared_at.toISOString(),
      }));
      return { machines };
    }),
  ];
}
