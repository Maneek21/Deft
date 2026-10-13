CREATE TABLE IF NOT EXISTS native_create_requests (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation text NOT NULL,
  request_hash text NOT NULL,
  resource_id text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS native_create_requests_org_idx ON native_create_requests(org_id);
