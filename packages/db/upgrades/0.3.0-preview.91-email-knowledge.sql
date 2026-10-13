CREATE TABLE IF NOT EXISTS email_knowledge_policies (
 org_id text NOT NULL, owner_user_id text NOT NULL, account_id text NOT NULL, enabled boolean NOT NULL DEFAULT false, revision integer NOT NULL DEFAULT 1,
 destination jsonb NOT NULL, history_days integer NOT NULL DEFAULT 30, include_bulk boolean NOT NULL DEFAULT false, excluded_senders jsonb NOT NULL DEFAULT '[]',excluded_folders jsonb NOT NULL DEFAULT '[]',history_since timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(org_id,owner_user_id,account_id),
 FOREIGN KEY(org_id,owner_user_id,account_id) REFERENCES email_accounts(org_id,owner_user_id,account_id),CONSTRAINT email_knowledge_policy_valid CHECK(revision>0 AND history_days BETWEEN 1 AND 365),
 CONSTRAINT email_knowledge_destination_valid CHECK(destination->>'scope' IN ('user','space') AND ((destination->>'scope'='user' AND destination->'space_id'='null'::jsonb) OR (destination->>'scope'='space' AND length(destination->>'space_id')>0)))
);
CREATE TABLE IF NOT EXISTS email_knowledge_observations (
 org_id text NOT NULL,owner_user_id text NOT NULL,account_id text NOT NULL,logical_message_id text NOT NULL,storage_revision integer NOT NULL DEFAULT 0,policy_revision integer NOT NULL DEFAULT 0,content_digest text,thread_key text,
 state text NOT NULL DEFAULT 'retry',suppressed boolean NOT NULL DEFAULT false,last_error_code text,retry_at timestamptz,attempts integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(org_id,owner_user_id,account_id,logical_message_id),FOREIGN KEY(org_id,owner_user_id,account_id) REFERENCES email_accounts(org_id,owner_user_id,account_id),
 CONSTRAINT email_knowledge_observation_valid CHECK(storage_revision>=0 AND attempts>=0 AND state IN ('captured','updated','skipped','retry','suppressed','protected'))
);
CREATE TABLE IF NOT EXISTS email_knowledge_sources (
 id text PRIMARY KEY,org_id text NOT NULL,owner_user_id text NOT NULL,account_id text NOT NULL,logical_message_id text NOT NULL,message_revision text NOT NULL,thread_key text NOT NULL,content_digest text NOT NULL,policy_revision integer NOT NULL,provider text NOT NULL,source_digest text NOT NULL,sender text NOT NULL,received_at timestamptz,partial boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(org_id,owner_user_id,account_id) REFERENCES email_accounts(org_id,owner_user_id,account_id),CONSTRAINT email_knowledge_sources_identity UNIQUE(org_id,owner_user_id,account_id,logical_message_id,content_digest,policy_revision),
 CONSTRAINT email_knowledge_source_valid CHECK(content_digest ~ '^[a-f0-9]{64}$' AND thread_key ~ '^[a-f0-9]{64}$' AND source_digest ~ '^[a-f0-9]{64}$' AND policy_revision>0 AND provider IN ('gmail','microsoft','imap_smtp'))
);
CREATE OR REPLACE FUNCTION email_knowledge_source_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Email knowledge sources are immutable'; END $$;
DROP TRIGGER IF EXISTS email_knowledge_source_immutable_trigger ON email_knowledge_sources;
CREATE TRIGGER email_knowledge_source_immutable_trigger BEFORE UPDATE OR DELETE ON email_knowledge_sources FOR EACH ROW EXECUTE FUNCTION email_knowledge_source_immutable();
CREATE TABLE IF NOT EXISTS email_knowledge_threads (
 org_id text NOT NULL,owner_user_id text NOT NULL,account_id text NOT NULL,thread_key text NOT NULL,destination_key text NOT NULL,page_id text NOT NULL REFERENCES wiki_pages(id),page_version integer NOT NULL,last_source_order text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(org_id,owner_user_id,account_id,thread_key,destination_key),FOREIGN KEY(org_id,owner_user_id,account_id) REFERENCES email_accounts(org_id,owner_user_id,account_id)
);
CREATE TABLE IF NOT EXISTS email_knowledge_budgets (
 org_id text NOT NULL REFERENCES orgs(id),day text NOT NULL,budget_key text NOT NULL,reserved_tokens integer NOT NULL DEFAULT 0 CHECK(reserved_tokens>=0),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(org_id,day,budget_key)
);
