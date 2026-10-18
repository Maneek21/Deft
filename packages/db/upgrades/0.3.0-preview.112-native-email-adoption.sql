-- Host112: permanent native account write fence and independently reviewed adoption publication.

-- Operator-owned authority metadata; never grant marker mutation to native writers.
CREATE TABLE IF NOT EXISTS native_email_adoptions (
 org_id text NOT NULL, owner_user_id text NOT NULL, account_id text NOT NULL,
 adoption_id uuid NOT NULL UNIQUE,
 revision integer NOT NULL CHECK(revision BETWEEN 1 AND 2147483647),
 state text NOT NULL CHECK(state IN ('native_frozen','runtime_prepared','runtime_active','archive_only')),
 source_generation integer NOT NULL CHECK(source_generation>0),
 source_authority_revision integer NOT NULL CHECK(source_authority_revision>0),
 source_consent_revision integer NOT NULL CHECK(source_consent_revision>0),
 source_principal_digest text NOT NULL CHECK(source_principal_digest ~ '^[a-f0-9]{64}$'),
 source_binding_digest text NOT NULL CHECK(source_binding_digest ~ '^[a-f0-9]{64}$'),
 snapshot_digest text CHECK(snapshot_digest ~ '^[a-f0-9]{64}$'),
 destination_binding_digest text CHECK(destination_binding_digest ~ '^[a-f0-9]{64}$'),
 destination_admission_digest text CHECK(destination_admission_digest ~ '^[a-f0-9]{64}$'),
 runtime_receipt_digest text CHECK(runtime_receipt_digest ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
 CONSTRAINT native_email_adoptions_pkey PRIMARY KEY(org_id,owner_user_id,account_id),
 CONSTRAINT native_email_adoptions_account_fk FOREIGN KEY(org_id,owner_user_id,account_id) REFERENCES email_accounts(org_id,owner_user_id,account_id) ON DELETE RESTRICT,
 CHECK(length(account_id) BETWEEN 1 AND 256 AND account_id ~ '^[A-Za-z0-9_-]+$'),
 CHECK(updated_at>=created_at),
 CHECK(state NOT IN ('runtime_prepared','runtime_active') OR (snapshot_digest IS NOT NULL AND destination_binding_digest IS NOT NULL AND destination_admission_digest IS NOT NULL)),
 CHECK(state<>'runtime_active' OR runtime_receipt_digest IS NOT NULL)
);

CREATE OR REPLACE FUNCTION native_email_adoption_scope_lock(p_org text,p_owner text,p_account text) RETURNS bigint
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,public,pg_temp AS $$ SELECT hashtextextended(jsonb_build_array('native-email-adoption-v1',p_org,p_owner,p_account)::text,0) $$;

CREATE OR REPLACE FUNCTION native_email_assert_write(p_org text,p_owner text,p_account text) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN
 IF p_org IS NULL OR p_owner IS NULL OR p_account IS NULL THEN RAISE EXCEPTION 'EMAIL_NATIVE_SCOPE_REQUIRED'; END IF;
 -- Absent marker is also fenced against a concurrent operator freeze.
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('native-email-adoption-global-v1',0));
 PERFORM pg_advisory_xact_lock_shared(public.native_email_adoption_scope_lock(p_org,p_owner,p_account));
 IF EXISTS(SELECT 1 FROM public.native_email_adoptions WHERE org_id=p_org AND owner_user_id=p_owner AND account_id=p_account) THEN
  RAISE EXCEPTION 'EMAIL_NATIVE_ACCOUNT_ADOPTED_READ_ONLY' USING ERRCODE='55000';
 END IF;
END $$;

CREATE OR REPLACE FUNCTION native_email_guard_row() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE old_scope jsonb; new_scope jsonb; selected jsonb;
BEGIN
 IF TG_OP<>'INSERT' THEN old_scope=jsonb_build_array(OLD.org_id,OLD.owner_user_id,OLD.account_id); END IF;
 IF TG_OP<>'DELETE' THEN new_scope=jsonb_build_array(NEW.org_id,NEW.owner_user_id,NEW.account_id); END IF;
 FOR selected IN SELECT DISTINCT value FROM unnest(ARRAY[old_scope,new_scope]) value WHERE value IS NOT NULL ORDER BY value LOOP
  PERFORM native_email_assert_write(selected->>0,selected->>1,selected->>2);
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;

