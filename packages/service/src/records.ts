/** Database rows, their mapping to the contract's shapes, and the action-log queue. */
import { randomBytes, randomUUID } from 'node:crypto';
import type { ActionLogEntry, FleetOperationName, Machine } from 'pane-cloud-contract';
import { MACHINE_LIMITS } from 'pane-cloud-contract';
import type { PoolClient } from 'pg';

type Queryable = Pick<PoolClient, 'query'>;

export const newId = (prefix: string) => `${prefix}_${randomBytes(12).toString('base64url')}`;

export interface MachineRow {
  id: string;
  owner_account_id: string;
  name: string;
  state: Machine['state'];
  state_reason: Machine['stateReason'];
  pane_version: string | null;
  tailnet_status: Machine['tailnet']['status'];
  tailnet_login_url: string | null;
  tailnet_hostname: string | null;
  fleet_updated_at: Date | null;
  shared_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ActionRow {
  id: string;
  machine_id: string;
  batch: string;
  request_id: string;
  operation: ActionLogEntry['operation'];
  fleet_operation: FleetOperationName;
  parameters: Record<string, unknown>;
  actor_kind: ActionLogEntry['actor']['kind'];
  actor_account_id: string | null;
  actor_github_login: string | null;
  reason: string;
  status: ActionLogEntry['status'];
  error: ActionLogEntry['error'];
  envelope: unknown;
  requested_at: Date;
  finished_at: Date | null;
}

/** States the service sets itself while a lifecycle step is queued; the fleet's state waits until it is done. */
export const TRANSITIONAL_STATES: readonly Machine['state'][] = ['stopping', 'resuming', 'deleting'];

export function machineView(row: MachineRow, usage: Machine['usage']): Machine {
  return {
    id: row.id,
    name: row.name,
    ownerAccountId: row.owner_account_id,
    state: row.state,
    stateReason: row.state_reason,
    paneVersion: row.pane_version,
    tailnet: { status: row.tailnet_status, loginUrl: row.tailnet_status === 'joined' ? null : row.tailnet_login_url, hostname: row.tailnet_hostname },
    limits: {
      vcpu: MACHINE_LIMITS.vcpu,
      memoryMiB: MACHINE_LIMITS.memoryMiB,
      diskGiB: MACHINE_LIMITS.diskGiB,
      dailyCpuSeconds: MACHINE_LIMITS.dailyCpuSeconds,
      monthlyEgressBytes: MACHINE_LIMITS.monthlyEgressBytes,
    },
    usage,
    shared: row.shared_at !== null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function actionView(row: ActionRow): ActionLogEntry {
  return {
    id: `act_${row.id}`,
    machineId: row.machine_id,
    operation: row.operation,
    parameters: row.parameters,
    actor: { kind: row.actor_kind, accountId: row.actor_account_id, githubLogin: row.actor_github_login },
    reason: row.reason,
    status: row.status,
    error: row.error,
    requestedAt: row.requested_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
  };
}

export type Actor = { kind: 'user'; accountId: string; githubLogin: string } | { kind: 'service' } | { kind: 'host' };

export interface Step {
  operation: ActionLogEntry['operation'];
  fleetOperation: FleetOperationName;
  parameters: Record<string, unknown>;
  actor: Actor;
  reason: string;
  /** A step that already happened (the fleet acting on its own): logged, never sent. */
  done?: boolean;
}

/** Adds steps to a machine's action log as one batch, in order. Queued steps are what the worker sends. */
export async function logSteps(client: Queryable, machineId: string, steps: Step[]): Promise<ActionRow[]> {
  const batch = randomUUID();
  const rows: ActionRow[] = [];
  for (const step of steps) {
    const actor = step.actor.kind === 'user' ? step.actor : { accountId: null, githubLogin: null };
    const result = await client.query<ActionRow>(
      `INSERT INTO action_log (machine_id, batch, request_id, operation, fleet_operation, parameters, actor_kind, actor_account_id, actor_github_login, reason, status, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CASE WHEN $11 = 'succeeded' THEN now() END)
       RETURNING *`,
      [machineId, batch, randomUUID(), step.operation, step.fleetOperation, JSON.stringify(step.parameters), step.actor.kind, actor.accountId, actor.githubLogin, step.reason, step.done ? 'succeeded' : 'accepted'],
    );
    const row = result.rows[0];
    if (row) rows.push(row);
  }
  return rows;
}
