-- Who has had the end-of-beta notice email for which end date, so announcing again emails only
-- people who haven't had it, and a changed end date is announced to everyone again.
CREATE TABLE beta_notices (
  account_id text NOT NULL REFERENCES accounts (id),
  ends_at timestamptz NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, ends_at)
);
