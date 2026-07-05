DO $$
BEGIN
  CREATE TYPE team_role AS ENUM ('lead', 'member', 'viewer');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE team_visibility AS ENUM ('private', 'org');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE team_resource_type AS ENUM (
    'space',
    'project',
    'wiki_page',
    'note',
    'calendar_feed',
    'task_template',
    'agent_employee'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS teams (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  name text NOT NULL,
  handle text NOT NULL,
  description text,
  type text NOT NULL DEFAULT 'functional',
  visibility team_visibility NOT NULL DEFAULT 'org',
  avatar_url text,
  color text,
  lead_user_id text REFERENCES users(id) ON DELETE SET NULL,
  default_space_id text REFERENCES spaces(id) ON DELETE SET NULL,
  is_archived boolean NOT NULL DEFAULT false,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS teams_org_handle_unique
  ON teams (org_id, handle);
CREATE INDEX IF NOT EXISTS teams_org_idx
  ON teams (org_id);
CREATE INDEX IF NOT EXISTS teams_org_archived_idx
  ON teams (org_id, is_archived);
CREATE INDEX IF NOT EXISTS teams_lead_idx
  ON teams (lead_user_id);

CREATE TABLE IF NOT EXISTS team_members (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  team_id text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role team_role NOT NULL DEFAULT 'member',
  joined_at timestamp NOT NULL DEFAULT now(),
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS team_members_unique
  ON team_members (team_id, user_id);
CREATE INDEX IF NOT EXISTS team_members_org_idx
  ON team_members (org_id);
CREATE INDEX IF NOT EXISTS team_members_team_idx
  ON team_members (team_id);
CREATE INDEX IF NOT EXISTS team_members_user_idx
  ON team_members (user_id);

CREATE TABLE IF NOT EXISTS team_resources (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  team_id text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  resource_type team_resource_type NOT NULL,
  resource_id text NOT NULL,
  label text,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS team_resources_unique
  ON team_resources (team_id, resource_type, resource_id);
CREATE INDEX IF NOT EXISTS team_resources_org_idx
  ON team_resources (org_id);
CREATE INDEX IF NOT EXISTS team_resources_team_idx
  ON team_resources (team_id);
CREATE INDEX IF NOT EXISTS team_resources_resource_idx
  ON team_resources (resource_type, resource_id);

CREATE TABLE IF NOT EXISTS team_dashboard_snapshots (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  team_id text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  snapshot_type text NOT NULL,
  payload_json jsonb NOT NULL,
  generated_at timestamp NOT NULL DEFAULT now(),
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS team_snapshots_org_idx
  ON team_dashboard_snapshots (org_id);
CREATE INDEX IF NOT EXISTS team_snapshots_team_type_idx
  ON team_dashboard_snapshots (team_id, snapshot_type, generated_at);
