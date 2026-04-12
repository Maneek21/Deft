ALTER TABLE "agent_messages" ADD COLUMN "content_blocks" jsonb;
ALTER TABLE "agent_actions" ADD COLUMN "tool_use_id" text;
