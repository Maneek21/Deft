-- Backfill for legacy agent conversation data

-- 1. Hide legacy synthesis messages so they don't render as user input
UPDATE agent_messages
SET hidden = true
WHERE role = 'user'
  AND content LIKE '[System:%'
  AND hidden = false;

-- 2. Link orphan agent_actions to their parent assistant message.
-- Legacy actions were created mid-stream BEFORE the assistant message was saved.
-- Find the first assistant message in the same conversation created at or after the action.
UPDATE agent_actions AS a
SET message_id = (
  SELECT m.id
  FROM agent_messages m
  WHERE m.conversation_id = a.conversation_id
    AND m.role = 'assistant'
    AND m.created_at >= a.created_at
  ORDER BY m.created_at ASC
  LIMIT 1
)
WHERE a.message_id IS NULL
  AND a.conversation_id IS NOT NULL;
