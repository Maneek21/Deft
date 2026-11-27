-- Drives and documents, checkpoint 2: meeting notes, agent edit settings and
-- suggestions. Add-only. It holds document_event_links (M2) and
-- document_user_settings (M5); the suggestion tables are added to this file
-- while it is unreleased.
-- No IF NOT EXISTS: a same-named leftover fails the upgrade instead of being
-- recorded as applied.

-- Meeting notes: a document linked to a calendar event ("Notes for this
-- meeting"). The link carries its document's workspace through an
-- org-qualified key. events has no (org_id, id) key to reference, and an
-- upgrade may not add one, so a trigger checks that the event is in the
-- link's workspace. Deleting an event removes its links and keeps the
-- documents; documents are only ever soft-deleted.
CREATE TABLE document_event_links (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  document_id text NOT NULL,
  event_id text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  created_by text,
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT document_event_links_document_fk FOREIGN KEY (org_id, document_id) REFERENCES documents (org_id, id),
  CONSTRAINT document_event_links_event_document_key UNIQUE (event_id, document_id)
);

-- The document's links (its key above, and a document's meeting).
CREATE INDEX document_event_links_document_idx ON document_event_links (org_id, document_id);

-- A link's event must be one of its workspace's events, checked when the
-- event or the org is written. A trigger, not an (org_id, event_id) key:
-- events has no (org_id, id) key and the add-only check refuses a new unique
-- index on an existing table, the same reason F2's doc_principal_check guards
-- drive_members and document_shares against spaces and users (controller
-- ruling, M2 fix round 1). An event's org_id never changes after it is
-- written; apps/api/test/events-org-id-immutable.test.ts holds every writer
-- to that, so the check at link time stays true.
CREATE FUNCTION document_event_link_check() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.events e WHERE e.id = NEW.event_id AND e.org_id = NEW.org_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'document_event_links: event % is not in workspace %', NEW.event_id, NEW.org_id
    USING ERRCODE = 'foreign_key_violation';
END;
$$;

CREATE TRIGGER document_event_links_event_check
  BEFORE INSERT OR UPDATE OF org_id, event_id ON document_event_links
  FOR EACH ROW EXECUTE FUNCTION document_event_link_check();

-- Each person's setting for where an agent's edit to a document lands (M5):
-- 'direct' straight in, 'suggest' as a suggestion, 'suggest_when_open' (the
-- default) as a suggestion only while someone else has the document open.
-- One row per person and workspace; a person with no row has the default.
CREATE TABLE document_user_settings (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  user_id text NOT NULL REFERENCES users(id),
  agent_edit_mode text NOT NULL DEFAULT 'suggest_when_open'
    CHECK (agent_edit_mode IN ('direct', 'suggest', 'suggest_when_open')),
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT document_user_settings_org_user_key UNIQUE (org_id, user_id)
);

-- users are global, so the person must have an org_members row in the row's
-- workspace, as F2's doc_member_user_check holds a favorite's user. A
-- trigger rather than a foreign key to org_members, so membership rows stay
-- free to change; it runs only when the org or the person is set, so a
-- departed person's row can still be read and changed.
CREATE FUNCTION document_user_settings_member_check() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.org_members m WHERE m.org_id = NEW.org_id AND m.user_id = NEW.user_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'document_user_settings: user % is not in workspace %', NEW.user_id, NEW.org_id
    USING ERRCODE = 'foreign_key_violation';
END;
$$;

CREATE TRIGGER document_user_settings_member_check
  BEFORE INSERT OR UPDATE OF org_id, user_id ON document_user_settings
  FOR EACH ROW EXECUTE FUNCTION document_user_settings_member_check();
