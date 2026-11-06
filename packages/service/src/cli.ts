/**
 * Operator commands. Run with DATABASE_URL set:
 *   pane-cloud-service migrate
 *   pane-cloud-service cohort add <github-login> [note]
 *   pane-cloud-service cohort remove <github-login>
 *   pane-cloud-service cohort list
 *   pane-cloud-service billing announce <start-date-iso>   (needs STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET)
 */
import type { StripeGateway } from '@pane-cloud/billing';
import { createServiceBilling } from './billing';
import { billingFromEnv } from './config';
import { createDb, type Db, migrate } from './db';

export async function runCommand(
  db: Db,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  overrides: { stripe?: StripeGateway; now?: () => Date } = {},
): Promise<string> {
  const [command, action, login, ...rest] = args;
  if (command === 'migrate') {
    const ran = await migrate(db);
    return ran.length ? `Applied ${ran.join(', ')}` : 'Already up to date';
  }
  if (command === 'cohort' && action === 'add' && login) {
    await db.query(
      'INSERT INTO cohort (github_login_lower, note) VALUES (lower($1), $2) ON CONFLICT (github_login_lower) DO UPDATE SET note = EXCLUDED.note',
      [login, rest.join(' ') || null],
    );
    return `Added ${login} to the cohort. They get a team when they next sign in.`;
  }
  if (command === 'cohort' && action === 'remove' && login) {
    const removed = await db.query('DELETE FROM cohort WHERE github_login_lower = lower($1)', [login]);
    return removed.rowCount ? `Removed ${login} from the cohort. Teams and machines they already have stay.` : `${login} was not in the cohort.`;
  }
  if (command === 'cohort' && action === 'list') {
    const { rows } = await db.query<{ github_login_lower: string; added_at: Date; note: string | null }>('SELECT * FROM cohort ORDER BY added_at');
    return rows.map((r) => `${r.github_login_lower}\t${r.added_at.toISOString()}\t${r.note ?? ''}`).join('\n') || 'The cohort is empty.';
  }
  if (command === 'billing' && action === 'announce' && login) {
    const startAt = new Date(login);
    if (Number.isNaN(startAt.getTime())) throw new Error(`"${login}" is not a date. Use an ISO date such as 2026-11-26T17:00:00Z.`);
    const billing = billingFromEnv(env);
    if (!billing) throw new Error('Billing is off: set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET.');
    const { emailed, noEmail } = await createServiceBilling(db, billing, overrides).announceCharges(startAt);
    const lines = [`Charges start ${startAt.toISOString()}. Emailed ${emailed} team owner(s).`];
    if (noEmail.length) lines.push(`No email on file for the owners of ${noEmail.join(', ')}: reach them another way, then run this again once they have one.`);
    return lines.join('\n');
  }
  throw new Error('Usage: migrate | cohort add <github-login> [note] | cohort remove <github-login> | cohort list | billing announce <start-date-iso>');
}

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('Set DATABASE_URL to the service database.');
    process.exit(1);
  }
  const db = createDb(url);
  runCommand(db, process.argv.slice(2))
    .then((out) => console.log(out))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    })
    .finally(() => void db.end());
}
