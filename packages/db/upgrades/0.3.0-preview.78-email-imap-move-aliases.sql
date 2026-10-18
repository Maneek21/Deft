-- Provider UID/MOVE evidence is encrypted. A locator collision is never an
-- overwrite, and an unknown MOVE retains its one per-message reservation.
CREATE TABLE IF NOT EXISTS email_imap_aliases (
 org_id text NOT NULL,owner_user_id text NOT NULL,account_id text NOT NULL,logical_message_id text NOT NULL,
 locator_key text NOT NULL,revision integer NOT NULL,evidence_envelope jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT email_imap_aliases_pkey PRIMARY KEY(org_id,owner_user_id,account_id,locator_key),
 CONSTRAINT email_imap_aliases_message_fk FOREIGN KEY(org_id,owner_user_id,account_id,logical_message_id) REFERENCES email_messages(org_id,owner_user_id,account_id,logical_message_id) ON DELETE RESTRICT,
 CONSTRAINT email_imap_aliases_identity_check CHECK(locator_key ~ '^[a-f0-9]{64}$' AND revision>0)
);
CREATE INDEX IF NOT EXISTS email_imap_aliases_message_idx ON email_imap_aliases(org_id,owner_user_id,account_id,logical_message_id);
CREATE TABLE IF NOT EXISTS email_imap_move_reservations (
 org_id text NOT NULL,owner_user_id text NOT NULL,account_id text NOT NULL,logical_message_id text NOT NULL,
 operation_id text NOT NULL,source_digest text NOT NULL,reservation_envelope jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT email_imap_move_reservations_pkey PRIMARY KEY(org_id,owner_user_id,account_id,logical_message_id),
 CONSTRAINT email_imap_move_reservations_message_fk FOREIGN KEY(org_id,owner_user_id,account_id,logical_message_id) REFERENCES email_messages(org_id,owner_user_id,account_id,logical_message_id) ON DELETE RESTRICT,
 CONSTRAINT email_imap_move_reservations_operation_fk FOREIGN KEY(org_id,owner_user_id,account_id,operation_id) REFERENCES email_operations(org_id,owner_user_id,account_id,operation_id) ON DELETE RESTRICT,
 CONSTRAINT email_imap_move_reservations_identity_check CHECK(source_digest ~ '^[a-f0-9]{64}$' AND operation_id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$')
);
