-- Hosted cells only use this table: the newest seat statement the cell
-- accepted from the control plane, and the highest version it has accepted.
-- Self-hosted installs leave it empty. Add-only.
-- No IF NOT EXISTS: a same-named leftover fails the upgrade instead of being
-- recorded as applied.
CREATE TABLE seat_statements (
  cell_id text PRIMARY KEY,
  token text NOT NULL,
  seats integer NOT NULL,
  version bigint NOT NULL,
  issued_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  highest_version bigint NOT NULL,
  accepted_at timestamp NOT NULL DEFAULT now(),
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT seat_statements_seats_check CHECK (seats >= 0),
  CONSTRAINT seat_statements_version_check CHECK (version >= 1 AND highest_version >= version)
);
