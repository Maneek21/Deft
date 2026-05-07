CREATE TABLE IF NOT EXISTS message_classifications (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  message_id text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  intent text NOT NULL,
  confidence real NOT NULL,
  agent_mentioned boolean NOT NULL DEFAULT false,
  blocked boolean NOT NULL DEFAULT false,
  task_references text[] NOT NULL DEFAULT ARRAY[]::text[],
  entities jsonb,
  memorable_facts text[] NOT NULL DEFAULT ARRAY[]::text[],
  decision text,
  created_at timestamp NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS mc_org_msg_idx ON message_classifications(org_id, message_id);
