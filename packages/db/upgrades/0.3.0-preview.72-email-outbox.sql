-- Immutable encrypted queued MIME; dispatch starts at a durable row boundary.
CREATE TABLE IF NOT EXISTS email_outbox (
 org_id text NOT NULL,owner_user_id text NOT NULL,account_id text NOT NULL,outbox_id text NOT NULL,request_id text NOT NULL,operation_id text NOT NULL,
 draft_id text NOT NULL,draft_revision integer NOT NULL,revision integer NOT NULL DEFAULT 1,state text NOT NULL,job_id text NOT NULL,
 earliest_dispatch_at timestamptz NOT NULL,snapshot_envelope jsonb NOT NULL,state_envelope jsonb NOT NULL,mime_digest text NOT NULL,byte_length integer NOT NULL,
 ciphertext bytea NOT NULL,key_version text NOT NULL,nonce_b64 text NOT NULL,auth_tag_b64 text NOT NULL,attempt_id text,attempt_lock_hash text,started_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT email_outbox_pkey PRIMARY KEY(org_id,owner_user_id,account_id,outbox_id),
 CONSTRAINT email_outbox_draft_fk FOREIGN KEY(org_id,owner_user_id,account_id,draft_id) REFERENCES email_drafts(org_id,owner_user_id,account_id,draft_id) ON DELETE RESTRICT,
 CONSTRAINT email_outbox_request_unique UNIQUE(org_id,owner_user_id,account_id,request_id),
 CONSTRAINT email_outbox_operation_unique UNIQUE(org_id,owner_user_id,account_id,operation_id),
 CONSTRAINT email_outbox_draft_revision_unique UNIQUE(org_id,owner_user_id,account_id,draft_id,draft_revision),
 CONSTRAINT email_outbox_identity_check CHECK(outbox_id ~ '^[a-f0-9-]{36}$' AND request_id ~ '^[a-f0-9-]{36}$' AND operation_id ~ '^[a-f0-9-]{36}$' AND job_id ~ '^[a-f0-9-]{36}$' AND draft_revision>0 AND revision BETWEEN 1 AND 128 AND mime_digest ~ '^[a-f0-9]{64}$'),
 CONSTRAINT email_outbox_state_check CHECK(state IN ('queued','paused','submitting','accepted','uncertain','cancelled') AND ((state IN ('queued','paused','cancelled') AND attempt_id IS NULL AND attempt_lock_hash IS NULL AND started_at IS NULL) OR (state IN ('submitting','accepted','uncertain') AND attempt_id ~ '^[a-f0-9-]{36}$' AND attempt_lock_hash ~ '^[a-f0-9]{64}$' AND started_at IS NOT NULL))),
 CONSTRAINT email_outbox_bytes_check CHECK(byte_length BETWEEN 1 AND 36700160 AND octet_length(ciphertext)=byte_length AND char_length(key_version) BETWEEN 1 AND 64 AND char_length(nonce_b64)=16 AND char_length(auth_tag_b64)=24)
);
CREATE INDEX IF NOT EXISTS email_outbox_owner_idx ON email_outbox(org_id,owner_user_id,account_id,created_at,outbox_id);
CREATE TABLE IF NOT EXISTS email_outbox_events (
 org_id text NOT NULL,owner_user_id text NOT NULL,account_id text NOT NULL,outbox_id text NOT NULL,revision integer NOT NULL,envelope jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT email_outbox_events_pkey PRIMARY KEY(org_id,owner_user_id,account_id,outbox_id,revision),
 CONSTRAINT email_outbox_events_outbox_fk FOREIGN KEY(org_id,owner_user_id,account_id,outbox_id) REFERENCES email_outbox(org_id,owner_user_id,account_id,outbox_id) ON DELETE RESTRICT,
 CONSTRAINT email_outbox_events_revision_check CHECK(revision BETWEEN 1 AND 128)
);
CREATE OR REPLACE FUNCTION email_outbox_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.org_id,NEW.owner_user_id,NEW.account_id,NEW.outbox_id,NEW.request_id,NEW.operation_id,NEW.draft_id,NEW.draft_revision,NEW.job_id,NEW.snapshot_envelope,NEW.mime_digest,NEW.byte_length,NEW.ciphertext,NEW.key_version,NEW.nonce_b64,NEW.auth_tag_b64,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.org_id,OLD.owner_user_id,OLD.account_id,OLD.outbox_id,OLD.request_id,OLD.operation_id,OLD.draft_id,OLD.draft_revision,OLD.job_id,OLD.snapshot_envelope,OLD.mime_digest,OLD.byte_length,OLD.ciphertext,OLD.key_version,OLD.nonce_b64,OLD.auth_tag_b64,OLD.created_at) THEN RAISE EXCEPTION 'email outbox immutable snapshot'; END IF;
 IF NEW.revision<>OLD.revision+1 OR OLD.state IN ('accepted','uncertain','cancelled')
 OR (OLD.state='submitting' AND NEW.state NOT IN ('accepted','uncertain'))
 OR (OLD.state IN ('queued','paused') AND NEW.state NOT IN ('queued','paused','cancelled','submitting'))
 OR (OLD.attempt_id IS NOT NULL AND ROW(NEW.attempt_id,NEW.attempt_lock_hash,NEW.started_at) IS DISTINCT FROM ROW(OLD.attempt_id,OLD.attempt_lock_hash,OLD.started_at)) THEN RAISE EXCEPTION 'email outbox invalid transition'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS email_outbox_immutable_trigger ON email_outbox;
CREATE TRIGGER email_outbox_immutable_trigger BEFORE UPDATE ON email_outbox FOR EACH ROW EXECUTE FUNCTION email_outbox_immutable_guard();
CREATE OR REPLACE FUNCTION email_outbox_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'email outbox events append only'; END $$;
DROP TRIGGER IF EXISTS email_outbox_events_append_only_trigger ON email_outbox_events;
CREATE TRIGGER email_outbox_events_append_only_trigger BEFORE UPDATE OR DELETE ON email_outbox_events FOR EACH ROW EXECUTE FUNCTION email_outbox_events_append_only();
