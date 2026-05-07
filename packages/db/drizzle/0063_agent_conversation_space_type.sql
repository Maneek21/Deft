-- Add 'agent_conversation' to the space_type enum.
-- Phase 2 of agent-chat unification: support agent_conversation spaces
-- for structured agent-user multi-turn conversations.

ALTER TYPE space_type ADD VALUE 'agent_conversation' BEFORE 'public';
