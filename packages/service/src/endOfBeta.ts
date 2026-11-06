/**
 * The operator's end-of-beta actions (journey 18): the notice email, sent once per person per end
 * date, and the deletion of machines and disks after the end date, which needs a named approval.
 */
import { BETA_PUSH_WINDOW_MINUTES, type BetaStatus, type Machine } from 'pane-cloud-contract';
import { type BetaConfig, betaStatus } from './beta';
import { type Db, transaction } from './db';
import { logSteps } from './records';

export interface Mailer {
  send(mail: { to: string; subject: string; text: string }): Promise<void>;
}

const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

function noticeEmail(status: BetaStatus, endsAt: string, pushWindowsFrom: string, to: string) {
  const ends = day(endsAt);
  const lines = [
    `The Pane Cloud beta ends on ${ends} at ${endsAt.slice(11, 16)} UTC.`,
    '',
    `- From ${day(pushWindowsFrom)}, machines start only for ${BETA_PUSH_WINDOW_MINUTES}-minute push windows, so you can push your work. No new machines can be created.`,
    `- On ${ends}, every Pane Cloud machine and its disk is deleted. Work you haven't pushed is lost.`,
    '',
    'To keep working, push your branches, then move your tasks with runpane handoff to another computer',
    status.ownAwsTemplateUrl ? `or to the same machine in your own AWS account: ${status.ownAwsTemplateUrl}` : 'or to a machine in your own AWS account.',
  ];
  if (status.announcementUrl) lines.push('', `Details: ${status.announcementUrl}`);
  return { to, subject: `Pane Cloud beta ends ${ends}`, text: lines.join('\n') };
}

/** Emails the end date to everyone with a seat who hasn't had it for this date. Returns how many were sent. */
export async function announceEnd(db: Db, config: BetaConfig, mailer: Mailer): Promise<number> {
  const status = betaStatus(config);
  const { endsAt, pushWindowsFrom } = status;
  if (!endsAt || !pushWindowsFrom) throw new Error('Set BETA_ENDS_AT first: there is no end date to announce.');
  const { rows } = await db.query<{ id: string; email: string }>(
    `SELECT a.id, a.email FROM accounts a JOIN seats s ON s.account_id = a.id
     WHERE a.email IS NOT NULL AND NOT EXISTS (SELECT 1 FROM beta_notices n WHERE n.account_id = a.id AND n.ends_at = $1)
     ORDER BY a.id`,
    [endsAt],
  );
  for (const row of rows) {
    // Sent first, then recorded: a crash in between sends one person the same notice twice, never zero times.
    await mailer.send(noticeEmail(status, endsAt, pushWindowsFrom, row.email));
    await db.query('INSERT INTO beta_notices (account_id, ends_at) VALUES ($1, $2) ON CONFLICT DO NOTHING', [row.id, endsAt]);
  }
  return rows.length;
}

/**
 * A4's push-all: pushes every worktree on the machine's unpushed-work list, before an end-of-beta
 * delete. A4 hasn't landed, so this stub reports that it did not run.
 */
// TODO(A4): run push-all on the machine once A4's host additions and an allow-listed operation for it exist.
export async function pushAllBeforeDelete(_machineId: string): Promise<'pushed' | 'not available yet'> {
  return 'not available yet';
}

/**
 * After the end date: without an approver, lists the machines left; with one, queues a logged
 * service delete of each machine and its disk, naming the approver.
 */
export async function deleteEndedMachines(db: Db, config: BetaConfig, approvedBy: string | null): Promise<string> {
  const status = betaStatus(config);
  if (status.phase !== 'ended') throw new Error(`The beta has not ended${status.endsAt ? `; it ends ${status.endsAt}` : ''}. Machines are deleted only after the end date.`);
  const { rows } = await db.query<{ id: string; github_login: string; state: Machine['state'] }>(
    `SELECT m.id, a.github_login, m.state FROM machines m JOIN accounts a ON a.id = m.owner_account_id
     WHERE m.state <> 'deleted' AND NOT (m.state = 'deleting' AND m.state_reason IS DISTINCT FROM 'failed')
     ORDER BY m.created_at, m.id`,
  );
  const lines = rows.map((m) => `${m.id}\t${m.github_login}\t${m.state}`);
  if (!approvedBy) {
    return [`${rows.length} machines to delete:`, ...lines, 'Nothing was deleted. Run again with --approved-by <name> to delete these machines and their disks.'].join('\n');
  }
  const out = [`Deleting ${rows.length} machines, approved by ${approvedBy}:`];
  for (const m of rows) {
    const pushAll = await pushAllBeforeDelete(m.id);
    await transaction(db, async (client) => {
      await logSteps(client, m.id, [
        { operation: 'delete', fleetOperation: 'delete', parameters: {}, actor: { kind: 'service' }, reason: `The Pane Cloud beta ended on ${status.endsAt}. Deleted with its disk after approval by ${approvedBy}.` },
      ]);
      await client.query("UPDATE machines SET state = 'deleting', state_reason = NULL, shared_at = NULL, updated_at = now() WHERE id = $1", [m.id]);
      await client.query('DELETE FROM connection_codes WHERE machine_id = $1', [m.id]);
    });
    out.push(`${m.id}\t${m.github_login}\tqueued (push-all: ${pushAll})`);
  }
  return out.join('\n');
}
