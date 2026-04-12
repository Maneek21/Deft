/**
 * Dump the latest conversation for a given agent employee, showing each
 * message row's content_blocks structure and confirming tool_use/tool_result
 * pairs are correctly linked by tool_use_id.
 *
 * Run: pnpm --filter @deft/api exec tsx src/scripts/verify-structured-history.ts
 */
import { db } from '../lib/db.js';
import { sql } from 'drizzle-orm';

const EMPLOYEE_ID = '7e79b0a9-f88c-49f4-b79d-ab8a7c7f1633';

async function main() {
  const convs = await db.execute(sql`
    SELECT id FROM agent_conversations
    WHERE agent_employee_id = ${EMPLOYEE_ID}
    ORDER BY updated_at DESC LIMIT 1
  `);
  if (convs.rows.length === 0) {
    console.log('No conversations.');
    process.exit(0);
  }
  const convoId = (convs.rows[0] as any).id;
  console.log(`Conversation: ${convoId}`);

  const msgs = await db.execute(sql`
    SELECT id, role, hidden, created_at, LEFT(content, 60) AS text,
      content_blocks IS NOT NULL AS has_blocks, content_blocks
    FROM agent_messages
    WHERE conversation_id = ${convoId}
    ORDER BY created_at ASC
  `);

  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();
  for (const r of msgs.rows as any[]) {
    console.log(`\n[${r.created_at}] ${r.role} hidden=${r.hidden} has_blocks=${r.has_blocks}`);
    console.log(`  text: ${r.text}`);
    if (r.has_blocks && Array.isArray(r.content_blocks)) {
      for (const block of r.content_blocks) {
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
