-- Migration 0064: Add 'agent_conversation' to space_type enum.
-- Phase 2 of agent-chat unification — agent conversations become first-class spaces.
ALTER TYPE space_type ADD VALUE IF NOT EXISTS 'agent_conversation';
