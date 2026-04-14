-- Phase 2 — action_receipts: HMAC-signed elevated action log with real FK to agent_actions.
-- Backfills any existing agent_actions rows as best-guess receipts so the
-- receipt viewer has a non-empty history after migration.
CREATE TABLE IF NOT EXISTS "action_receipts" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "action_id" text NOT NULL,
  "employee_id" text,
  "proposer" text NOT NULL,
  "proposer_id" text,
  "approver_id" text,
  "decision" text NOT NULL,
  "decision_reason" text,
  "action_name" text NOT NULL,
  "action_params_json" jsonb NOT NULL,
  "result_json" jsonb,
  "signature_hmac" text NOT NULL,
  "signed_at" timestamp DEFAULT now() NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "action_receipts"
    ADD CONSTRAINT "action_receipts_action_id_fk"
    FOREIGN KEY ("action_id") REFERENCES "agent_actions"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "action_receipts"
    ADD CONSTRAINT "action_receipts_employee_id_fk"
    FOREIGN KEY ("employee_id") REFERENCES "agent_employees"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "action_receipts"
    ADD CONSTRAINT "action_receipts_approver_id_fk"
    FOREIGN KEY ("approver_id") REFERENCES "users"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "receipt_org_idx"
  ON "action_receipts" ("org_id", "created_at");
CREATE INDEX IF NOT EXISTS "receipt_action_idx"
  ON "action_receipts" ("action_id");

-- Backfill: map existing agent_actions rows into receipts with a best-guess decision.
--   approved  -> auto_executed (closest match for legacy rows)
--   rejected  -> rejected
--   pending/expired/other -> expired
-- signature_hmac is set to 'backfill' as a sentinel so receipt-verification code
-- can filter legacy rows.
INSERT INTO "action_receipts" (
  "id", "org_id", "action_id", "employee_id", "proposer", "proposer_id",
  "approver_id", "decision", "decision_reason", "action_name",
  "action_params_json", "result_json", "signature_hmac", "signed_at",
  "created_at", "updated_at"
)
SELECT
  gen_random_uuid()::text,
  a.org_id,
  a.id,
  a.agent_employee_id,
  CASE WHEN a.agent_employee_id IS NOT NULL THEN 'employee' ELSE 'user' END,
  a.user_id,
  CASE WHEN a.approval_status = 'approved' THEN a.user_id ELSE NULL END,
  CASE
    WHEN a.approval_status = 'approved' THEN 'auto_executed'
    WHEN a.approval_status = 'rejected' THEN 'rejected'
    ELSE 'expired'
  END,
  'Backfilled from agent_actions during Phase 2 migration',
  a.action,
  a.params,
  a.result,
  'backfill',
  COALESCE(a.executed_at, a.created_at),
  a.created_at,
  a.updated_at
FROM "agent_actions" a
WHERE NOT EXISTS (
  SELECT 1 FROM "action_receipts" r WHERE r.action_id = a.id
);