CREATE OR REPLACE FUNCTION native_email_guard_truncate() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('native-email-adoption-global-v1',0));
 IF EXISTS(SELECT 1 FROM public.native_email_adoptions) THEN RAISE EXCEPTION 'EMAIL_NATIVE_ACCOUNT_ADOPTED_READ_ONLY' USING ERRCODE='55000'; END IF;
 RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION native_email_guard_marker() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN
 IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'EMAIL_NATIVE_ADOPTION_MARKER_RETAINED'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'native_frozen' OR NEW.revision<>1 OR NEW.snapshot_digest IS NOT NULL OR NEW.destination_binding_digest IS NOT NULL OR NEW.destination_admission_digest IS NOT NULL OR NEW.runtime_receipt_digest IS NOT NULL THEN RAISE EXCEPTION 'EMAIL_NATIVE_ADOPTION_FREEZE_REQUIRED'; END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['revision','state','snapshot_digest','destination_binding_digest','destination_admission_digest','runtime_receipt_digest','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['revision','state','snapshot_digest','destination_binding_digest','destination_admission_digest','runtime_receipt_digest','updated_at'])
    OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at
    OR NOT ((OLD.state='native_frozen' AND NEW.state IN ('runtime_prepared','archive_only')) OR (OLD.state='runtime_prepared' AND NEW.state IN ('runtime_active','archive_only')) OR (OLD.state='runtime_active' AND NEW.state='archive_only'))
    OR (OLD.snapshot_digest IS NOT NULL AND NEW.snapshot_digest IS DISTINCT FROM OLD.snapshot_digest)
    OR (OLD.destination_binding_digest IS NOT NULL AND NEW.destination_binding_digest IS DISTINCT FROM OLD.destination_binding_digest)
    OR (OLD.destination_admission_digest IS NOT NULL AND NEW.destination_admission_digest IS DISTINCT FROM OLD.destination_admission_digest)
    OR (OLD.runtime_receipt_digest IS NOT NULL AND NEW.runtime_receipt_digest IS DISTINCT FROM OLD.runtime_receipt_digest)
  THEN RAISE EXCEPTION 'EMAIL_NATIVE_ADOPTION_TRANSITION_DENIED'; END IF;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('native-email-adoption-global-v1',0));
 PERFORM pg_advisory_xact_lock(public.native_email_adoption_scope_lock(NEW.org_id,NEW.owner_user_id,NEW.account_id));
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS native_email_marker_row ON native_email_adoptions;
CREATE TRIGGER native_email_marker_row BEFORE INSERT OR UPDATE OR DELETE ON native_email_adoptions FOR EACH ROW EXECUTE FUNCTION native_email_guard_marker();
DROP TRIGGER IF EXISTS native_email_marker_truncate ON native_email_adoptions;
CREATE TRIGGER native_email_marker_truncate BEFORE TRUNCATE ON native_email_adoptions FOR EACH STATEMENT EXECUTE FUNCTION native_email_guard_marker();

