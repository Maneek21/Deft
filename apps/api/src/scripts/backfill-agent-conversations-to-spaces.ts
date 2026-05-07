// One-shot backfill: migrate agent_conversations + agent_messages into
// spaces (type='agent_conversation') + messages (with metadata.agent_blocks).
// Phase 2 of agent-chat unification.
//
// RETIRED: agent_conversations and agent_messages were dropped in migration
// 0065 (P2-9). This script is now a no-op. The backfill was run before
// the tables were dropped.
//
// Usage: pnpm --filter @deft/api exec tsx src/scripts/backfill-agent-conversations-to-spaces.ts

console.log('backfill-agent-conversations-to-spaces: tables already dropped in 0065. Nothing to do.');
process.exit(0);
