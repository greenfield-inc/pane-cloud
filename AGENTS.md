# pane-cloud

A pnpm workspace. Each package lives in `packages/<name>`.

- `packages/service`: the Pane Cloud service (S1). Its README covers configuration, running it locally and the operator CLI.

## Commands

Run from the repository root:

- `pnpm install`
- `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
- `pnpm --filter pane-cloud-service bench`: the hot-path budget (p95 under 200 ms at 500 seats and 500,000 action-log rows)

Tests need Postgres 15 or later: they use `TEST_DATABASE_URL` when it is set, and otherwise start a throwaway cluster with `initdb` and `postgres` from your PATH.

## Rules

- The API contracts are the `pane-cloud-contract` package from greenfield-inc/Pane, pinned to a commit in each package's `package.json`. Build against them and never fork them here.
- SQL migrations are numbered files in `packages/<name>/migrations/`. The service applies every package's migrations in file-name order at startup.
- The service stores no GitHub, agent or Tailscale credential of any user, and logs no request body or header.
- Never print, commit or hardcode a secret.
