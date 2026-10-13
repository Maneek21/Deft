-- Native encrypted draft files have no Experience lifetime. Detach is soft.
CREATE TABLE IF NOT EXISTS email_attachments (
 org_id text NOT NULL,owner_user_id text NOT NULL,account_id text NOT NULL,draft_id text NOT NULL,file_id text NOT NULL,
 upload_revision integer NOT NULL,size_bytes integer NOT NULL,metadata_envelope jsonb NOT NULL,
 ciphertext bytea NOT NULL,key_version text NOT NULL,nonce_b64 text NOT NULL,auth_tag_b64 text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),detached_at timestamptz,
 CONSTRAINT email_attachments_pkey PRIMARY KEY(org_id,owner_user_id,account_id,draft_id,file_id),
 CONSTRAINT email_attachments_draft_fk FOREIGN KEY(org_id,owner_user_id,account_id,draft_id)
   REFERENCES email_drafts(org_id,owner_user_id,account_id,draft_id) ON DELETE RESTRICT,
 CONSTRAINT email_attachments_identity_check CHECK(file_id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' AND upload_revision>0),
 CONSTRAINT email_attachments_bytes_check CHECK(size_bytes BETWEEN 0 AND 26214400 AND octet_length(ciphertext)=size_bytes),
 CONSTRAINT email_attachments_cipher_check CHECK(char_length(key_version) BETWEEN 1 AND 64 AND char_length(nonce_b64)=16 AND char_length(auth_tag_b64)=24)
);
