-- Before the worker stopped copying excerpts, its generated comments had one
-- of these two exact prefixes and were inserted immediately after the matching
-- edge. Soft-delete only rows that also correlate to such an edge, contain the
-- edge's stored excerpt, and were created within one minute. This runs before
-- the excerpt redaction below so legitimate same-shaped user comments are not
-- deleted by a broad pattern match.
UPDATE task_comments AS tc
SET is_deleted = true,
    updated_at = now()
WHERE tc.is_deleted = false
  AND (
    tc.content LIKE 'Referenced in note "%": "%"'
    OR tc.content LIKE 'Discussed in #%: "%"'
  )
  AND EXISTS (
    SELECT 1
    FROM cross_references AS cr
    WHERE cr.org_id = tc.org_id
      AND cr.target_type = 'task'
      AND cr.target_id = tc.task_id
      AND cr.source_type IN ('message', 'note')
      AND cr.created_by = tc.user_id
      AND cr.context IS NOT NULL
      AND position(cr.context in tc.content) > 0
      AND abs(extract(epoch FROM (tc.created_at - cr.created_at))) <= 60
  );

-- Remove source excerpts denormalized by the legacy cross-reference worker.
-- Source visibility can change independently from task visibility, so these
-- copies must not survive in edges after the correlated comment cleanup.
UPDATE cross_references
SET context = NULL,
    updated_at = now()
WHERE source_type IN ('message', 'note')
  AND target_type = 'task'
  AND context IS NOT NULL;

-- Message reminders now resolve their preview from the authorized source at
-- read/fire time. Remove historical cached copies so membership revocation or
-- message deletion cannot leave source text at rest in the reminder row.
UPDATE reminders
SET message = 'Message reminder',
    updated_at = now()
WHERE source_message_id IS NOT NULL
  AND message <> 'Message reminder';

-- Older fired reminders also copied the cached message text into a durable
-- notification. The reminder_id metadata provides an exact correlation, so
-- redact those notification copies without touching ordinary reminders.
UPDATE notifications AS n
SET title = 'Message reminder',
    body = NULL,
    updated_at = now()
WHERE n.type = 'reminder'
  AND (
    -- The link shape identifies source-backed notifications even if the
    -- reminder row was later deleted.
    n.link LIKE '/chat?message=%'
    OR EXISTS (
      SELECT 1
      FROM reminders AS r
      WHERE r.id = n.metadata->>'reminder_id'
        AND r.org_id = n.org_id
        AND r.user_id = n.user_id
        AND r.source_message_id IS NOT NULL
    )
  )
  AND (n.title <> 'Message reminder' OR n.body IS NOT NULL);

-- Legacy task-context clips may have blended a restricted task title or
-- description into a summary shown to every member of the destination space.
-- The hidden contribution cannot be separated reliably after summarization,
-- so remove the derived summary while preserving the original clip/audio.
UPDATE messages AS m
SET metadata = m.metadata - 'clip_summary',
    updated_at = now()
FROM clips AS c
INNER JOIN tasks AS t
  ON t.id = c.context_id
 AND t.org_id = c.org_id
WHERE c.context_type = 'task'
  AND coalesce(t.metadata->>'visibility', 'org') = 'restricted'
  AND m.id = c.message_id
  AND m.org_id = c.org_id
  AND m.metadata ? 'clip_summary';

UPDATE clips AS c
SET summary = NULL,
    updated_at = now()
FROM tasks AS t
WHERE c.context_type = 'task'
  AND t.id = c.context_id
  AND t.org_id = c.org_id
  AND coalesce(t.metadata->>'visibility', 'org') = 'restricted'
  AND c.summary IS NOT NULL;
