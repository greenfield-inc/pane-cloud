-- Pane Cloud service schema. The service stores identities, teams, machines and the action log.
-- It stores no GitHub, agent or Tailscale credential of any user (D-6).

CREATE TABLE accounts (
  id text PRIMARY KEY,
  github_id bigint NOT NULL UNIQUE,
  github_login text NOT NULL,
  name text,
  email text,
  tailscale_login text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX accounts_login ON accounts (lower(github_login));

-- The invite-only cohort: GitHub logins an operator let in. A cohort login that signs in with no
-- seat gets a new team as its owner.
CREATE TABLE cohort (
  github_login_lower text PRIMARY KEY,
  added_at timestamptz NOT NULL DEFAULT now(),
  note text
);

-- Bearer tokens from device sign-in, stored only as SHA-256 hashes.
CREATE TABLE sessions (
  token_hash bytea PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_account ON sessions (account_id);

CREATE TABLE teams (
  id text PRIMARY KEY,
  name text NOT NULL,
  owner_account_id text NOT NULL REFERENCES accounts (id),
  -- Founding teams keep $49 a seat if the price later rises (D-15).
  founding boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- A seat is one person's membership of one team. Billing (B1) and the roster (E2) extend it.
CREATE TABLE seats (
  account_id text PRIMARY KEY REFERENCES accounts (id),
  team_id text NOT NULL REFERENCES teams (id),
  role text NOT NULL CHECK (role IN ('owner', 'member')),
  status text NOT NULL DEFAULT 'free' CHECK (status IN ('free', 'active', 'grace', 'canceled')),
  founding_price boolean NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX seats_team ON seats (team_id);

CREATE TABLE invites (
  id text PRIMARY KEY,
  team_id text NOT NULL REFERENCES teams (id),
  github_login text NOT NULL,
  invited_by_account_id text NOT NULL REFERENCES accounts (id),
  status text NOT NULL CHECK (status IN ('pending', 'accepted', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX invites_login ON invites (lower(github_login)) WHERE status = 'pending';
CREATE INDEX invites_team ON invites (team_id) WHERE status = 'pending';

-- The service's record of each machine. state is the service's view: the fleet's state, plus the
-- transitional state the service sets when it queues a lifecycle step.
CREATE TABLE machines (
  id text PRIMARY KEY,
  owner_account_id text NOT NULL REFERENCES accounts (id),
  name text NOT NULL,
  idempotency_key text NOT NULL,
  state text NOT NULL,
  state_reason text,
  pane_version text,
  tailnet_status text NOT NULL DEFAULT 'awaiting_login',
  tailnet_login_url text,
  tailnet_hostname text,
  -- The fleet time of the last state the service applied, so an older fleet event never wins.
  fleet_updated_at timestamptz,
  -- Set while the machine is listed in its owner's team directory.
  shared_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_account_id, idempotency_key)
);
-- One machine per seat. A machine being deleted no longer holds the seat.
CREATE UNIQUE INDEX machines_one_per_owner ON machines (owner_account_id) WHERE state NOT IN ('deleted', 'deleting');

-- Every lifecycle step and operation on a machine, with who asked and why. Rows with status
-- 'accepted' or 'running' are also the queue the worker sends to the fleet, oldest first per machine.
CREATE TABLE action_log (
  id bigserial PRIMARY KEY,
  machine_id text NOT NULL REFERENCES machines (id),
  -- Steps queued together; a failed step fails the steps after it in the same batch.
  batch uuid NOT NULL,
  request_id uuid NOT NULL UNIQUE,
  operation text NOT NULL,
  fleet_operation text NOT NULL,
  parameters jsonb NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'service', 'host')),
  actor_account_id text REFERENCES accounts (id),
  actor_github_login text,
  reason text NOT NULL,
  status text NOT NULL CHECK (status IN ('accepted', 'running', 'succeeded', 'failed')),
  error jsonb,
  -- The signed envelope as first sent, so a retry is the same request.
  envelope jsonb,
  requested_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX action_log_machine ON action_log (machine_id, id DESC);
CREATE INDEX action_log_open ON action_log (machine_id, id) WHERE status IN ('accepted', 'running');

-- Connection codes the owner's Pane left for one teammate to pick up once.
CREATE TABLE connection_codes (
  machine_id text NOT NULL REFERENCES machines (id),
  for_account_id text NOT NULL REFERENCES accounts (id),
  id text NOT NULL,
  code text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (machine_id, for_account_id)
);

-- Small service state, such as the fleet event cursor.
CREATE TABLE service_state (
  key text PRIMARY KEY,
  value text NOT NULL
);
