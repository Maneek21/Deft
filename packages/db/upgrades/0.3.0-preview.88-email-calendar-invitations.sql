CREATE TABLE IF NOT EXISTS email_calendar_invitations (
 org_id text NOT NULL, owner_user_id text NOT NULL, account_id text NOT NULL, invitation_id text NOT NULL,
 revision integer NOT NULL DEFAULT 1, sequence integer NOT NULL, dtstamp timestamptz NOT NULL, content_digest text NOT NULL,
 logical_message_id text NOT NULL, source_digest text NOT NULL, model_envelope jsonb NOT NULL, event_id text, event_fingerprint text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT email_calendar_invitations_pkey PRIMARY KEY(org_id,owner_user_id,account_id,invitation_id),
 CONSTRAINT email_calendar_invitations_account_fk FOREIGN KEY(org_id,owner_user_id,account_id) REFERENCES email_accounts(org_id,owner_user_id,account_id) ON DELETE RESTRICT,
 CONSTRAINT email_calendar_invitations_event_fk FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE SET NULL,
 CONSTRAINT email_calendar_invitations_identity_check CHECK(invitation_id ~ '^[a-f0-9]{64}$' AND content_digest ~ '^[a-f0-9]{64}$' AND source_digest ~ '^[a-f0-9]{64}$' AND logical_message_id ~ '^mail_[a-f0-9]{64}$' AND revision>0 AND sequence>=0 AND (event_fingerprint IS NULL OR event_fingerprint ~ '^[a-f0-9]{64}$'))
);
CREATE INDEX IF NOT EXISTS email_calendar_invitations_updated_idx ON email_calendar_invitations(org_id,owner_user_id,account_id,updated_at);
CREATE TABLE IF NOT EXISTS email_calendar_invitation_actions (
 org_id text NOT NULL, owner_user_id text NOT NULL, account_id text NOT NULL, request_id uuid NOT NULL, invitation_id text NOT NULL,
 payload_digest text NOT NULL, invitation_revision integer NOT NULL, receipt_envelope jsonb NOT NULL, outbox_id text, created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT email_calendar_invitation_actions_pkey PRIMARY KEY(org_id,owner_user_id,account_id,request_id),
 CONSTRAINT email_calendar_invitation_actions_invitation_fk FOREIGN KEY(org_id,owner_user_id,account_id,invitation_id) REFERENCES email_calendar_invitations(org_id,owner_user_id,account_id,invitation_id) ON DELETE RESTRICT,
 CONSTRAINT email_calendar_invitation_actions_outbox_fk FOREIGN KEY(org_id,owner_user_id,account_id,outbox_id) REFERENCES email_outbox(org_id,owner_user_id,account_id,outbox_id) ON DELETE RESTRICT,
 CONSTRAINT email_calendar_invitation_actions_digest_check CHECK(payload_digest ~ '^[a-f0-9]{64}$' AND invitation_revision>0)
);
CREATE OR REPLACE FUNCTION enforce_email_calendar_invitation_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.org_id,NEW.owner_user_id,NEW.account_id,NEW.invitation_id) IS DISTINCT FROM ROW(OLD.org_id,OLD.owner_user_id,OLD.account_id,OLD.invitation_id) THEN
   RAISE EXCEPTION 'email_calendar_invitation_scope_immutable';
  END IF;
  IF NEW.sequence<OLD.sequence OR (NEW.sequence=OLD.sequence AND NEW.dtstamp<OLD.dtstamp) THEN RAISE EXCEPTION 'email_calendar_invitation_stale'; END IF;
  IF NEW.sequence=OLD.sequence AND NEW.dtstamp=OLD.dtstamp AND NEW.content_digest<>OLD.content_digest THEN RAISE EXCEPTION 'email_calendar_invitation_version_conflict'; END IF;
 END IF;
 IF NEW.event_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM events WHERE id=NEW.event_id AND org_id=NEW.org_id AND user_id=NEW.owner_user_id AND source='native' AND event_type='calendar_event') THEN
  RAISE EXCEPTION 'email_calendar_invitation_event_scope';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS email_calendar_invitation_scope_guard ON email_calendar_invitations;
CREATE TRIGGER email_calendar_invitation_scope_guard BEFORE INSERT OR UPDATE ON email_calendar_invitations FOR EACH ROW EXECUTE FUNCTION enforce_email_calendar_invitation_scope();
