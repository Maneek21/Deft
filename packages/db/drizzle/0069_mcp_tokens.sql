CREATE TABLE IF NOT EXISTS "mcp_tokens" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "user_id" text,
  "agent_employee_id" text,
  "principal_kind" text NOT NULL,
  "name" text NOT NULL,
  "token_hash" text NOT NULL,
  "token_prefix" text NOT NULL,
  "scopes" text[] NOT NULL,
  "last_used_at" timestamp,
  "revoked_at" timestamp,
  "created_by" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "mcp_tokens_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE no action ON UPDATE no action,
  CONSTRAINT "mcp_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "mcp_tokens_agent_employee_id_agent_employees_id_fk" FOREIGN KEY ("agent_employee_id") REFERENCES "agent_employees"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "mcp_tokens_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action,
  CONSTRAINT "mcp_tokens_principal_kind_check" CHECK ("principal_kind" IN ('human', 'agent')),
  CONSTRAINT "mcp_tokens_principal_target_check" CHECK (
    ("principal_kind" = 'human' AND "user_id" IS NOT NULL AND "agent_employee_id" IS NULL)
    OR
    ("principal_kind" = 'agent' AND "agent_employee_id" IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS "mcp_tokens_org_idx" ON "mcp_tokens" ("org_id");
CREATE INDEX IF NOT EXISTS "mcp_tokens_user_idx" ON "mcp_tokens" ("user_id");
CREATE INDEX IF NOT EXISTS "mcp_tokens_agent_idx" ON "mcp_tokens" ("agent_employee_id");
CREATE INDEX IF NOT EXISTS "mcp_tokens_prefix_idx" ON "mcp_tokens" ("token_prefix");
