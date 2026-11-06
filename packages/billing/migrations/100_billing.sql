-- B1: Stripe billing state per team. Seats, founding and the owner live in the service's teams and seats tables.
CREATE TABLE billing_teams (
  team_id text PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
  stripe_customer_id text UNIQUE,
  -- Stripe's latest view of the team's subscription, refreshed on every webhook: { id, status, quantity, currentPeriodEnd, cancelAtPeriodEnd }.
  subscription jsonb,
  grace_ends_at timestamptz,
  notice_sent_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The one billing notice: when it went out and when charges start for every team.
CREATE TABLE billing_notice (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  issued_at timestamptz NOT NULL,
  charges_start_at timestamptz NOT NULL
);
