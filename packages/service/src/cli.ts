/**
 * Operator commands. Run with DATABASE_URL set:
 *   pane-cloud-service migrate
 *   pane-cloud-service cohort add <github-login> [note]
 *   pane-cloud-service cohort remove <github-login>
 *   pane-cloud-service cohort list
 *   pane-cloud-service beta announce
 *   pane-cloud-service beta delete-machines [--approved-by <name>]
 * The beta commands read BETA_ENDS_AT, BETA_ANNOUNCEMENT_URL and OWN_AWS_TEMPLATE_URL, as the service does.
 */
import { type BetaConfig, betaConfigFromEnv } from './beta';
import { announceEnd, deleteEndedMachines, type Mailer } from './endOfBeta';
import { createDb, type Db, migrate } from './db';

export interface CommandDeps {
  beta?: BetaConfig;
  /** Sends the end-of-beta notice. None exists until SES production access does (aws-setup.md step 6). */
  mailer?: Mailer;
}

async function betaCommand(db: Db, [action, ...args]: string[], deps: CommandDeps): Promise<string> {
  const beta = deps.beta ?? betaConfigFromEnv();
  if (action === 'announce') {
    if (!deps.mailer) throw new Error('No email transport is set up yet: the notice email waits on SES production access (aws-setup.md step 6).');
    return `Emailed the end date to ${await announceEnd(db, beta, deps.mailer)} people who hadn't had it.`;
  }
  if (action === 'delete-machines') {
    const at = args.indexOf('--approved-by');
    return deleteEndedMachines(db, beta, at === -1 ? null : (args[at + 1] ?? null));
  }
  throw new Error('Usage: beta announce | beta delete-machines [--approved-by <name>]');
}

export async function runCommand(db: Db, args: string[], deps: CommandDeps = {}): Promise<string> {
  const [command, action, login, ...rest] = args;
  if (command === 'beta') return betaCommand(db, args.slice(1), deps);
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
  throw new Error('Usage: migrate | cohort add <github-login> [note] | cohort remove <github-login> | cohort list | beta announce | beta delete-machines [--approved-by <name>]');
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
