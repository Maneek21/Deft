-- Block 0.11 — ClawHub allowlist cache. Daily worker upserts slugs pulled
-- from VoltAgent/awesome-openclaw-skills (or the bundled static fallback on
-- network failure). Block 1 Library UI defaults to showing only rows from
-- this table; raw-ClawHub browse is behind an org-admin Advanced toggle.

CREATE TABLE IF NOT EXISTS clawhub_allowlist (
  slug          text PRIMARY KEY,
  source        text NOT NULL DEFAULT 'voltagent'
                  CHECK (source IN ('voltagent', 'deft-bundled', 'deft-verified')),
  description   text,
  homepage      text,
  last_seen_at  timestamp NOT NULL DEFAULT now(),
  added_at      timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS clawhub_allowlist_source_idx ON clawhub_allowlist (source);
