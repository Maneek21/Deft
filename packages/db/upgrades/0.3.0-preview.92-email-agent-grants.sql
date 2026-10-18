CREATE TABLE IF NOT EXISTS email_agent_grants (
 id text PRIMARY KEY CHECK (id ~ '^[a-f0-9-]{36}$'), org_id text NOT NULL, owner_user_id text NOT NULL, account_id text NOT NULL,
 principal_kind text NOT NULL CHECK(principal_kind IN ('defty','personal_mcp')), principal_id text NOT NULL,
 operations jsonb NOT NULL CHECK(jsonb_typeof(operations)='array' AND operations <@ '["read","draft","triage","send"]'::jsonb),
 revision integer NOT NULL CHECK(revision > 0), revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(org_id,owner_user_id,account_id,principal_kind,principal_id),
 FOREIGN KEY(org_id,owner_user_id,account_id) REFERENCES email_accounts(org_id,owner_user_id,account_id) ON DELETE RESTRICT
);
