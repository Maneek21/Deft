-- Fresh-only historical contracts: called inside the initial ledger transaction.
-- No stored row updates and no existing ledgered target admission.
ALTER TABLE public."app_action_batches" ADD CONSTRAINT "app_action_batches_org_id_fkey" FOREIGN KEY (org_id) REFERENCES orgs(id);
ALTER TABLE public."app_integration_capture_claims" ADD CONSTRAINT "app_integration_capture_claims_body_digest_check" CHECK (body_digest ~ '^sha256:[a-f0-9]{64}$'::text);
ALTER TABLE public."app_integration_capture_claims" ADD CONSTRAINT "app_integration_capture_claims_policy_revision_check" CHECK (policy_revision > 0);
ALTER TABLE public."app_integration_capture_claims" ADD CONSTRAINT "app_integration_capture_claims_thread_key_check" CHECK (thread_key ~ '^sha256:[a-f0-9]{64}$'::text);
ALTER TABLE public."email_agent_grants" ADD CONSTRAINT "email_agent_grants_id_check" CHECK (id ~ '^[a-f0-9-]{36}$'::text);
ALTER TABLE public."email_agent_grants" ADD CONSTRAINT "email_agent_grants_operations_check" CHECK (jsonb_typeof(operations) = 'array'::text AND operations <@ '["read", "draft", "triage", "send"]'::jsonb);
ALTER TABLE public."email_agent_grants" ADD CONSTRAINT "email_agent_grants_principal_kind_check" CHECK (principal_kind = ANY (ARRAY['defty'::text, 'personal_mcp'::text]));
ALTER TABLE public."email_agent_grants" ADD CONSTRAINT "email_agent_grants_revision_check" CHECK (revision > 0);
ALTER TABLE public."email_knowledge_budgets" ADD CONSTRAINT "email_knowledge_budgets_org_id_fkey" FOREIGN KEY (org_id) REFERENCES orgs(id);
ALTER TABLE public."email_knowledge_observations" ADD CONSTRAINT "email_knowledge_observation_valid" CHECK (storage_revision >= 0 AND attempts >= 0 AND (state = ANY (ARRAY['captured'::text, 'updated'::text, 'skipped'::text, 'retry'::text, 'suppressed'::text, 'protected'::text])));
ALTER TABLE public."email_knowledge_policies" ADD CONSTRAINT "email_knowledge_destination_valid" CHECK (((destination ->> 'scope'::text) = ANY (ARRAY['user'::text, 'space'::text])) AND ((destination ->> 'scope'::text) = 'user'::text AND (destination -> 'space_id'::text) = 'null'::jsonb OR (destination ->> 'scope'::text) = 'space'::text AND length(destination ->> 'space_id'::text) > 0));
ALTER TABLE public."email_knowledge_sources" ADD CONSTRAINT "email_knowledge_source_valid" CHECK (content_digest ~ '^[a-f0-9]{64}$'::text AND thread_key ~ '^[a-f0-9]{64}$'::text AND source_digest ~ '^[a-f0-9]{64}$'::text AND policy_revision > 0 AND (provider = ANY (ARRAY['gmail'::text, 'microsoft'::text, 'imap_smtp'::text])));
ALTER TABLE public."email_knowledge_threads" ADD CONSTRAINT "email_knowledge_threads_page_id_fkey" FOREIGN KEY (page_id) REFERENCES wiki_pages(id);
ALTER TABLE public."app_integration_capture_claims" DROP CONSTRAINT "app_integration_capture_claim_valid";
ALTER TABLE public.users ALTER COLUMN notification_preferences SET DEFAULT '{"push": {"chat": true, "tasks": true, "agents": true, "enabled": false, "calendar": true, "approvals": true, "quiet_hours": {"end": "08:00", "start": "22:00", "enabled": false}}, "channels": {"chat": true, "tasks": true, "agents": true, "calendar": true, "approvals": true}, "keywords": []}'::jsonb;
