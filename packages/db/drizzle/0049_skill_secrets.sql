-- Block 1.4 — per-org, per-skill encrypted secret store.
-- Used by Block 1.6 pre-deploy install flow: when a ClawHub skill declares
-- `requires.env: [SLACK_BOT_TOKEN]`, Deft matches against connected_accounts
-- (OAuth) first; on miss, prompts for raw token and stores here.
-- Least-privilege push: only the secrets declared by the skill's manifest get
-- pushed to the agent container at install time (never the full org pool).

CREATE TABLE IF NOT EXISTS skill_secrets (
  id             text PRIMARY KEY,
  org_id         text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  skill_id       text NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  key_name       text NOT NULL,
  value_encrypted text NOT NULL,
  created_by     text REFERENCES users(id),
  created_at     timestamp NOT NULL DEFAULT now(),
  updated_at     timestamp NOT NULL DEFAULT now()
);

-- One row per (org, skill, key_name). Re-set upsert by this triple.
CREATE UNIQUE INDEX IF NOT EXISTS skill_secrets_org_skill_key_uniq
  ON skill_secrets (org_id, skill_id, key_name);

CREATE INDEX IF NOT EXISTS skill_secrets_org_idx ON skill_secrets (org_id);
CREATE INDEX IF NOT EXISTS skill_secrets_skill_idx ON skill_secrets (skill_id);
