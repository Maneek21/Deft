-- Preserve historical confirmations without inventing their commit clocks.
ALTER TABLE app_public_endpoints ADD COLUMN IF NOT EXISTS budget_policy jsonb;
ALTER TABLE app_canonical_claims ADD COLUMN IF NOT EXISTS budget_reserved_at timestamp;
ALTER TABLE app_public_endpoints DROP CONSTRAINT IF EXISTS app_public_endpoints_budget_policy_check;
ALTER TABLE app_public_endpoints ADD CONSTRAINT app_public_endpoints_budget_policy_check CHECK (
  budget_policy IS NULL OR COALESCE((
    public_action_key IS NOT NULL
    AND jsonb_typeof(budget_policy) = 'object'
    AND octet_length(budget_policy::text) <= 1024
    AND budget_policy->>'schema_version' = 'deft.app_public_budget.v1'
    AND jsonb_typeof(budget_policy->'max_pending') = 'number'
    AND (budget_policy->>'max_pending')::numeric BETWEEN 1 AND 25
    AND (budget_policy->>'max_pending')::numeric = trunc((budget_policy->>'max_pending')::numeric)
    AND jsonb_typeof(budget_policy->'max_confirmed_per_utc_day') = 'number'
    AND (budget_policy->>'max_confirmed_per_utc_day')::numeric BETWEEN 1 AND 100
    AND (budget_policy->>'max_confirmed_per_utc_day')::numeric = trunc((budget_policy->>'max_confirmed_per_utc_day')::numeric)
    AND budget_policy - ARRAY['schema_version','max_pending','max_confirmed_per_utc_day'] = '{}'::jsonb
  ), false)
);
