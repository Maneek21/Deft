-- Block 0.9 — per-org LLM spend caps. Admin sets daily_cents and/or
-- monthly_cents; every LLM + OpenClaw dispatch call goes through
-- checkOrgSpendCap() which circuit-breaks when current_*_cents >= *_cents.
-- Counters reset at UTC midnight (daily) and month boundary (monthly).

CREATE TABLE IF NOT EXISTS org_spend_caps (
  org_id                 text PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  daily_cents            integer,
  monthly_cents          integer NOT NULL DEFAULT 10000,  -- $100 default
  current_daily_cents    integer NOT NULL DEFAULT 0,
  current_monthly_cents  integer NOT NULL DEFAULT 0,
  daily_reset_at         timestamp NOT NULL DEFAULT now(),
  monthly_reset_at       timestamp NOT NULL DEFAULT now(),
  created_at             timestamp NOT NULL DEFAULT now(),
  updated_at             timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS org_spend_caps_monthly_reset_idx ON org_spend_caps (monthly_reset_at);
