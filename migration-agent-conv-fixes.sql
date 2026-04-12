ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS agent_employee_id text;
ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT false;
ALTER TABLE agent_actions ADD COLUMN IF NOT EXISTS message_id text;
