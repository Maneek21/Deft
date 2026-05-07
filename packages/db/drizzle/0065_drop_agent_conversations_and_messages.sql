-- Migration 0065: Drop agent_messages + agent_conversations.
-- Phase 2 of agent-chat unification. Data has been migrated to spaces +
-- messages by backfill-agent-conversations-to-spaces.ts (committed in P2-8).
-- agent_actions stays — it's the approval ledger, not chat data; it
-- continues to link to messages.id via the message_id column (same UUID space).
--
-- Drop FK constraints referencing agent_conversations before dropping the table.
-- agent_actions.conversation_id and agent_memory.conversation_id are kept as
-- plain text columns (nullable, no FK) — they now hold space IDs.

ALTER TABLE IF EXISTS agent_actions
  DROP CONSTRAINT IF EXISTS agent_actions_conversation_id_agent_conversations_id_fk;

ALTER TABLE IF EXISTS agent_memory
  DROP CONSTRAINT IF EXISTS agent_memory_conversation_id_agent_conversations_id_fk;

DROP TABLE IF EXISTS agent_messages;
DROP TABLE IF EXISTS agent_conversations;