-- Proposed companion to native-adoption-fence.sql; root allocates migration identity.
CREATE TABLE IF NOT EXISTS native_email_adoption_destinations (
 org_id text NOT NULL, owner_user_id text NOT NULL, account_id text NOT NULL,
 adoption_id uuid NOT NULL, session_id text NOT NULL,
 admission jsonb NOT NULL CHECK(jsonb_typeof(admission)='object' AND octet_length(admission::text)<=32768),
 profile jsonb NOT NULL CHECK(jsonb_typeof(profile)='object' AND octet_length(profile::text)<=16384),
 receipt jsonb CHECK(receipt IS NULL OR jsonb_typeof(receipt)='object' AND octet_length(receipt::text)<=16384),
 created_at timestamptz NOT NULL, published_at timestamptz,
 CONSTRAINT native_email_adoption_destinations_pkey PRIMARY KEY(org_id,owner_user_id,account_id), CONSTRAINT native_email_adoption_destinations_session_key UNIQUE(org_id,owner_user_id,session_id),
 CONSTRAINT native_email_adoption_destinations_account_fk FOREIGN KEY(org_id,owner_user_id,account_id) REFERENCES native_email_adoptions(org_id,owner_user_id,account_id) ON DELETE RESTRICT,
 CHECK((receipt IS NULL)=(published_at IS NULL))
);
CREATE OR REPLACE FUNCTION native_email_guard_destination() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE marker public.native_email_adoptions%ROWTYPE;
BEGIN
 IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'EMAIL_NATIVE_ADOPTION_DESTINATION_RETAINED'; END IF;
 SELECT * INTO marker FROM public.native_email_adoptions WHERE org_id=NEW.org_id AND owner_user_id=NEW.owner_user_id AND account_id=NEW.account_id FOR UPDATE;
 IF NOT FOUND OR marker.adoption_id IS DISTINCT FROM NEW.adoption_id
  OR NEW.admission->>'schema_version' IS DISTINCT FROM 'email.native_activation_admission.v1'
  OR NEW.admission->>'adoption_id' IS DISTINCT FROM NEW.adoption_id::text
  OR NEW.admission->>'session_id' IS DISTINCT FROM NEW.session_id
  OR NEW.admission->'scope' IS DISTINCT FROM jsonb_build_object('org_id',NEW.org_id,'owner_user_id',NEW.owner_user_id,'account_id',NEW.account_id)
  OR NEW.admission->>'source_principal_digest' IS DISTINCT FROM marker.source_principal_digest
  OR NEW.admission->'destination_scope'->>'org_id' IS DISTINCT FROM NEW.org_id
  OR NEW.admission->'destination_scope'->>'owner_user_id' IS DISTINCT FROM NEW.owner_user_id
  OR NEW.admission->'destination_binding'->>'account_id' IS DISTINCT FROM NEW.account_id THEN
  RAISE EXCEPTION 'EMAIL_NATIVE_ADOPTION_DESTINATION_SCOPE';
 END IF;
 IF TG_OP='INSERT' AND (marker.state<>'native_frozen' OR NEW.receipt IS NOT NULL OR NEW.published_at IS NOT NULL) THEN
  RAISE EXCEPTION 'EMAIL_NATIVE_ADOPTION_DESTINATION_PREPARE_REQUIRED';
 END IF;
 IF TG_OP='UPDATE' AND ((to_jsonb(NEW)-ARRAY['receipt','published_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['receipt','published_at'])
  OR OLD.receipt IS NOT NULL OR NEW.receipt IS NULL OR NEW.published_at IS NULL OR NEW.published_at<OLD.created_at) THEN
  RAISE EXCEPTION 'EMAIL_NATIVE_ADOPTION_DESTINATION_IMMUTABLE';
 END IF;
 IF TG_OP='UPDATE' AND (marker.state<>'runtime_prepared'
  OR NEW.receipt->>'schema_version' IS DISTINCT FROM 'email.native_activation_receipt.v1'
  OR NEW.receipt->>'adoption_id' IS DISTINCT FROM NEW.adoption_id::text
  OR NEW.receipt->>'session_id' IS DISTINCT FROM NEW.session_id
  OR NEW.receipt->>'snapshot_digest' IS DISTINCT FROM marker.snapshot_digest
  OR NEW.receipt->>'admission_digest' IS DISTINCT FROM marker.destination_admission_digest
  OR NEW.receipt->>'principal_digest' IS DISTINCT FROM marker.source_principal_digest
  OR NEW.receipt->'account'->>'account_ref' IS DISTINCT FROM NEW.account_id) THEN
  RAISE EXCEPTION 'EMAIL_NATIVE_ADOPTION_DESTINATION_RECEIPT';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS native_email_destination_row ON native_email_adoption_destinations;
CREATE TRIGGER native_email_destination_row BEFORE INSERT OR UPDATE OR DELETE ON native_email_adoption_destinations FOR EACH ROW EXECUTE FUNCTION native_email_guard_destination();
DROP TRIGGER IF EXISTS native_email_destination_truncate ON native_email_adoption_destinations;
CREATE TRIGGER native_email_destination_truncate BEFORE TRUNCATE ON native_email_adoption_destinations FOR EACH STATEMENT EXECUTE FUNCTION native_email_guard_destination();

-- Generated from sealed Host109p3 catalog: exactly 36 account-scoped native tables.
DROP TRIGGER IF EXISTS native_email_adoption_write_guard ON email_account_consents;
CREATE TRIGGER native_email_adoption_write_guard BEFORE INSERT OR UPDATE OR DELETE ON email_account_consents FOR EACH ROW EXECUTE FUNCTION native_email_guard_row();
DROP TRIGGER IF EXISTS native_email_adoption_truncate_guard ON email_account_consents;
CREATE TRIGGER native_email_adoption_truncate_guard BEFORE TRUNCATE ON email_account_consents FOR EACH STATEMENT EXECUTE FUNCTION native_email_guard_truncate();
DROP TRIGGER IF EXISTS native_email_adoption_write_guard ON email_accounts;
CREATE TRIGGER native_email_adoption_write_guard BEFORE INSERT OR UPDATE OR DELETE ON email_accounts FOR EACH ROW EXECUTE FUNCTION native_email_guard_row();
DROP TRIGGER IF EXISTS native_email_adoption_truncate_guard ON email_accounts;
CREATE TRIGGER native_email_adoption_truncate_guard BEFORE TRUNCATE ON email_accounts FOR EACH STATEMENT EXECUTE FUNCTION native_email_guard_truncate();
DROP TRIGGER IF EXISTS native_email_adoption_write_guard ON email_agent_grants;
CREATE TRIGGER native_email_adoption_write_guard BEFORE INSERT OR UPDATE OR DELETE ON email_agent_grants FOR EACH ROW EXECUTE FUNCTION native_email_guard_row();
DROP TRIGGER IF EXISTS native_email_adoption_truncate_guard ON email_agent_grants;
CREATE TRIGGER native_email_adoption_truncate_guard BEFORE TRUNCATE ON email_agent_grants FOR EACH STATEMENT EXECUTE FUNCTION native_email_guard_truncate();
DROP TRIGGER IF EXISTS native_email_adoption_write_guard ON email_attachments;
CREATE TRIGGER native_email_adoption_write_guard BEFORE INSERT OR UPDATE OR DELETE ON email_attachments FOR EACH ROW EXECUTE FUNCTION native_email_guard_row();
DROP TRIGGER IF EXISTS native_email_adoption_truncate_guard ON email_attachments;
CREATE TRIGGER native_email_adoption_truncate_guard BEFORE TRUNCATE ON email_attachments FOR EACH STATEMENT EXECUTE FUNCTION native_email_guard_truncate();
DROP TRIGGER IF EXISTS native_email_adoption_write_guard ON email_calendar_invitation_actions;
CREATE TRIGGER native_email_adoption_write_guard BEFORE INSERT OR UPDATE OR DELETE ON email_calendar_invitation_actions FOR EACH ROW EXECUTE FUNCTION native_email_guard_row();
DROP TRIGGER IF EXISTS native_email_adoption_truncate_guard ON email_calendar_invitation_actions;
CREATE TRIGGER native_email_adoption_truncate_guard BEFORE TRUNCATE ON email_calendar_invitation_actions FOR EACH STATEMENT EXECUTE FUNCTION native_email_guard_truncate();
DROP TRIGGER IF EXISTS native_email_adoption_write_guard ON email_calendar_invitations;
CREATE TRIGGER native_email_adoption_write_guard BEFORE INSERT OR UPDATE OR DELETE ON email_calendar_invitations FOR EACH ROW EXECUTE FUNCTION native_email_guard_row();
DROP TRIGGER IF EXISTS native_email_adoption_truncate_guard ON email_calendar_invitations;
CREATE TRIGGER native_email_adoption_truncate_guard BEFORE TRUNCATE ON email_calendar_invitations FOR EACH STATEMENT EXECUTE FUNCTION native_email_guard_truncate();
DROP TRIGGER IF EXISTS native_email_adoption_write_guard ON email_checkpoints;
CREATE TRIGGER native_email_adoption_write_guard BEFORE INSERT OR UPDATE OR DELETE ON email_checkpoints FOR EACH ROW EXECUTE FUNCTION native_email_guard_row();
DROP TRIGGER IF EXISTS native_email_adoption_truncate_guard ON email_checkpoints;
CREATE TRIGGER native_email_adoption_truncate_guard BEFORE TRUNCATE ON email_checkpoints FOR EACH STATEMENT EXECUTE FUNCTION native_email_guard_truncate();
DROP TRIGGER IF EXISTS native_email_adoption_write_guard ON email_context_transfers;
CREATE TRIGGER native_email_adoption_write_guard BEFORE INSERT OR UPDATE OR DELETE ON email_context_transfers FOR EACH ROW EXECUTE FUNCTION native_email_guard_row();
DROP TRIGGER IF EXISTS native_email_adoption_truncate_guard ON email_context_transfers;
CREATE TRIGGER native_email_adoption_truncate_guard BEFORE TRUNCATE ON email_context_transfers FOR EACH STATEMENT EXECUTE FUNCTION native_email_guard_truncate();
DROP TRIGGER IF EXISTS native_email_adoption_write_guard ON email_drafts;
CREATE TRIGGER native_email_adoption_write_guard BEFORE INSERT OR UPDATE OR DELETE ON email_drafts FOR EACH ROW EXECUTE FUNCTION native_email_guard_row();
DROP TRIGGER IF EXISTS native_email_adoption_truncate_guard ON email_drafts;
CREATE TRIGGER native_email_adoption_truncate_guard BEFORE TRUNCATE ON email_drafts FOR EACH STATEMENT EXECUTE FUNCTION native_email_guard_truncate();
DROP TRIGGER IF EXISTS native_email_adoption_write_guard ON email_imap_aliases;
CREATE TRIGGER native_email_adoption_write_guard BEFORE INSERT OR UPDATE OR DELETE ON email_imap_aliases FOR EACH ROW EXECUTE FUNCTION native_email_guard_row();
DROP TRIGGER IF EXISTS native_email_adoption_truncate_guard ON email_imap_aliases;
CREATE TRIGGER native_email_adoption_truncate_guard BEFORE TRUNCATE ON email_imap_aliases FOR EACH STATEMENT EXECUTE FUNCTION native_email_guard_truncate();
DROP TRIGGER IF EXISTS native_email_adoption_write_guard ON email_imap_credentials;
CREATE TRIGGER native_email_adoption_write_guard BEFORE INSERT OR UPDATE OR DELETE ON email_imap_credentials FOR EACH ROW EXECUTE FUNCTION native_email_guard_row();
DROP TRIGGER IF EXISTS native_email_adoption_truncate_guard ON email_imap_credentials;
CREATE TRIGGER native_email_adoption_truncate_guard BEFORE TRUNCATE ON email_imap_credentials FOR EACH STATEMENT EXECUTE FUNCTION native_email_guard_truncate();
DROP TRIGGER IF EXISTS native_email_adoption_write_guard ON email_imap_move_reservations;
CREATE TRIGGER native_email_adoption_write_guard BEFORE INSERT OR UPDATE OR DELETE ON email_imap_move_reservations FOR EACH ROW EXECUTE FUNCTION native_email_guard_row();
DROP TRIGGER IF EXISTS native_email_adoption_truncate_guard ON email_imap_move_reservations;
CREATE TRIGGER native_email_adoption_truncate_guard BEFORE TRUNCATE ON email_imap_move_reservations FOR EACH STATEMENT EXECUTE FUNCTION native_email_guard_truncate();
DROP TRIGGER IF EXISTS native_email_adoption_write_guard ON email_knowledge_observations;
CREATE TRIGGER native_email_adoption_write_guard BEFORE INSERT OR UPDATE OR DELETE ON email_knowledge_observations FOR EACH ROW EXECUTE FUNCTION native_email_guard_row();
DROP TRIGGER IF EXISTS native_email_adoption_truncate_guard ON email_knowledge_observations;
CREATE TRIGGER native_email_adoption_truncate_guard BEFORE TRUNCATE ON email_knowledge_observations FOR EACH STATEMENT EXECUTE FUNCTION native_email_guard_truncate();
DROP TRIGGER IF EXISTS native_email_adoption_write_guard ON email_knowledge_policies;
CREATE TRIGGER native_email_adoption_write_guard BEFORE INSERT OR UPDATE OR DELETE ON email_knowledge_policies FOR EACH ROW EXECUTE FUNCTION native_email_guard_row();
DROP TRIGGER IF EXISTS native_email_adoption_truncate_guard ON email_knowledge_policies;
CREATE TRIGGER native_email_adoption_truncate_guard BEFORE TRUNCATE ON email_knowledge_policies FOR EACH STATEMENT EXECUTE FUNCTION native_email_guard_truncate();
DROP TRIGGER IF EXISTS native_email_adoption_write_guard ON email_knowledge_sources;
CREATE TRIGGER native_email_adoption_write_guard BEFORE INSERT OR UPDATE OR DELETE ON email_knowledge_sources FOR EACH ROW EXECUTE FUNCTION native_email_guard_row();
DROP TRIGGER IF EXISTS native_email_adoption_truncate_guard ON email_knowledge_sources;
CREATE TRIGGER native_email_adoption_truncate_guard BEFORE TRUNCATE ON email_knowledge_sources FOR EACH STATEMENT EXECUTE FUNCTION native_email_guard_truncate();
DROP TRIGGER IF EXISTS native_email_adoption_write_guard ON email_knowledge_threads;
CREATE TRIGGER native_email_adoption_write_guard BEFORE INSERT OR UPDATE OR DELETE ON email_knowledge_threads FOR EACH ROW EXECUTE FUNCTION native_email_guard_row();
DROP TRIGGER IF EXISTS native_email_adoption_truncate_guard ON email_knowledge_threads;
CREATE TRIGGER native_email_adoption_truncate_guard BEFORE TRUNCATE ON email_knowledge_threads FOR EACH STATEMENT EXECUTE FUNCTION native_email_guard_truncate();
DROP TRIGGER IF EXISTS native_email_adoption_write_guard ON email_memberships;
CREATE TRIGGER native_email_adoption_write_guard BEFORE INSERT OR UPDATE OR DELETE ON email_memberships FOR EACH ROW EXECUTE FUNCTION native_email_guard_row();
DROP TRIGGER IF EXISTS native_email_adoption_truncate_guard ON email_memberships;
CREATE TRIGGER native_email_adoption_truncate_guard BEFORE TRUNCATE ON email_memberships FOR EACH STATEMENT EXECUTE FUNCTION native_email_guard_truncate();
DROP TRIGGER IF EXISTS native_email_adoption_write_guard ON email_messages;
CREATE TRIGGER native_email_adoption_write_guard BEFORE INSERT OR UPDATE OR DELETE ON email_messages FOR EACH ROW EXECUTE FUNCTION native_email_guard_row();
DROP TRIGGER IF EXISTS native_email_adoption_truncate_guard ON email_messages;
CREATE TRIGGER native_email_adoption_truncate_guard BEFORE TRUNCATE ON email_messages FOR EACH STATEMENT EXECUTE FUNCTION native_email_guard_truncate();
DROP TRIGGER IF EXISTS native_email_adoption_write_guard ON email_native_account_connections;
CREATE TRIGGER native_email_adoption_write_guard BEFORE INSERT OR UPDATE OR DELETE ON email_native_account_connections FOR EACH ROW EXECUTE FUNCTION native_email_guard_row();
DROP TRIGGER IF EXISTS native_email_adoption_truncate_guard ON email_native_account_connections;
CREATE TRIGGER native_email_adoption_truncate_guard BEFORE TRUNCATE ON email_native_account_connections FOR EACH STATEMENT EXECUTE FUNCTION native_email_guard_truncate();
DROP TRIGGER IF EXISTS native_email_adoption_write_guard ON email_native_connection_requests;
CREATE TRIGGER native_email_adoption_write_guard BEFORE INSERT OR UPDATE OR DELETE ON email_native_connection_requests FOR EACH ROW EXECUTE FUNCTION native_email_guard_row();
DROP TRIGGER IF EXISTS native_email_adoption_truncate_guard ON email_native_connection_requests;
CREATE TRIGGER native_email_adoption_truncate_guard BEFORE TRUNCATE ON email_native_connection_requests FOR EACH STATEMENT EXECUTE FUNCTION native_email_guard_truncate();
DROP TRIGGER IF EXISTS native_email_adoption_write_guard ON email_notification_events;
CREATE TRIGGER native_email_adoption_write_guard BEFORE INSERT OR UPDATE OR DELETE ON email_notification_events FOR EACH ROW EXECUTE FUNCTION native_email_guard_row();
DROP TRIGGER IF EXISTS native_email_adoption_truncate_guard ON email_notification_events;
CREATE TRIGGER native_email_adoption_truncate_guard BEFORE TRUNCATE ON email_notification_events FOR EACH STATEMENT EXECUTE FUNCTION native_email_guard_truncate();
DROP TRIGGER IF EXISTS native_email_adoption_write_guard ON email_notification_states;
CREATE TRIGGER native_email_adoption_write_guard BEFORE INSERT OR UPDATE OR DELETE ON email_notification_states FOR EACH ROW EXECUTE FUNCTION native_email_guard_row();
DROP TRIGGER IF EXISTS native_email_adoption_truncate_guard ON email_notification_states;
CREATE TRIGGER native_email_adoption_truncate_guard BEFORE TRUNCATE ON email_notification_states FOR EACH STATEMENT EXECUTE FUNCTION native_email_guard_truncate();
DROP TRIGGER IF EXISTS native_email_adoption_write_guard ON email_operations;
CREATE TRIGGER native_email_adoption_write_guard BEFORE INSERT OR UPDATE OR DELETE ON email_operations FOR EACH ROW EXECUTE FUNCTION native_email_guard_row();
DROP TRIGGER IF EXISTS native_email_adoption_truncate_guard ON email_operations;
CREATE TRIGGER native_email_adoption_truncate_guard BEFORE TRUNCATE ON email_operations FOR EACH STATEMENT EXECUTE FUNCTION native_email_guard_truncate();
DROP TRIGGER IF EXISTS native_email_adoption_write_guard ON email_outbox;
CREATE TRIGGER native_email_adoption_write_guard BEFORE INSERT OR UPDATE OR DELETE ON email_outbox FOR EACH ROW EXECUTE FUNCTION native_email_guard_row();
DROP TRIGGER IF EXISTS native_email_adoption_truncate_guard ON email_outbox;
CREATE TRIGGER native_email_adoption_truncate_guard BEFORE TRUNCATE ON email_outbox FOR EACH STATEMENT EXECUTE FUNCTION native_email_guard_truncate();
DROP TRIGGER IF EXISTS native_email_adoption_write_guard ON email_outbox_events;
CREATE TRIGGER native_email_adoption_write_guard BEFORE INSERT OR UPDATE OR DELETE ON email_outbox_events FOR EACH ROW EXECUTE FUNCTION native_email_guard_row();
DROP TRIGGER IF EXISTS native_email_adoption_truncate_guard ON email_outbox_events;
CREATE TRIGGER native_email_adoption_truncate_guard BEFORE TRUNCATE ON email_outbox_events FOR EACH STATEMENT EXECUTE FUNCTION native_email_guard_truncate();
DROP TRIGGER IF EXISTS native_email_adoption_write_guard ON email_presentation_cache;
CREATE TRIGGER native_email_adoption_write_guard BEFORE INSERT OR UPDATE OR DELETE ON email_presentation_cache FOR EACH ROW EXECUTE FUNCTION native_email_guard_row();
DROP TRIGGER IF EXISTS native_email_adoption_truncate_guard ON email_presentation_cache;
CREATE TRIGGER native_email_adoption_truncate_guard BEFORE TRUNCATE ON email_presentation_cache FOR EACH STATEMENT EXECUTE FUNCTION native_email_guard_truncate();
DROP TRIGGER IF EXISTS native_email_adoption_write_guard ON email_provider_draft_mirrors;
CREATE TRIGGER native_email_adoption_write_guard BEFORE INSERT OR UPDATE OR DELETE ON email_provider_draft_mirrors FOR EACH ROW EXECUTE FUNCTION native_email_guard_row();
DROP TRIGGER IF EXISTS native_email_adoption_truncate_guard ON email_provider_draft_mirrors;
CREATE TRIGGER native_email_adoption_truncate_guard BEFORE TRUNCATE ON email_provider_draft_mirrors FOR EACH STATEMENT EXECUTE FUNCTION native_email_guard_truncate();
DROP TRIGGER IF EXISTS native_email_adoption_write_guard ON email_provider_states;
CREATE TRIGGER native_email_adoption_write_guard BEFORE INSERT OR UPDATE OR DELETE ON email_provider_states FOR EACH ROW EXECUTE FUNCTION native_email_guard_row();
DROP TRIGGER IF EXISTS native_email_adoption_truncate_guard ON email_provider_states;
CREATE TRIGGER native_email_adoption_truncate_guard BEFORE TRUNCATE ON email_provider_states FOR EACH STATEMENT EXECUTE FUNCTION native_email_guard_truncate();
DROP TRIGGER IF EXISTS native_email_adoption_write_guard ON email_reading_preferences;
CREATE TRIGGER native_email_adoption_write_guard BEFORE INSERT OR UPDATE OR DELETE ON email_reading_preferences FOR EACH ROW EXECUTE FUNCTION native_email_guard_row();
DROP TRIGGER IF EXISTS native_email_adoption_truncate_guard ON email_reading_preferences;
CREATE TRIGGER native_email_adoption_truncate_guard BEFORE TRUNCATE ON email_reading_preferences FOR EACH STATEMENT EXECUTE FUNCTION native_email_guard_truncate();
DROP TRIGGER IF EXISTS native_email_adoption_write_guard ON email_rule_receipts;
CREATE TRIGGER native_email_adoption_write_guard BEFORE INSERT OR UPDATE OR DELETE ON email_rule_receipts FOR EACH ROW EXECUTE FUNCTION native_email_guard_row();
DROP TRIGGER IF EXISTS native_email_adoption_truncate_guard ON email_rule_receipts;
CREATE TRIGGER native_email_adoption_truncate_guard BEFORE TRUNCATE ON email_rule_receipts FOR EACH STATEMENT EXECUTE FUNCTION native_email_guard_truncate();
DROP TRIGGER IF EXISTS native_email_adoption_write_guard ON email_rules;
CREATE TRIGGER native_email_adoption_write_guard BEFORE INSERT OR UPDATE OR DELETE ON email_rules FOR EACH ROW EXECUTE FUNCTION native_email_guard_row();
DROP TRIGGER IF EXISTS native_email_adoption_truncate_guard ON email_rules;
CREATE TRIGGER native_email_adoption_truncate_guard BEFORE TRUNCATE ON email_rules FOR EACH STATEMENT EXECUTE FUNCTION native_email_guard_truncate();
DROP TRIGGER IF EXISTS native_email_adoption_write_guard ON email_send_operations;
CREATE TRIGGER native_email_adoption_write_guard BEFORE INSERT OR UPDATE OR DELETE ON email_send_operations FOR EACH ROW EXECUTE FUNCTION native_email_guard_row();
DROP TRIGGER IF EXISTS native_email_adoption_truncate_guard ON email_send_operations;
CREATE TRIGGER native_email_adoption_truncate_guard BEFORE TRUNCATE ON email_send_operations FOR EACH STATEMENT EXECUTE FUNCTION native_email_guard_truncate();
DROP TRIGGER IF EXISTS native_email_adoption_write_guard ON email_signatures;
CREATE TRIGGER native_email_adoption_write_guard BEFORE INSERT OR UPDATE OR DELETE ON email_signatures FOR EACH ROW EXECUTE FUNCTION native_email_guard_row();
DROP TRIGGER IF EXISTS native_email_adoption_truncate_guard ON email_signatures;
CREATE TRIGGER native_email_adoption_truncate_guard BEFORE TRUNCATE ON email_signatures FOR EACH STATEMENT EXECUTE FUNCTION native_email_guard_truncate();
DROP TRIGGER IF EXISTS native_email_adoption_write_guard ON email_sync_receipts;
CREATE TRIGGER native_email_adoption_write_guard BEFORE INSERT OR UPDATE OR DELETE ON email_sync_receipts FOR EACH ROW EXECUTE FUNCTION native_email_guard_row();
DROP TRIGGER IF EXISTS native_email_adoption_truncate_guard ON email_sync_receipts;
CREATE TRIGGER native_email_adoption_truncate_guard BEFORE TRUNCATE ON email_sync_receipts FOR EACH STATEMENT EXECUTE FUNCTION native_email_guard_truncate();
DROP TRIGGER IF EXISTS native_email_adoption_write_guard ON email_templates;
CREATE TRIGGER native_email_adoption_write_guard BEFORE INSERT OR UPDATE OR DELETE ON email_templates FOR EACH ROW EXECUTE FUNCTION native_email_guard_row();
DROP TRIGGER IF EXISTS native_email_adoption_truncate_guard ON email_templates;
CREATE TRIGGER native_email_adoption_truncate_guard BEFORE TRUNCATE ON email_templates FOR EACH STATEMENT EXECUTE FUNCTION native_email_guard_truncate();
DROP TRIGGER IF EXISTS native_email_adoption_write_guard ON email_timers;
CREATE TRIGGER native_email_adoption_write_guard BEFORE INSERT OR UPDATE OR DELETE ON email_timers FOR EACH ROW EXECUTE FUNCTION native_email_guard_row();
DROP TRIGGER IF EXISTS native_email_adoption_truncate_guard ON email_timers;
CREATE TRIGGER native_email_adoption_truncate_guard BEFORE TRUNCATE ON email_timers FOR EACH STATEMENT EXECUTE FUNCTION native_email_guard_truncate();
