-- Phase 2 — agent_session_turns: one row per OpenClaw turn (session inspector feed).
-- Cost is computed on read from (model_name, tokens_in, tokens_out) against a
-- model_pricing lookup table; we intentionally do not store cost per row.
CREATE TABLE IF NOT EXISTS "agent_session_turns" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "employee_id" text NOT NULL,
  "trigger_kind" text NOT NULL,
  "triggering_message_id" text,
  "space_id" text,
  "input_messages_json" jsonb NOT NULL,
  "raw_reply_text" text,
  "tool_calls_json" jsonb,
  "latency_ms" integer NOT NULL,
  "model_name" text,
  "tokens_in" integer,
  "tokens_out" integer,
  "result" text NOT NULL,
  "error" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "agent_session_turns"
    ADD CONSTRAINT "agent_session_turns_employee_id_fk"
    FOREIGN KEY ("employee_id") REFERENCES "agent_employees"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "ast_employee_idx"
  ON "agent_session_turns" ("employee_id", "created_at");
CREATE INDEX IF NOT EXISTS "ast_org_idx"
  ON "agent_session_turns" ("org_id", "created_at");
