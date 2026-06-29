-- Preserve where knowledge came from separately from where it is scoped.
-- `space_id` remains the access/scope space for space-scoped pages.
-- `origin_*` records the chat/user/message provenance for org- and space-scoped pages.

ALTER TABLE "wiki_pages"
  ADD COLUMN IF NOT EXISTS "origin_space_id" text REFERENCES "spaces"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "origin_message_id" text REFERENCES "messages"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "origin_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "created_via" text;

ALTER TABLE "wiki_citations"
  ADD COLUMN IF NOT EXISTS "org_id" text REFERENCES "orgs"("id") ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS "source_space_id" text REFERENCES "spaces"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "source_user_id" text REFERENCES "users"("id") ON DELETE SET NULL;

WITH candidates AS (
  SELECT
    wp.id,
    COALESCE(
      NULLIF(wp.metadata->>'origin_space_id', ''),
      NULLIF(wp.metadata->>'source_space_id', ''),
      wc.source_space_id,
      msg.space_id,
      CASE WHEN wp.scope = 'space' THEN wp.space_id ELSE NULL END
    ) AS origin_space_id,
    COALESCE(
      NULLIF(wp.metadata->>'origin_message_id', ''),
      NULLIF(wp.metadata->>'source_message_id', ''),
      CASE WHEN wc.source_type = 'message' THEN wc.source_id ELSE NULL END
    ) AS origin_message_id,
    COALESCE(
      NULLIF(wp.metadata->>'origin_user_id', ''),
      NULLIF(wp.metadata->>'source_user_id', ''),
      wc.source_user_id,
      msg.user_id,
      wp.user_id
    ) AS origin_user_id,
    COALESCE(
      NULLIF(wp.metadata->>'created_via', ''),
      NULLIF(wp.metadata->>'source', ''),
      CASE WHEN wp.agent_employee_id IS NOT NULL THEN 'agent' ELSE 'manual' END
    ) AS created_via
  FROM wiki_pages wp
  LEFT JOIN LATERAL (
    SELECT wc.source_type, wc.source_id, wc.source_space_id, wc.source_user_id
    FROM wiki_citations wc
    WHERE wc.page_id = wp.id
    ORDER BY wc.created_at DESC
    LIMIT 1
  ) wc ON true
  LEFT JOIN messages msg ON msg.id = wc.source_id AND wc.source_type = 'message'
),
valid AS (
  SELECT
    c.id,
    s.id AS origin_space_id,
    m.id AS origin_message_id,
    u.id AS origin_user_id,
    c.created_via
  FROM candidates c
  LEFT JOIN spaces s ON s.id = c.origin_space_id
  LEFT JOIN messages m ON m.id = c.origin_message_id
  LEFT JOIN users u ON u.id = c.origin_user_id
)
UPDATE wiki_pages wp
SET
  origin_space_id = COALESCE(wp.origin_space_id, valid.origin_space_id),
  origin_message_id = COALESCE(wp.origin_message_id, valid.origin_message_id),
  origin_user_id = COALESCE(wp.origin_user_id, valid.origin_user_id),
  created_via = COALESCE(wp.created_via, valid.created_via)
FROM valid
WHERE valid.id = wp.id;

UPDATE wiki_citations wc
SET org_id = wp.org_id
FROM wiki_pages wp
WHERE wc.page_id = wp.id
  AND wc.org_id IS NULL;

UPDATE wiki_citations wc
SET
  source_space_id = COALESCE(wc.source_space_id, msg.space_id),
  source_user_id = COALESCE(wc.source_user_id, msg.user_id)
FROM messages msg
WHERE wc.source_type = 'message'
  AND wc.source_id = msg.id;

CREATE INDEX IF NOT EXISTS "wiki_pages_org_origin_space" ON "wiki_pages" ("org_id", "origin_space_id");
CREATE INDEX IF NOT EXISTS "wiki_pages_org_scope_space" ON "wiki_pages" ("org_id", "scope", "space_id");
CREATE INDEX IF NOT EXISTS "wiki_pages_org_created_via" ON "wiki_pages" ("org_id", "created_via");
CREATE INDEX IF NOT EXISTS "wiki_citations_org_source_space" ON "wiki_citations" ("org_id", "source_space_id");
CREATE INDEX IF NOT EXISTS "wiki_citations_source" ON "wiki_citations" ("source_type", "source_id");
