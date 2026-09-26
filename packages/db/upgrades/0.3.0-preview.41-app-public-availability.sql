-- Optional manager-reviewed scalar availability. Historical claim-only
-- endpoints retain NULL policy and their existing review digest/behavior.
ALTER TABLE app_public_endpoints ADD COLUMN IF NOT EXISTS availability_policy jsonb;
ALTER TABLE app_public_endpoints DROP CONSTRAINT IF EXISTS app_public_endpoints_availability_policy_check;
ALTER TABLE app_public_endpoints ADD CONSTRAINT app_public_endpoints_availability_policy_check CHECK (
  availability_policy IS NULL OR COALESCE((
    public_action_key IS NOT NULL
    AND jsonb_typeof(availability_policy) = 'object'
    AND octet_length(availability_policy::text) <= 4096
    AND availability_policy->>'schema_version' = 'deft.app_public_availability.v1'
    AND jsonb_typeof(availability_policy->'fields') = 'array'
    AND jsonb_array_length(availability_policy->'fields') BETWEEN 1 AND 8
    AND jsonb_typeof(availability_policy->'claim_deadline_field') = 'string'
    AND jsonb_typeof(availability_policy->'module_version_id') = 'string'
    AND jsonb_typeof(availability_policy->'page_size') = 'number'
    AND (availability_policy->>'page_size')::numeric BETWEEN 1 AND 10
    AND (availability_policy->>'page_size')::numeric = trunc((availability_policy->>'page_size')::numeric)
    AND availability_policy - ARRAY['schema_version','fields','claim_deadline_field','page_size','module_version_id'] = '{}'::jsonb
  ), false)
);
