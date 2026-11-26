-- Drives and documents (they replace notes). Add-only: nine tables, three
-- trigger functions with their triggers, and three enum labels. Moving the
-- notes is a separate script (pnpm drives:move), not part of this file.
-- No IF NOT EXISTS: a same-named leftover fails the upgrade instead of being
-- recorded as applied.
--
-- Tenancy: every child row carries its parent's org through an org-qualified
-- foreign key, so a row can never point into another workspace. Triggers
-- check that every person or chat a row names belongs to the row's
-- workspace: member and share principals, a personal drive's owner and a
-- favorite's user.

-- A drive holds folders and documents. 'open' drives give every member
-- default_role; 'private' drives only their members; 'personal' is one
-- person's My drive. system_key marks the drives a workspace creates for
-- itself (one of each per workspace).
CREATE TABLE drives (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  name text NOT NULL,
  icon text,
  kind text NOT NULL CHECK (kind IN ('open', 'private', 'personal')),
  system_key text CHECK (system_key IN ('workspace', 'shared_notes')),
  owner_user_id text REFERENCES users(id),
  default_role text CHECK (default_role IN ('edit', 'comment', 'view')),
  agent_suggest_only boolean NOT NULL DEFAULT false,
  knowledge_default boolean NOT NULL DEFAULT true,
  frozen_at timestamp,
  created_by text REFERENCES users(id),
  is_deleted boolean NOT NULL DEFAULT false,
  deleted_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT drives_org_id_id_key UNIQUE (org_id, id),
  CONSTRAINT drives_open_has_default_role CHECK ((kind = 'open') = (default_role IS NOT NULL)),
  CONSTRAINT drives_personal_has_owner CHECK ((kind = 'personal') = (owner_user_id IS NOT NULL))
);

CREATE UNIQUE INDEX drives_personal_owner_uidx ON drives (org_id, owner_user_id)
  WHERE kind = 'personal' AND NOT is_deleted AND frozen_at IS NULL;
CREATE UNIQUE INDEX drives_system_key_uidx ON drives (org_id, system_key)
  WHERE system_key IS NOT NULL AND NOT is_deleted;

-- Who may use a drive besides its default role: a person or a chat (space).
-- A linked chat (is_link) is the chat's own drive; a chat has at most one.
CREATE TABLE drive_members (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  drive_id text NOT NULL,
  principal_type text NOT NULL CHECK (principal_type IN ('user', 'space')),
  principal_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('full', 'edit', 'comment', 'view')),
  is_link boolean NOT NULL DEFAULT false,
  added_by text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT drive_members_drive_fk FOREIGN KEY (org_id, drive_id) REFERENCES drives (org_id, id),
  CONSTRAINT drive_members_drive_principal_key UNIQUE (drive_id, principal_type, principal_id)
);

CREATE INDEX drive_members_principal_idx ON drive_members (principal_type, principal_id);
CREATE UNIQUE INDEX drive_members_space_link_uidx ON drive_members (org_id, principal_id)
  WHERE principal_type = 'space' AND is_link;

-- Folders nest inside one drive. The parent must be in the same drive; the
-- key is deferrable so a move can update a whole subtree in one transaction.
CREATE TABLE doc_folders (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  drive_id text NOT NULL,
  parent_folder_id text,
  name text NOT NULL,
  position double precision NOT NULL DEFAULT 0,
  created_by text,
  is_deleted boolean NOT NULL DEFAULT false,
  deleted_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT doc_folders_org_drive_id_key UNIQUE (org_id, drive_id, id),
  CONSTRAINT doc_folders_drive_fk FOREIGN KEY (org_id, drive_id) REFERENCES drives (org_id, id),
  CONSTRAINT doc_folders_parent_fk FOREIGN KEY (org_id, drive_id, parent_folder_id)
    REFERENCES doc_folders (org_id, drive_id, id) DEFERRABLE INITIALLY IMMEDIATE
);

