CREATE TABLE IF NOT EXISTS "agent_channel_connections" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "agent_employee_id" text NOT NULL REFERENCES "agent_employees"("id") ON DELETE cascade,
  "runtime_kind" text DEFAULT 'custom_mcp' NOT NULL,
  "status" text DEFAULT 'disconnected' NOT NULL,
  "protocol_version" text DEFAULT 'deft.agent_channel.v1' NOT NULL,
  "last_seen_at" timestamp,
  "last_event_id" text,
  "last_error" text,
  "paused_at" timestamp,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "agent_channel_tokens" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "agent_employee_id" text NOT NULL REFERENCES "agent_employees"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "token_hash" text NOT NULL,
  "token_prefix" text NOT NULL,
  "scopes" jsonb DEFAULT '["channel:read","channel:write"]'::jsonb NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "last_used_at" timestamp,
  "revoked_at" timestamp,
  "created_by" text REFERENCES "users"("id") ON DELETE set null,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "agent_channel_events" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "agent_employee_id" text NOT NULL REFERENCES "agent_employees"("id") ON DELETE cascade,
  "kind" text NOT NULL,
  "source_kind" text,
  "source_id" text,
  "space_id" text REFERENCES "spaces"("id") ON DELETE set null,
  "thread_id" text REFERENCES "messages"("id") ON DELETE set null,
  "actor_user_id" text REFERENCES "users"("id") ON DELETE set null,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "idempotency_key" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "delivery_count" integer DEFAULT 0 NOT NULL,
  "delivered_at" timestamp,
  "acked_at" timestamp,
  "completed_at" timestamp,
  "failed_at" timestamp,
  "error" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "agent_channel_cursors" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "agent_employee_id" text NOT NULL REFERENCES "agent_employees"("id") ON DELETE cascade,
  "connection_id" text REFERENCES "agent_channel_connections"("id") ON DELETE set null,
  "last_delivered_event_id" text,
  "last_acked_event_id" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "agent_channel_sessions" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "agent_employee_id" text NOT NULL REFERENCES "agent_employees"("id") ON DELETE cascade,
  "deft_scope" text NOT NULL,
  "deft_scope_id" text NOT NULL,
  "runtime_session_key" text NOT NULL,
  "busy_mode" text DEFAULT 'queue' NOT NULL,
  "last_active_at" timestamp,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "agent_channel_delivery_attempts" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "agent_employee_id" text NOT NULL REFERENCES "agent_employees"("id") ON DELETE cascade,
  "event_id" text REFERENCES "agent_channel_events"("id") ON DELETE cascade,
  "direction" text NOT NULL,
  "idempotency_key" text,
  "status" text NOT NULL,
  "request_json" jsonb,
  "response_json" jsonb,
  "error" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "agent_channel_connection_employee_unique"
  ON "agent_channel_connections" ("org_id","agent_employee_id");
CREATE INDEX IF NOT EXISTS "agent_channel_connection_org_status_idx"
  ON "agent_channel_connections" ("org_id","status");
CREATE INDEX IF NOT EXISTS "agent_channel_connection_seen_idx"
  ON "agent_channel_connections" ("agent_employee_id","last_seen_at");

CREATE INDEX IF NOT EXISTS "agent_channel_tokens_org_idx"
  ON "agent_channel_tokens" ("org_id");
CREATE INDEX IF NOT EXISTS "agent_channel_tokens_employee_idx"
  ON "agent_channel_tokens" ("agent_employee_id");
CREATE INDEX IF NOT EXISTS "agent_channel_tokens_prefix_idx"
  ON "agent_channel_tokens" ("token_prefix");

CREATE UNIQUE INDEX IF NOT EXISTS "agent_channel_event_idempotency_unique"
  ON "agent_channel_events" ("org_id","agent_employee_id","idempotency_key");
CREATE INDEX IF NOT EXISTS "agent_channel_event_employee_status_idx"
  ON "agent_channel_events" ("agent_employee_id","status","created_at");
CREATE INDEX IF NOT EXISTS "agent_channel_event_org_kind_idx"
  ON "agent_channel_events" ("org_id","kind","created_at");
CREATE INDEX IF NOT EXISTS "agent_channel_event_space_idx"
  ON "agent_channel_events" ("space_id");

CREATE UNIQUE INDEX IF NOT EXISTS "agent_channel_cursor_employee_unique"
  ON "agent_channel_cursors" ("org_id","agent_employee_id");
CREATE INDEX IF NOT EXISTS "agent_channel_cursor_connection_idx"
  ON "agent_channel_cursors" ("connection_id");

CREATE UNIQUE INDEX IF NOT EXISTS "agent_channel_session_scope_unique"
  ON "agent_channel_sessions" ("org_id","agent_employee_id","deft_scope","deft_scope_id");
CREATE INDEX IF NOT EXISTS "agent_channel_session_runtime_idx"
  ON "agent_channel_sessions" ("agent_employee_id","runtime_session_key");

DROP INDEX IF EXISTS "agent_channel_attempt_idempotency_unique";
CREATE UNIQUE INDEX "agent_channel_attempt_idempotency_unique"
  ON "agent_channel_delivery_attempts" ("org_id","agent_employee_id","idempotency_key")
;
CREATE INDEX IF NOT EXISTS "agent_channel_attempt_event_idx"
  ON "agent_channel_delivery_attempts" ("event_id","created_at");
CREATE INDEX IF NOT EXISTS "agent_channel_attempt_employee_idx"
  ON "agent_channel_delivery_attempts" ("agent_employee_id","created_at");
