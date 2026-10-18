-- Permanent audience seal, independent exact-purpose grant; no conversation/body backfill.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='spaces'::regclass AND conname='spaces_org_id_id_unique') THEN
  ALTER TABLE spaces ADD CONSTRAINT spaces_org_id_id_unique UNIQUE(org_id,id);
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS app_private_defty_seals (
 id text PRIMARY KEY, org_id text NOT NULL, space_id text NOT NULL,
 owner_user_id text NOT NULL, defty_user_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT app_private_defty_seals_space_unique UNIQUE(org_id,space_id),
 CONSTRAINT app_private_defty_seals_identity_unique UNIQUE(org_id,id),
 CONSTRAINT app_private_defty_seals_space_fk FOREIGN KEY(org_id,space_id) REFERENCES spaces(org_id,id) ON DELETE RESTRICT,
 CONSTRAINT app_private_defty_seals_owner_fk FOREIGN KEY(owner_user_id) REFERENCES users(id) ON DELETE RESTRICT,
 CONSTRAINT app_private_defty_seals_agent_fk FOREIGN KEY(defty_user_id) REFERENCES users(id) ON DELETE RESTRICT,
 CONSTRAINT app_private_defty_seals_actor_check CHECK(owner_user_id<>defty_user_id)
);
CREATE TABLE IF NOT EXISTS app_private_defty_grants (
 id text PRIMARY KEY, org_id text NOT NULL, seal_id text NOT NULL,
 owner_user_id text NOT NULL, resource_binding_id text NOT NULL, checkpoint_id text NOT NULL, projection_id text NOT NULL,
 review_digest text NOT NULL, snapshot jsonb NOT NULL, accepted_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL, revoked_at timestamptz,
 active_request_id text, active_prompt_digest text,
 CONSTRAINT app_private_defty_grants_seal_unique UNIQUE(org_id,seal_id),
 CONSTRAINT app_private_defty_grants_identity_unique UNIQUE(org_id,id),
 CONSTRAINT app_private_defty_grants_seal_fk FOREIGN KEY(org_id,seal_id) REFERENCES app_private_defty_seals(org_id,id) ON DELETE RESTRICT,
 CONSTRAINT app_private_defty_grants_owner_fk FOREIGN KEY(org_id,resource_binding_id,owner_user_id) REFERENCES app_resource_bindings(org_id,id,owner_user_id) ON DELETE RESTRICT,
 CONSTRAINT app_private_defty_grants_checkpoint_fk FOREIGN KEY(org_id,checkpoint_id,resource_binding_id) REFERENCES app_sync_checkpoints(org_id,id,resource_binding_id) ON DELETE CASCADE,
 CONSTRAINT app_private_defty_grants_projection_fk FOREIGN KEY(org_id,projection_id) REFERENCES app_resource_projections(org_id,id) ON DELETE CASCADE,
 CONSTRAINT app_private_defty_grants_digest_check CHECK(review_digest ~ '^sha256:[a-f0-9]{64}$'),
 CONSTRAINT app_private_defty_grants_reservation_check CHECK((active_request_id IS NULL AND active_prompt_digest IS NULL) OR (active_request_id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' AND active_prompt_digest ~ '^hmac-sha256:[a-f0-9]{64}$')),
 CONSTRAINT app_private_defty_grants_expiry_check CHECK(expires_at>accepted_at AND expires_at<=accepted_at+interval '15 minutes'),
 CONSTRAINT app_private_defty_grants_snapshot_check CHECK(COALESCE(jsonb_typeof(snapshot)='object' AND octet_length(snapshot::text)<=16384 AND snapshot->>'schema_version'='deft.app_private_defty_snapshot.v1' AND snapshot->>'purpose'='defty_private_context' AND snapshot->>'org_id'=org_id AND snapshot->>'seal_id'=seal_id AND snapshot->>'owner_user_id'=owner_user_id AND snapshot->>'resource_binding_id'=resource_binding_id AND snapshot->>'checkpoint_id'=checkpoint_id AND snapshot#>>'{ref,resource_id}'=projection_id,false))
);
CREATE INDEX IF NOT EXISTS app_private_defty_seals_owner_idx ON app_private_defty_seals(org_id,owner_user_id);
-- spaces.id is globally unique: this covers exact generic trigger lookups.
CREATE UNIQUE INDEX IF NOT EXISTS app_private_defty_seals_global_space_unique ON app_private_defty_seals(space_id);
CREATE INDEX IF NOT EXISTS app_private_defty_grants_parent_idx ON app_private_defty_grants(org_id,resource_binding_id);
CREATE INDEX IF NOT EXISTS app_private_defty_grants_owner_app_idx ON app_private_defty_grants(org_id,owner_user_id,(snapshot->>'app_installation_id'),expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS app_private_defty_messages_request_unique ON messages(org_id,space_id,(metadata->>'request_id'),(metadata->>'role')) WHERE metadata->>'schema_version'='deft.private_defty_message.v1';

CREATE OR REPLACE FUNCTION enforce_app_private_defty_grant() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE required_keys text[]:=ARRAY['schema_version','purpose','org_id','owner_user_id','app_installation_id','app_version_id','grant_snapshot_id','lifecycle_epoch','grant_epoch','registration_id','operator_user_id','runtime_epoch','resource_binding_id','descriptor_digest','checkpoint_id','generation','ref','revision_digest','content_digest','field_keys','app_label','expires_at','review_expires_at','space_id','seal_id','defty_user_id','owner_membership_authorization_version','defty_membership_authorization_version','model_destination'];
 model_keys text[]:=ARRAY['provider','model','endpoint','credential_key_version','credential_fingerprint','reasoning_effort'];
 field text; previous_field text;
BEGIN
 IF NOT COALESCE(NEW.snapshot ?& required_keys AND (NEW.snapshot-required_keys)='{}'::jsonb
  AND jsonb_typeof(NEW.snapshot->'model_destination')='object'
  AND (NEW.snapshot->'model_destination') ?& model_keys AND ((NEW.snapshot->'model_destination')-model_keys)='{}'::jsonb
  AND NEW.snapshot#>>'{model_destination,provider}' IN ('anthropic','openai','openrouter','ollama')
  AND NEW.snapshot#>>'{model_destination,credential_fingerprint}' ~ '^hmac-sha256:[a-f0-9]{64}$'
  AND NEW.snapshot#>>'{model_destination,credential_key_version}' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  AND NEW.snapshot#>>'{ref,schema_version}'='deft.resource_ref.v2'
  AND NEW.snapshot#>>'{ref,provider,kind}'='app_runtime'
  AND NEW.snapshot#>>'{ref,provider,provider_instance_id}'=NEW.snapshot->>'registration_id'
  AND jsonb_typeof(NEW.snapshot->'field_keys')='array'
  AND jsonb_array_length(NEW.snapshot->'field_keys') BETWEEN 1 AND 32,false) THEN
  RAISE EXCEPTION 'Private context snapshot is not the closed reviewed variant';
 END IF;
 FOR field IN SELECT jsonb_array_elements_text(NEW.snapshot->'field_keys') LOOP
  IF field IS NULL OR field !~ '^[a-z][a-z0-9_]{0,47}$' OR (previous_field IS NOT NULL AND previous_field>=field COLLATE "C") THEN
   RAISE EXCEPTION 'Private context fields must be sorted unique declared keys';
  END IF;
  previous_field:=field;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM app_private_defty_seals s WHERE s.org_id=NEW.org_id AND s.id=NEW.seal_id
   AND s.space_id=NEW.snapshot->>'space_id' AND s.owner_user_id=NEW.owner_user_id AND s.defty_user_id=NEW.snapshot->>'defty_user_id') THEN
  RAISE EXCEPTION 'Private context destination differs from permanent seal';
 END IF;
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-'revoked_at'-'active_request_id'-'active_prompt_digest') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at'-'active_request_id'-'active_prompt_digest')
  OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
  OR (OLD.active_request_id IS NOT NULL AND NEW.active_request_id IS NOT NULL AND (NEW.active_request_id IS DISTINCT FROM OLD.active_request_id OR NEW.active_prompt_digest IS DISTINCT FROM OLD.active_prompt_digest)) THEN
   RAISE EXCEPTION 'Private context permits only exact reservation and one-way revocation';
  END IF;
 END IF;
 IF (NEW.snapshot->>'expires_at')::timestamptz IS DISTINCT FROM NEW.expires_at OR (NEW.snapshot->>'review_expires_at')::timestamptz>NEW.expires_at OR (TG_OP='INSERT' AND (NEW.snapshot->>'review_expires_at')::timestamptz<=NEW.accepted_at) THEN
  RAISE EXCEPTION 'Private context deadline differs from reviewed authority';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS app_private_defty_grant_guard ON app_private_defty_grants;
CREATE TRIGGER app_private_defty_grant_guard BEFORE INSERT OR UPDATE ON app_private_defty_grants FOR EACH ROW EXECUTE FUNCTION enforce_app_private_defty_grant();

CREATE OR REPLACE FUNCTION enforce_app_private_defty_seal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Private conversation seals are permanent and immutable'; END IF;
 IF NOT EXISTS(SELECT 1 FROM spaces WHERE id=NEW.space_id AND org_id=NEW.org_id AND type='agent_conversation' AND created_by=NEW.owner_user_id AND NOT is_archived)
 OR NOT EXISTS(SELECT 1 FROM users u INNER JOIN org_members m ON m.user_id=u.id
   WHERE u.id=NEW.owner_user_id AND u.kind='human' AND m.org_id=NEW.org_id AND m.is_active AND m.role<>'guest')
 OR NOT EXISTS(SELECT 1 FROM users u INNER JOIN org_members m ON m.user_id=u.id
   INNER JOIN agent_employees e ON e.user_id=u.id AND e.org_id=m.org_id
   WHERE u.id=NEW.defty_user_id AND u.kind='agent' AND u.is_agent AND u.email='deft-agent@system.local'
   AND m.org_id=NEW.org_id AND m.is_active AND m.role<>'guest' AND e.slug='defty-system'
   AND e.runtime_kind='defty_system' AND NOT e.is_byoa AND e.is_active AND NOT e.unhealthy)
 OR EXISTS(SELECT 1 FROM messages WHERE space_id=NEW.space_id)
 OR (SELECT count(*) FROM space_members WHERE space_id=NEW.space_id)<>2
 OR NOT EXISTS(SELECT 1 FROM space_members WHERE space_id=NEW.space_id AND user_id=NEW.owner_user_id)
 OR NOT EXISTS(SELECT 1 FROM space_members WHERE space_id=NEW.space_id AND user_id=NEW.defty_user_id) THEN
  RAISE EXCEPTION 'Private conversation requires an empty exact participant Space';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS app_private_defty_seal_guard ON app_private_defty_seals;
CREATE TRIGGER app_private_defty_seal_guard BEFORE INSERT OR UPDATE OR DELETE ON app_private_defty_seals FOR EACH ROW EXECUTE FUNCTION enforce_app_private_defty_seal();

CREATE OR REPLACE FUNCTION enforce_app_private_defty_space() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s app_private_defty_seals;
BEGIN
 SELECT * INTO s FROM app_private_defty_seals WHERE space_id=OLD.id FOR SHARE;
 IF FOUND AND (NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.type IS DISTINCT FROM OLD.type) THEN
  RAISE EXCEPTION 'Private conversation identity cannot change';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS app_private_defty_space_guard ON spaces;
CREATE TRIGGER app_private_defty_space_guard BEFORE UPDATE ON spaces FOR EACH ROW EXECUTE FUNCTION enforce_app_private_defty_space();

CREATE OR REPLACE FUNCTION enforce_app_private_defty_participant() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s app_private_defty_seals;
BEGIN
 -- Space precedes seal in the shared lock order. Removal is safe; additions cannot widen audience.
 IF TG_OP='DELETE' THEN
  PERFORM id FROM spaces WHERE id=OLD.space_id FOR UPDATE;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' THEN
  PERFORM id FROM spaces WHERE id IN (OLD.space_id,NEW.space_id) ORDER BY id COLLATE "C" FOR UPDATE;
 ELSE
  PERFORM id FROM spaces WHERE id=NEW.space_id FOR UPDATE;
 END IF;
 SELECT * INTO s FROM app_private_defty_seals WHERE space_id=NEW.space_id FOR SHARE;
 IF FOUND AND NEW.user_id NOT IN (s.owner_user_id,s.defty_user_id) THEN RAISE EXCEPTION 'Private audience cannot widen'; END IF;
 IF TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM app_private_defty_seals WHERE space_id=OLD.space_id) AND (NEW.space_id IS DISTINCT FROM OLD.space_id OR NEW.user_id IS DISTINCT FROM OLD.user_id) THEN
  RAISE EXCEPTION 'Private participant identity cannot change';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS app_private_defty_participant_guard ON space_members;
CREATE TRIGGER app_private_defty_participant_guard BEFORE INSERT OR UPDATE OR DELETE ON space_members FOR EACH ROW EXECUTE FUNCTION enforce_app_private_defty_participant();

CREATE OR REPLACE FUNCTION enforce_app_private_defty_message() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s app_private_defty_seals; envelope jsonb; total_bytes bigint; total_messages bigint;
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM app_private_defty_seals WHERE space_id=OLD.space_id) THEN RAISE EXCEPTION 'Retained private ciphertext cannot be deleted through generic Message operations'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' THEN
  PERFORM id FROM spaces WHERE id IN (OLD.space_id,NEW.space_id) ORDER BY id COLLATE "C" FOR UPDATE;
  IF EXISTS(SELECT 1 FROM app_private_defty_seals WHERE space_id=OLD.space_id) THEN
   IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.space_id IS DISTINCT FROM OLD.space_id OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.content IS DISTINCT FROM OLD.content OR NEW.metadata IS DISTINCT FROM OLD.metadata OR NEW.parent_id IS DISTINCT FROM OLD.parent_id THEN
    RAISE EXCEPTION 'Retained private message authority and ciphertext are immutable';
   END IF;
   RETURN NEW;
  END IF;
 ELSE
  PERFORM id FROM spaces WHERE id=NEW.space_id FOR UPDATE;
 END IF;
 SELECT * INTO s FROM app_private_defty_seals WHERE space_id=NEW.space_id FOR SHARE;
 IF NOT FOUND THEN
  IF COALESCE(NEW.metadata->>'schema_version','') LIKE 'deft.private_defty%' THEN RAISE EXCEPTION 'Private envelope requires exact sealed Space'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.space_id IS DISTINCT FROM OLD.space_id OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.content IS DISTINCT FROM OLD.content OR NEW.metadata IS DISTINCT FROM OLD.metadata OR NEW.parent_id IS DISTINCT FROM OLD.parent_id THEN
   RAISE EXCEPTION 'Retained private message authority and ciphertext are immutable';
  END IF;
  RETURN NEW;
 END IF;
 IF current_setting('deft.private_defty_write',true) IS DISTINCT FROM s.id THEN RAISE EXCEPTION 'Private envelope is server-only'; END IF;
 IF NOT COALESCE(NEW.org_id=s.org_id AND jsonb_typeof(NEW.metadata)='object' AND NEW.metadata ?& ARRAY['schema_version','seal_id','grant_id','request_id','role','envelope'] AND (NEW.metadata-ARRAY['schema_version','seal_id','grant_id','request_id','role','envelope'])='{}'::jsonb AND NEW.metadata->>'schema_version'='deft.private_defty_message.v1' AND NEW.metadata->>'seal_id'=s.id AND ((NEW.metadata->>'role'='user' AND NEW.user_id=s.owner_user_id AND NEW.content='[Private context prompt]') OR (NEW.metadata->>'role'='assistant' AND NEW.user_id=s.defty_user_id AND NEW.content='[Private context answer]')) AND NEW.parent_id IS NULL,false) THEN RAISE EXCEPTION 'Private envelope shape or author is invalid'; END IF;
 envelope:=NEW.metadata->'envelope';
 IF NOT COALESCE(jsonb_typeof(envelope)='object' AND envelope ?& ARRAY['schema_version','algorithm','key_version','nonce_b64','ciphertext_b64','auth_tag_b64'] AND (envelope-ARRAY['schema_version','algorithm','key_version','nonce_b64','ciphertext_b64','auth_tag_b64'])='{}'::jsonb AND envelope->>'schema_version'='deft.secret.v1' AND envelope->>'algorithm'='aes-256-gcm' AND envelope->>'key_version' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' AND octet_length(decode(envelope->>'nonce_b64','base64'))=12 AND octet_length(decode(envelope->>'auth_tag_b64','base64'))=16 AND octet_length(decode(envelope->>'ciphertext_b64','base64')) BETWEEN 1 AND 65536,false) THEN RAISE EXCEPTION 'Private envelope encoding is invalid'; END IF;
 SELECT count(*),COALESCE(sum(octet_length(decode(metadata#>>'{envelope,ciphertext_b64}','base64'))),0) INTO total_messages,total_bytes FROM messages WHERE space_id=s.space_id;
 IF total_messages>=20 OR total_bytes+octet_length(decode(envelope->>'ciphertext_b64','base64'))>262144 THEN RAISE EXCEPTION 'Private retained history bound reached'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS app_private_defty_message_guard ON messages;
CREATE TRIGGER app_private_defty_message_guard BEFORE INSERT OR UPDATE OR DELETE ON messages FOR EACH ROW EXECUTE FUNCTION enforce_app_private_defty_message();