-- A document sits in a folder or under a parent document (a sub-page), never
-- both, and always in the same drive as that folder or parent. ydoc_state is
-- the live-editing state; content_json and content_text are its stored copies.
-- revision counts content writes; knowledge_generation counts knowledge
-- withdrawals. search_vector is filled by documents_search_update below.
CREATE TABLE documents (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  drive_id text NOT NULL,
  folder_id text,
  parent_document_id text,
  title text NOT NULL DEFAULT '',
  icon text,
  position double precision NOT NULL DEFAULT 0,
  ydoc_state bytea,
  content_json jsonb NOT NULL,
  content_text text NOT NULL DEFAULT '',
  search_vector tsvector,
  use_in_knowledge boolean,
  size_bytes integer NOT NULL DEFAULT 0,
  is_template boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT 0,
  knowledge_generation integer NOT NULL DEFAULT 0,
  created_by text,
  last_edited_by text,
  last_edited_at timestamp,
  is_deleted boolean NOT NULL DEFAULT false,
  deleted_at timestamp,
  deleted_by text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT documents_org_id_id_key UNIQUE (org_id, id),
  CONSTRAINT documents_org_drive_id_key UNIQUE (org_id, drive_id, id),
  CONSTRAINT documents_drive_fk FOREIGN KEY (org_id, drive_id) REFERENCES drives (org_id, id),
  CONSTRAINT documents_folder_fk FOREIGN KEY (org_id, drive_id, folder_id)
    REFERENCES doc_folders (org_id, drive_id, id) DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT documents_parent_fk FOREIGN KEY (org_id, drive_id, parent_document_id)
    REFERENCES documents (org_id, drive_id, id) DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT documents_folder_or_parent CHECK (NOT (folder_id IS NOT NULL AND parent_document_id IS NOT NULL))
);

CREATE INDEX documents_org_drive_live_idx ON documents (org_id, drive_id) WHERE NOT is_deleted;
CREATE INDEX documents_parent_idx ON documents (parent_document_id);
CREATE INDEX documents_search_idx ON documents USING gin (search_vector);

-- A document shared directly with a person or a chat.
CREATE TABLE document_shares (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  document_id text NOT NULL,
  principal_type text NOT NULL CHECK (principal_type IN ('user', 'space')),
  principal_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('edit', 'comment', 'view')),
  shared_by text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT document_shares_document_fk FOREIGN KEY (org_id, document_id) REFERENCES documents (org_id, id),
  CONSTRAINT document_shares_document_principal_key UNIQUE (document_id, principal_type, principal_id)
);

CREATE INDEX document_shares_principal_idx ON document_shares (principal_type, principal_id);

-- Saved versions of a document. An agent edit stores at most one version per
-- action, so a retried edit does not store a second one. content_removed_*
-- records that a version's content was removed later; the row stays.
CREATE TABLE document_versions (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  document_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('auto', 'named', 'agent', 'restore', 'import', 'moved')),
  name text,
  title text,
  ydoc_state bytea,
  content_json jsonb NOT NULL,
  size_bytes integer NOT NULL,
  created_by text,
  agent_user_id text,
  action_id text,
  edit_details jsonb,
  content_removed_at timestamp,
  content_removed_by text,
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT document_versions_document_fk FOREIGN KEY (org_id, document_id) REFERENCES documents (org_id, id)
);

CREATE INDEX document_versions_document_created_idx ON document_versions (document_id, created_at DESC);
CREATE UNIQUE INDEX document_versions_agent_action_uidx ON document_versions (document_id, action_id)
  WHERE kind = 'agent';

-- Files (images and attachments) a document uses. in_current is false once
-- the file is no longer in the current content; the row is kept for versions.
CREATE TABLE document_attachments (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  document_id text NOT NULL,
  file_id text NOT NULL,
  in_current boolean NOT NULL DEFAULT true,
  added_by text,
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT document_attachments_document_fk FOREIGN KEY (org_id, document_id) REFERENCES documents (org_id, id),
  CONSTRAINT document_attachments_file_fk FOREIGN KEY (org_id, file_id) REFERENCES files (org_id, id),
  CONSTRAINT document_attachments_document_file_key UNIQUE (document_id, file_id)
);

CREATE INDEX document_attachments_file_idx ON document_attachments (file_id);

-- A person's starred documents and drives.
CREATE TABLE doc_favorites (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  user_id text NOT NULL REFERENCES users(id),
  target_type text NOT NULL CHECK (target_type IN ('document', 'drive')),
  target_id text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT doc_favorites_user_target_key UNIQUE (user_id, target_type, target_id)
);

-- Where each note, note folder and chat canvas went in the move, and what the
-- move had to leave out. One row per source, so the move can be re-run.
CREATE TABLE note_document_map (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  source_type text NOT NULL CHECK (source_type IN ('note', 'note_folder', 'canvas')),
  source_id text NOT NULL,
  target_type text NOT NULL CHECK (target_type IN ('document', 'doc_folder')),
  target_id text NOT NULL,
  outcome text NOT NULL DEFAULT 'ok'
    CHECK (outcome IN ('ok', 'unsafe_content_dropped', 'missing_images', 'unsafe_and_missing')),
  details jsonb,
  moved_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT note_document_map_source_key UNIQUE (source_type, source_id)
);

