/**
 * Builds B1's billing (`@pane-cloud/billing`) on the service's database: its view of teams, the
 * service's signed machine stop, and a mailer.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Billing, type BillingDeps, createBilling, createPgStore, createStripeGateway, type StripeGateway } from '@pane-cloud/billing';
import type { BillingConfig } from './config';
import { type Db, transaction } from './db';
import { logSteps, type MachineRow, newId } from './records';

export type { Billing };

/** Writes each email as a file, for staging and local runs until SES is set up. */
function outboxMailer(dir: string): BillingDeps['mailer'] {
  return {
    async send(mail) {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, `${newId('mail')}.txt`), `To: ${mail.to}\nSubject: ${mail.subject}\n\n${mail.text}\n`);
    },
  };
}

/** Refuses to send, so no notice is recorded as sent when nobody received it. */
const noMailer: BillingDeps['mailer'] = {
  async send() {
    throw new Error('No mailer is set up. Set BILLING_OUTBOX_DIR (staging) or configure SES before sending billing email.');
  },
};

export function createServiceBilling(
  db: Db,
  config: BillingConfig,
  options: { kickWorker?: () => void; stripe?: StripeGateway; now?: () => Date } = {},
): Billing {
  return createBilling({
    stripe: options.stripe ?? createStripeGateway(config.stripeSecretKey),
    webhookSecret: config.webhookSecret,
    store: createPgStore(db),
    returnUrl: config.returnUrl,
    mailer: config.outboxDir ? outboxMailer(config.outboxDir) : noMailer,
    now: options.now,
    teams: {
      async getTeam(teamId) {
        const { rows } = await db.query<{ id: string; created_at: Date; founding: boolean; owner_account_id: string; email: string | null; seats: string }>(
          `SELECT t.id, t.created_at, t.founding, t.owner_account_id, a.email, (SELECT count(*) FROM seats s WHERE s.team_id = t.id) AS seats
           FROM teams t JOIN accounts a ON a.id = t.owner_account_id WHERE t.id = $1`,
          [teamId],
        );
        const t = rows[0];
        if (!t) return null;
        return { id: t.id, createdAt: t.created_at, founding: t.founding, ownerAccountId: t.owner_account_id, ownerEmail: t.email ?? '', seats: Number(t.seats) };
      },
      async listTeamIds() {
        const { rows } = await db.query<{ id: string }>('SELECT id FROM teams ORDER BY id');
        return rows.map((r) => r.id);
      },
    },
    machines: {
      /** Queues a signed stop for each of the team's running machines, logged as the service's with the reason. */
      async stopTeamMachines(teamId, reason) {
        const { rows } = await db.query<{ id: string }>(
          "SELECT m.id FROM machines m JOIN seats s ON s.account_id = m.owner_account_id WHERE s.team_id = $1 AND m.state = 'running'",
          [teamId],
        );
        let stopped = 0;
        for (const { id } of rows) {
          await transaction(db, async (client) => {
            const current = (await client.query<MachineRow>('SELECT * FROM machines WHERE id = $1 FOR UPDATE', [id])).rows[0];
            if (current?.state !== 'running') return;
            await logSteps(client, id, [
              { operation: 'prepare_to_stop', fleetOperation: 'prepare_to_stop', parameters: {}, actor: { kind: 'service' }, reason: 'Let Pane finish writing before the stop.' },
              { operation: 'stop', fleetOperation: 'stop', parameters: {}, actor: { kind: 'service' }, reason },
            ]);
            await client.query("UPDATE machines SET state = 'stopping', state_reason = NULL, updated_at = now() WHERE id = $1", [id]);
            stopped += 1;
          });
        }
        if (stopped) options.kickWorker?.();
      },
    },
  });
}
