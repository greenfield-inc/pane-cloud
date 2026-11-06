# Pane Cloud service

The service desktop Pane's Pane Cloud adapter talks to. It implements the service API in
[`pane-cloud-contract`](https://github.com/greenfield-inc/Pane/tree/main/packages/pane-cloud-contract)
and calls the fleet API on the user's behalf.

- **Sign-in**: GitHub's device flow, with no scopes, proves who someone is. The service reads the
  person's GitHub id, login, name and email, then drops the GitHub token. It stores only a hash of
  its own bearer token.
- **Cohort, teams and seats**: Pane Cloud is invite-only. A GitHub login an operator adds to the
  cohort gets a new team, as its owner, when it signs in, unless a team has invited it: then it
  joins that team by accepting the invite. Owners invite teammates by GitHub login,
  and each member is one seat. Everyone else sees "You're on the list".
- **Machines**: one per seat. Every create, start, stop, delete and operation is written to the
  machine's action log first. A worker then sends each step to the fleet, oldest first, as an
  operation signed with the service's key. Only the operations on the contract's allow-list exist,
  each with fixed parameters. `update_pane` and first-boot `bootstrap` name a published Pane release
  and the checksum of its arm64 `.deb`, read from the Pane repository's GitHub releases.
- **Action log**: each entry says who acted (`user`, `service`, or `host` for stops the fleet made on
  its own, such as an idle stop), why, and the exact parameters sent. The machine page reads it.
- **Team directory**: owners can list a machine for their team and leave a single-use connection
  code for one teammate. Neither admits anyone: the owner approves teammates on the host.
- **Removing a teammate**: their seat goes, their machine leaves the team directory, and the service
  stops the machine with its disk kept. Without a seat they can start it once, for a 60-minute push
  window to push their work, after which the service stops it again. Joining a team again lifts the
  limit.
- **End of the beta**: `GET /v1/beta` publishes `BETA_ENDS_AT` and the phases that follow from it.
  Notice starts 30 days before the end. From 14 days before, no machine can be created, and a start
  runs for a 60-minute push window, after which the service stops the machine. Once the beta ends,
  machines no longer start.
- **When the fleet is down**: reads answer from the last known state, and queued steps go out when
  the fleet answers again.

## Configuration

| Variable | Required | What it is |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres 15 or later |
| `GITHUB_CLIENT_ID` | yes | The GitHub OAuth app used for device sign-in (no client secret needed) |
| `FLEET_URL`, `FLEET_TOKEN` | yes | The fleet API and the service's credential for it |
| `SIGNING_KEY_ID` | yes | The key id the fleet trusts for this service's signatures |
| `SIGNING_KEY_FILE` or `SIGNING_KEY_PEM` | yes | The P-256 private key (PKCS#8 PEM) that signs operations |
| `PORT` | no | Default `8080` |
| `PANE_RELEASES_REPO` | no | Default `greenfield-inc/Pane` |
| `GITHUB_URL`, `GITHUB_API_URL` | no | Default `https://github.com` and `https://api.github.com` |
| `WORKER_INTERVAL_MS` | no | How often the worker polls the fleet. Default `1000` |
| `BETA_ENDS_AT` | no | The end of the beta, as an ISO date. Unset means no end date |
| `BETA_ANNOUNCEMENT_URL`, `OWN_AWS_TEMPLATE_URL` | no | The links `GET /v1/beta` returns with the end date |

The service migrates its database at startup. `GET /healthz` answers `{"ok":true}`.

## Run it

```sh
pnpm install
pnpm --filter pane-cloud-service build
DATABASE_URL=... pnpm --filter pane-cloud-service cli cohort add <github-login>
pnpm --filter pane-cloud-service start
```

Until the fleet runs on AWS, point `FLEET_URL` at `startFleetStub` from `pane-cloud-contract/stubs`,
with the signing key's public half in its `trustedKeys`. The tests do exactly that.

## Operator commands

`node dist/cli.js <command>` (or `pnpm cli <command>` from source), with `DATABASE_URL` set:

| Command | What it does |
| --- | --- |
| `migrate` | Applies pending migrations |
| `cohort add <github-login> [note]` | Lets a GitHub login into the cohort |
| `cohort remove <github-login>` | Takes a login out of the cohort; teams and machines it already has stay |
| `cohort list` | Lists the cohort |

## Tests

`pnpm test` runs P0's service contract cases against this service, backed by P0's fleet stub and a
fake GitHub, and adds checks for the release on first boot, host stops, the fleet being down, and a
search of the whole database for the test accounts' GitHub tokens. `pnpm bench` checks the hot-path
budget: p95 under 200 ms for the team's machine list, the roster and a machine's action log at 500
seats and 500,000 action-log rows.