-- Full-text search over title (weight A) and text (weight B). A trigger, not
-- a generated column: upgrades may not add generated columns. Postgres
-- refuses a tsvector over 1 MB, which a long text of mostly unique words can
-- reach; then the start of the title and text are searched instead, so the
-- row (and the live state stored with it) is still written.
CREATE FUNCTION documents_search_update() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  BEGIN
    NEW.search_vector :=
      setweight(to_tsvector('simple', coalesce(NEW.title, '')), 'A') ||
      setweight(to_tsvector('simple', coalesce(NEW.content_text, '')), 'B');
  EXCEPTION WHEN program_limit_exceeded THEN
    NEW.search_vector :=
      setweight(to_tsvector('simple', left(coalesce(NEW.title, ''), 10000)), 'A') ||
      setweight(to_tsvector('simple', left(coalesce(NEW.content_text, ''), 100000)), 'B');
  END;
  RETURN NEW;
END;
$$;

CREATE TRIGGER documents_search_update
  BEFORE INSERT OR UPDATE OF title, content_text ON documents
  FOR EACH ROW EXECUTE FUNCTION documents_search_update();

-- A member or share principal must belong to the row's workspace: a person
-- needs an org_members row there, a chat must be one of its spaces. The
-- org-qualified keys above tie the row's org to its drive or document.
CREATE FUNCTION doc_principal_check() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.principal_type = 'user' THEN
    IF EXISTS (SELECT 1 FROM public.org_members m WHERE m.org_id = NEW.org_id AND m.user_id = NEW.principal_id) THEN
      RETURN NEW;
    END IF;
  ELSIF NEW.principal_type = 'space' THEN
    IF EXISTS (SELECT 1 FROM public.spaces s WHERE s.org_id = NEW.org_id AND s.id = NEW.principal_id) THEN
      RETURN NEW;
    END IF;
  ELSE
    RAISE EXCEPTION '%: unknown principal type %', TG_TABLE_NAME, NEW.principal_type
      USING ERRCODE = 'check_violation';
  END IF;
  RAISE EXCEPTION '%: % principal % is not in workspace %', TG_TABLE_NAME, NEW.principal_type, NEW.principal_id, NEW.org_id
    USING ERRCODE = 'foreign_key_violation';
END;
$$;

-- Checked when a principal is written: on insert, and on an update that sets
-- the org or the principal. A role-only change doesn't re-check, so a grant
-- that went stale (its chat moved to another workspace, its person left) can
-- still be lowered.
CREATE TRIGGER drive_members_principal_check
  BEFORE INSERT OR UPDATE OF org_id, principal_type, principal_id ON drive_members
  FOR EACH ROW EXECUTE FUNCTION doc_principal_check();

CREATE TRIGGER document_shares_principal_check
  BEFORE INSERT OR UPDATE OF org_id, principal_type, principal_id ON document_shares
  FOR EACH ROW EXECUTE FUNCTION doc_principal_check();

-- A personal drive's owner and a favorite's user must have an org_members row
-- in the row's workspace. A trigger rather than a foreign key to org_members,
-- so membership rows stay free to change. It runs only when the org or that
-- user changes: freezing a departed person's drive doesn't depend on their
-- membership row.
CREATE FUNCTION doc_member_user_check() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  member_id text;
BEGIN
  IF TG_TABLE_NAME = 'drives' THEN
    member_id := NEW.owner_user_id;
  ELSIF TG_TABLE_NAME = 'doc_favorites' THEN
    member_id := NEW.user_id;
  ELSE
    RAISE EXCEPTION 'doc_member_user_check: unexpected table %', TG_TABLE_NAME;
  END IF;
  IF member_id IS NULL
    OR EXISTS (SELECT 1 FROM public.org_members m WHERE m.org_id = NEW.org_id AND m.user_id = member_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '%: user % is not in workspace %', TG_TABLE_NAME, member_id, NEW.org_id
    USING ERRCODE = 'foreign_key_violation';
END;
$$;

CREATE TRIGGER drives_owner_member_check
  BEFORE INSERT OR UPDATE OF org_id, owner_user_id ON drives
  FOR EACH ROW EXECUTE FUNCTION doc_member_user_check();

CREATE TRIGGER doc_favorites_user_member_check
  BEFORE INSERT OR UPDATE OF org_id, user_id ON doc_favorites
  FOR EACH ROW EXECUTE FUNCTION doc_member_user_check();

-- New labels exist only through upgrades: schema.ts's enums are part of the
-- fresh-install fingerprint and stay as they are. The API widens its types
-- (apps/api/src/lib/notification-types.ts, routes/teams.ts).
ALTER TYPE notification_type ADD VALUE 'document_shared';
ALTER TYPE entity_tag_type ADD VALUE 'document';
ALTER TYPE team_resource_type ADD VALUE 'document';
