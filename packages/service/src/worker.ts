/**
 * The worker sends each machine's queued steps to the fleet as signed operations, one at a time and
 * oldest first, and applies what the fleet reports: operation results, and the events the fleet
 * raises on its own (an idle stop, a memory-pressure stop), which it logs with actor `host`.
 */
import { randomUUID } from 'node:crypto';
import {
  CloudApiError,
  type FleetClient,
  type FleetEvent,
  type FleetMachine,
  type OperationEnvelope,
  type OperationPayload,
  type OperationSigner,
  type OperationStatus,
  signOperation,
} from 'pane-cloud-contract';
import type { PoolClient } from 'pg';
import { type Db, transaction } from './db';
import { type BetaConfig, betaStatus, PUSH_WINDOW_MS } from './beta';
import { type ActionRow, logSteps, type MachineRow, TRANSITIONAL_STATES } from './records';

const OPERATION_LIFETIME_MS = 120_000;
const WORKER_LOCK = 7482002;
const EVENT_CURSOR_KEY = 'fleet_events_cursor';

const HOST_STOP_REASONS: Record<string, string> = {
  idle: 'No agent ran and no one was connected for 30 minutes.',
  memory_pressure: 'The host ran short of memory, so it saved this machine and stopped it. Start it to resume where it left off.',
  host_maintenance: 'Host maintenance: the host saved this machine and stopped it. Start it to resume where it left off.',
  host_lost: 'The host this machine ran on failed. Start it to bring it back from its disk.',
  abuse: 'The fleet stopped this machine for breaking the fair-use or abuse rules.',
  billing: 'The fleet stopped this machine because of the team’s billing state.',
  end_of_beta: 'The fleet stopped this machine at the end of the beta.',
  failed: 'The machine failed and the host stopped it.',
};

export interface WorkerDeps {
  db: Db;
  fleet: FleetClient;
  signer: OperationSigner;
  intervalMs: number;
  beta: BetaConfig;
  log?: (line: string) => void;
}

