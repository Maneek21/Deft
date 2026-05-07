/**
 * Dump the latest conversation for a given agent employee, showing each
 * message row's content_blocks structure and confirming tool_use/tool_result
 * pairs are correctly linked by tool_use_id.
 *
 * Post-P2-9: reads from unified spaces + messages tables (agent_conversations
 * and agent_messages were dropped in migration 0065).
 *
 * Run: pnpm --filter @deft/api exec tsx src/scripts/verify-structured-history.ts
 */
import { db } from '../lib/db.js';
import { sql } from 'drizzle-orm';

const EMPLOYEE_ID = '7e79b0a9-f88c-49f4-b79d-ab8a7c7f1633';

async function main() {
  // Find the agent employee's user_id, then find their most recent conversation space.
  const empRows = await db.execute(sql`
    SELECT user_id FROM agent_employees WHERE id = ${EMPLOYEE_ID} LIMIT 1
  `);
  if (empRows.rows.length === 0) {
    console.log('Employee not found.');
    process.exit(0);
  }
  const agentUserId = (empRows.rows[0] as any).user_id;

  const convs = await db.execute(sql`
    SELECT s.id FROM spaces s
    JOIN space_members sm ON sm.space_id = s.id AND sm.user_id = ${agentUserId}
    WHERE s.type = 'agent_conversation'
    ORDER BY s.updated_at DESC LIMIT 1
  `);
  if (convs.rows.length === 0) {
    console.log('No conversations.');
    process.exit(0);
  }
  const convoId = (convs.rows[0] as any).id;
  console.log(`Conversation (space): ${convoId}`);

  const msgs = await db.execute(sql`
    SELECT id, user_id, created_at,
           LEFT(content, 60) AS text,
           metadata
    FROM messages
    WHERE space_id = ${convoId}
    ORDER BY created_at ASC
  `);

  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();
  for (const r of msgs.rows as any[]) {
    const meta = (r.metadata as any) || {};
    const blocks: any[] = meta.agent_blocks ?? [];
    const hidden = meta.hidden === true;
    const kind = meta.kind ?? 'message';
    console.log(`\n[${r.created_at}] kind=${kind} hidden=${hidden} blocks=${blocks.length}`);
    console.log(`  text: ${r.text}`);
    for (const block of blocks) {
      if (block.type === 'text') {
        console.log(`  [text] ${String(block.text).slice(0, 80)}`);
      } else if (block.type === 'tool_use') {
        console.log(`  [tool_use id=${block.id} name=${block.name}] params=${JSON.stringify(block.input).slice(0, 120)}`);
        toolUseIds.add(block.id);
      } else if (block.type === 'tool_result') {
        const trimmed = String(block.content).slice(0, 120);
        console.log(`  [tool_result id=${block.tool_use_id}] ${trimmed}`);
        toolResultIds.add(block.tool_use_id);
      }
    }
  }

  const unmatched = Array.from(toolUseIds).filter((id) => !toolResultIds.has(id));
  const orphanResults = Array.from(toolResultIds).filter((id) => !toolUseIds.has(id));
  console.log(`\nTool uses: ${toolUseIds.size}, tool results: ${toolResultIds.size}`);
  if (unmatched.length) console.log(`Unmatched tool_use ids (awaiting approval or lost): ${unmatched.join(', ')}`);
  if (orphanResults.length) console.log(`Orphan tool_result ids (no matching use): ${orphanResults.join(', ')}`);

  const actions = await db.execute(sql`
    SELECT id, action, approval_status, tool_use_id
    FROM agent_actions
    WHERE conversation_id = ${convoId}
    ORDER BY created_at ASC
  `);
  console.log(`\nActions in this conversation: ${actions.rows.length}`);
  for (const a of actions.rows as any[]) {
    console.log(`  ${a.action} status=${a.approval_status} tool_use_id=${a.tool_use_id ?? 'NULL'}`);
  }

  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
