ALTER TABLE "agent_channel_connections"
  ALTER COLUMN "protocol_version" SET DEFAULT 'deft.agent_channel.v2';

UPDATE "agent_channel_connections"
SET "status" = 'disconnected',
    "last_error" = 'Hermes integration must reconnect and certify with Agent Channel v2',
    "updated_at" = now()
WHERE "protocol_version" <> 'deft.agent_channel.v2';