export function createWorker({ db, fleet, signer, intervalMs, beta, log = console.log }: WorkerDeps) {
  let running: Promise<void> | null = null;
  let again = false;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const sign = async (row: ActionRow): Promise<OperationEnvelope> => {
    const issuedAt = new Date();
    // SAFETY: parameters were written by the service for this fleet_operation; signOperation parses the payload against the allow-list again.
    const payload = {
      requestId: row.request_id,
      machineId: row.machine_id,
      operation: row.fleet_operation,
      parameters: row.parameters,
      reason: row.reason,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + OPERATION_LIFETIME_MS).toISOString(),
    } as OperationPayload;
    return signOperation(payload, signer);
  };

  /** Fleet machine state, or null when the fleet has no such machine. */
  const readFleetMachine = async (machineId: string): Promise<FleetMachine | null> => {
    try {
      return await fleet.getMachine(machineId);
    } catch (error) {
      if (error instanceof CloudApiError && error.code === 'machine_not_found') return null;
      throw error;
    }
  };

  /** Applies the fleet's view of a machine, unless a queued step still owns its transitional state. */
  const applyFleetMachine = async (client: PoolClient, machineId: string, found: FleetMachine | null, finished: ActionRow, status: 'succeeded' | 'failed') => {
    const { rows } = await client.query<MachineRow>('SELECT * FROM machines WHERE id = $1 FOR UPDATE', [machineId]);
    const machine = rows[0];
    if (!machine) return;
    if (finished.fleet_operation === 'delete' && status === 'failed') {
      // The seat was freed when the delete was asked for; the machine stays deleting until a retry works.
      await client.query("UPDATE machines SET state_reason = 'failed', updated_at = now() WHERE id = $1", [machineId]);
      return;
    }
    const open = await client.query('SELECT 1 FROM action_log WHERE machine_id = $1 AND status IN ($2, $3) LIMIT 1', [machineId, 'accepted', 'running']);
    const keepState = open.rowCount !== 0 && TRANSITIONAL_STATES.includes(machine.state);
    if (!found) {
      const deleted = finished.fleet_operation === 'delete';
      await client.query(
        `UPDATE machines SET state = $2, state_reason = $3, shared_at = CASE WHEN $2 = 'deleted' THEN NULL ELSE shared_at END, updated_at = now() WHERE id = $1`,
        [machineId, keepState ? machine.state : deleted ? 'deleted' : 'error', keepState ? machine.state_reason : deleted ? 'user' : 'failed'],
      );
      return;
    }
    await client.query(
      `UPDATE machines SET state = $2, state_reason = $3, pane_version = $4, tailnet_status = $5, tailnet_login_url = $6, tailnet_hostname = $7,
              fleet_updated_at = $8, shared_at = CASE WHEN $2 = 'deleted' THEN NULL ELSE shared_at END, updated_at = now()
       WHERE id = $1`,
      [
        machineId,
        keepState ? machine.state : found.state,
        keepState ? machine.state_reason : found.stateReason,
        found.paneVersion,
        found.tailnet.status,
        found.tailnet.loginUrl,
        found.tailnet.hostname,
        found.updatedAt,
      ],
    );
  };

  const finish = async (row: ActionRow, status: 'succeeded' | 'failed', error: ActionRow['error']) => {
    let found: FleetMachine | null = null;
    let fleetRead = true;
    try {
      found = await readFleetMachine(row.machine_id);
    } catch {
      fleetRead = false;
    }
    await transaction(db, async (client) => {
      await client.query('UPDATE action_log SET status = $2, error = $3, finished_at = now() WHERE id = $1', [row.id, status, error ? JSON.stringify(error) : null]);
      if (status === 'failed' && row.fleet_operation !== 'prepare_to_stop') {
        await client.query(
          `UPDATE action_log SET status = 'failed', error = $3, finished_at = now() WHERE batch = $1 AND id > $2 AND status = 'accepted'`,
          [row.batch, row.id, JSON.stringify({ code: 'previous_step_failed', message: `${row.operation} failed, so this step did not run.`, next: 'Check the failed step above, then try again.' })],
        );
      }
      if (fleetRead) await applyFleetMachine(client, row.machine_id, found, row, status);
    });
  };

  const applyStatus = async (row: ActionRow, status: OperationStatus) => {
    if (status.status === 'succeeded' || status.status === 'failed') {
      await finish(row, status.status, status.error);
    } else if (row.status !== 'running') {
      await db.query("UPDATE action_log SET status = 'running' WHERE id = $1", [row.id]);
    }
  };

  /** Moves a machine's oldest open step forward. Returns true when it finished, so the next can go. */
  const advance = async (row: ActionRow): Promise<boolean> => {
    try {
      if (row.status === 'running') {
        const status = await fleet.getOperation(row.request_id);
        await applyStatus(row, status);
        return status.status === 'succeeded' || status.status === 'failed';
      }
      let envelope = row.envelope as OperationEnvelope | null;
      if (envelope && Date.parse(envelope.payload.expiresAt) <= Date.now() + 10_000) {
        // The first send may or may not have reached the fleet; ask before signing a new request.
        try {
          const status = await fleet.getOperation(row.request_id);
          await applyStatus(row, status);
          return status.status === 'succeeded' || status.status === 'failed';
        } catch (error) {
          if (!(error instanceof CloudApiError && error.code === 'operation_not_found')) throw error;
        }
        row.request_id = randomUUID();
        envelope = null;
      }
      if (!envelope) {
        envelope = await sign(row);
        await db.query('UPDATE action_log SET request_id = $2, envelope = $3 WHERE id = $1', [row.id, row.request_id, JSON.stringify(envelope)]);
      }
      const status = await fleet.submitOperation(envelope);
      await applyStatus(row, status);
      return status.status === 'succeeded' || status.status === 'failed';
    } catch (error) {
      if (error instanceof CloudApiError) {
        if (row.fleet_operation === 'delete' && error.code === 'machine_not_found') {
          await finish(row, 'succeeded', null);
        } else {
          await finish(row, 'failed', { code: error.code, message: error.message, next: error.next });
        }
        return true;
      }
      // The fleet is unreachable: leave the step queued and try again on the next tick.
      log(`worker: ${row.fleet_operation} on ${row.machine_id} waits for the fleet: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  const processQueue = async () => {
    const { rows: heads } = await db.query<ActionRow>(
      `SELECT DISTINCT ON (machine_id) * FROM action_log WHERE status IN ('accepted', 'running') ORDER BY machine_id, id`,
    );
    await Promise.all(
      heads.map(async (head) => {
        let row: ActionRow | undefined = head;
        while (row && !stopped && (await advance(row))) {
          const next = await db.query<ActionRow>(`SELECT * FROM action_log WHERE machine_id = $1 AND status IN ('accepted', 'running') ORDER BY id LIMIT 1`, [head.machine_id]);
          row = next.rows[0];
        }
      }),
    );
  };

  const applyEvent = async (client: PoolClient, event: FleetEvent) => {
    if (event.kind !== 'state_changed' || !event.state) return;
    const { rows } = await client.query<MachineRow>('SELECT * FROM machines WHERE id = $1 FOR UPDATE', [event.machineId]);
    const machine = rows[0];
    if (!machine) return;
    if (machine.fleet_updated_at && machine.fleet_updated_at.getTime() > Date.parse(event.at)) return;
    const open = await client.query('SELECT 1 FROM action_log WHERE machine_id = $1 AND status IN ($2, $3) LIMIT 1', [machine.id, 'accepted', 'running']);
    if (open.rowCount !== 0) return;
    if (event.state === 'stopped' && event.reason && event.reason !== 'user' && machine.state !== 'stopped') {
      await logSteps(client, machine.id, [{ operation: 'stop', fleetOperation: 'stop', parameters: {}, actor: { kind: 'host' }, reason: HOST_STOP_REASONS[event.reason] ?? 'The host stopped this machine.', done: true }]);
    } else if (event.state === 'running' && machine.state === 'stopped') {
      await logSteps(client, machine.id, [{ operation: 'start', fleetOperation: 'resume', parameters: {}, actor: { kind: 'host' }, reason: 'The host started this machine again.', done: true }]);
    }
    await client.query(
      `UPDATE machines SET state = $2, state_reason = $3, fleet_updated_at = $4, shared_at = CASE WHEN $2 = 'deleted' THEN NULL ELSE shared_at END, updated_at = now() WHERE id = $1`,
      [machine.id, event.state, event.reason, event.at],
    );
  };

  const processEvents = async () => {
    for (;;) {
      const cursor = (await db.query<{ value: string }>('SELECT value FROM service_state WHERE key = $1', [EVENT_CURSOR_KEY])).rows[0]?.value;
      const page = await fleet.listEvents(cursor, 200);
      if (page.events.length === 0) return;
      for (const event of page.events) {
        await transaction(db, async (client) => {
          await applyEvent(client, event);
          await client.query(
            'INSERT INTO service_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
            [EVENT_CURSOR_KEY, event.id],
          );
        });
      }
      if (page.events.length < 200) return;
    }
  };

  /** Queues a stop for each running machine whose push window is up, in the beta's last 14 days or after its owner lost their seat (D-27). */
  const endPushWindows = async () => {
    const status = betaStatus(beta);
    const betaFrom = status.phase === 'push_windows' ? status.pushWindowsFrom : null;
    // A machine whose owner lost their seat stops at once if it has not started since, and an hour
    // after that start if it has. In the beta's push-window phase, an hour after its latest start.
    const { rows } = await db.query<{ id: string; started_since_removal: boolean }>(
      `SELECT m.id, ls.at IS NOT NULL AS started_since_removal FROM machines m
       LEFT JOIN LATERAL (SELECT max(s.requested_at) AS at FROM action_log s
                          WHERE s.machine_id = m.id AND s.operation = 'start' AND s.requested_at >= m.seat_removed_at) ls ON true
       WHERE m.state = 'running'
         AND NOT EXISTS (SELECT 1 FROM action_log o WHERE o.machine_id = m.id AND o.status IN ('accepted', 'running'))
         AND ((m.seat_removed_at IS NOT NULL AND COALESCE(ls.at, '-infinity') <= $2)
           OR ($1::timestamptz IS NOT NULL AND (SELECT max(s.requested_at) FROM action_log s WHERE s.machine_id = m.id AND s.operation = 'start' AND s.requested_at >= $1) <= $2))`,
      [betaFrom, new Date(Date.now() - PUSH_WINDOW_MS)],
    );
    for (const { id, started_since_removal } of rows) {
      await transaction(db, async (client) => {
        const machine = (await client.query<MachineRow>('SELECT * FROM machines WHERE id = $1 FOR UPDATE', [id])).rows[0];
        if (machine?.state !== 'running') return;
        let reason = 'Your 60-minute push window before the end of the beta is over.';
        if (machine.seat_removed_at) {
          reason = started_since_removal
            ? 'Your 60-minute push window after leaving your team is over.'
            : 'You were removed from your team. Your disk is kept: start this machine once for 60 minutes to push your work.';
        }
        await logSteps(client, id, [
          { operation: 'prepare_to_stop', fleetOperation: 'prepare_to_stop', parameters: {}, actor: { kind: 'service' }, reason: 'Let Pane finish writing before the stop.' },
          { operation: 'stop', fleetOperation: 'stop', parameters: {}, actor: { kind: 'service' }, reason },
        ]);
        await client.query("UPDATE machines SET state = 'stopping', state_reason = NULL, updated_at = now() WHERE id = $1", [id]);
      });
    }
    if (rows.length) await processQueue();
  };

  const tick = async () => {
    const client = await db.connect();
    try {
      const locked = (await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [WORKER_LOCK])).rows[0]?.ok;
      if (!locked) return;
      try {
        await processQueue();
        await processEvents();
        await endPushWindows();
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [WORKER_LOCK]);
      }
    } catch (error) {
      log(`worker: tick failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      client.release();
    }
  };

  /** Runs a tick now, or right after the one in progress. */
  const kick = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        await tick();
      } while (again && !stopped);
      running = null;
    })();
    return running;
  };

  return {
    kick,
    start() {
      stopped = false;
      timer = setInterval(() => void kick(), intervalMs);
      void kick();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      await running;
    },
  };
}
export type Worker = ReturnType<typeof createWorker>;
