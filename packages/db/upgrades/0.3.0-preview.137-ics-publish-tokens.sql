-- A published calendar feed belongs to one person in one workspace. At most
-- one live (not revoked) feed per person per workspace; every token is unique.
-- No IF NOT EXISTS: a same-named leftover fails the upgrade instead of being
-- recorded as applied.
CREATE TABLE ics_publish_tokens (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token text NOT NULL,
  revoked_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX ics_publish_tokens_token_uidx ON ics_publish_tokens (token);
CREATE UNIQUE INDEX ics_publish_tokens_live_uidx ON ics_publish_tokens (org_id, user_id)
  WHERE revoked_at IS NULL;

-- An existing feed link keeps working for a person with exactly one active
-- workspace membership. Anyone else creates a feed link in the workspace
-- they want. users.ics_publish_token is left in place.
INSERT INTO ics_publish_tokens (id, org_id, user_id, token)
SELECT gen_random_uuid()::text, m.org_id, u.id, u.ics_publish_token
FROM users u
JOIN (
  SELECT user_id, min(org_id) AS org_id
  FROM org_members
  WHERE is_active
  GROUP BY user_id
  HAVING count(*) = 1
) m ON m.user_id = u.id
WHERE u.ics_publish_token IS NOT NULL
ON CONFLICT DO NOTHING;
