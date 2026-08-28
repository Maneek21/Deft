import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { Hono } from 'hono';
import { attachmentRead } from '../src/lib/mcp-tools/attachments.js';
import { documentSend } from '../src/lib/mcp-tools/document-send.js';
import { fetchUnread } from '../src/lib/mcp-tools/messages.js';
import type { ToolContext, ToolResult } from '../src/lib/mcp-tools/types.js';
import { localFileStore } from '../src/lib/file-store.js';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let orgId = '';
let humanUserId = '';
let agentAUserId = '';
let agentBUserId = '';
let employeeAId = '';
let employeeBId = '';
let sourceSpaceId = '';
let sourceMessageId = '';
let testApp: Hono | null = null;
let storageKey: string | null = null;

async function withClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function toolPayload(result: ToolResult): any {
  return JSON.parse(result.content[0]?.text ?? 'null');
}

function employeeContext(which: 'a' | 'b'): ToolContext {
  return {
    org_id: orgId,
    employee_id: which === 'a' ? employeeAId : employeeBId,
    employee_slug: `handoff-${which}-${suffix}`,
    trust_level: 'autonomous',
    runtime_request_key: `handoff-${which}-runtime-${suffix}`,
  };
}

before(async () => {
  await withClient(async (client) => {
    const org = await client.query<{ id: string }>(
      `INSERT INTO orgs (id, name, slug) VALUES (gen_random_uuid()::text, 'Attachment handoff', $1) RETURNING id`,
      [`attachment-handoff-${suffix}`],
    );
    orgId = org.rows[0]!.id;
    const users = await client.query<{ id: string; name: string }>(
      `INSERT INTO users (id, email, name, kind, is_agent, email_verified) VALUES
        (gen_random_uuid()::text, $1, 'Handoff Human', 'human', false, true),
        (gen_random_uuid()::text, $2, 'Handoff Agent A', 'agent', true, true),
        (gen_random_uuid()::text, $3, 'Handoff Agent B', 'agent', true, true)
       RETURNING id, name`,
      [
        `handoff-human-${suffix}@test.local`,
        `handoff-a-${suffix}@test.local`,
        `handoff-b-${suffix}@test.local`,
      ],
    );
    humanUserId = users.rows.find((row) => row.name === 'Handoff Human')!.id;
    agentAUserId = users.rows.find((row) => row.name === 'Handoff Agent A')!.id;
    agentBUserId = users.rows.find((row) => row.name === 'Handoff Agent B')!.id;
    await client.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES
        (gen_random_uuid()::text, $1, $2, 'owner', true),
        (gen_random_uuid()::text, $1, $3, 'member', true),
        (gen_random_uuid()::text, $1, $4, 'member', true)`,
      [orgId, humanUserId, agentAUserId, agentBUserId],
    );
    const sourceSpace = await client.query<{ id: string }>(
      `INSERT INTO spaces (id, org_id, name, type, created_by)
       VALUES (gen_random_uuid()::text, $1, $2, 'private', $3) RETURNING id`,
      [orgId, `handoff-source-${suffix}`, humanUserId],
    );
    sourceSpaceId = sourceSpace.rows[0]!.id;
    await client.query(
      `INSERT INTO space_members (id, space_id, user_id) VALUES
        (gen_random_uuid()::text, $1, $2),
        (gen_random_uuid()::text, $1, $3)`,
      [sourceSpaceId, humanUserId, agentAUserId],
    );
    const employees = await client.query<{ id: string; name: string }>(
      `INSERT INTO agent_employees (
         id, org_id, user_id, name, slug, role, system_prompt, project_ids,
         trust_level, max_daily_actions, created_by, is_active, is_byoa
       ) VALUES
        (gen_random_uuid()::text, $1, $2, 'Handoff Agent A', $4, 'project_manager', 'test', ARRAY[]::text[], 'autonomous', 10, $6, true, true),
        (gen_random_uuid()::text, $1, $3, 'Handoff Agent B', $5, 'project_manager', 'test', ARRAY[]::text[], 'autonomous', 10, $6, true, true)
       RETURNING id, name`,
      [orgId, agentAUserId, agentBUserId, `handoff-a-${suffix}`, `handoff-b-${suffix}`, humanUserId],
    );
    employeeAId = employees.rows.find((row) => row.name === 'Handoff Agent A')!.id;
    employeeBId = employees.rows.find((row) => row.name === 'Handoff Agent B')!.id;
    const source = await client.query<{ id: string }>(
      `INSERT INTO messages (id, org_id, space_id, user_id, content)
       VALUES (gen_random_uuid()::text, $1, $2, $3, 'Send the reviewed handoff brief to Agent B')
       RETURNING id`,
      [orgId, sourceSpaceId, humanUserId],
    );
    sourceMessageId = source.rows[0]!.id;
  });

  const { agentRoutes } = await import('../src/routes/agent.js');
  testApp = new Hono();
  testApp.use('*', async (c, next) => {
    c.set('user', {
      id: humanUserId,
      email: `handoff-human-${suffix}@test.local`,
      org_id: orgId,
      role: 'owner',
    } as any);
    await next();
  });
  testApp.route('/api/agent', agentRoutes);
});

after(async () => {
  if (storageKey) await localFileStore.delete(storageKey);
  if (!orgId) return;
  await withClient(async (client) => {
    await client.query(`DELETE FROM action_receipts WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM agent_action_approvers WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM audit_log WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM agent_actions WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM attachment_derivatives WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM message_attachments WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM files WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM messages WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM agent_employees WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE org_id = $1)`, [orgId]);
    await client.query(`DELETE FROM spaces WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM org_members WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[humanUserId, agentAUserId, agentBUserId]]);
    await client.query(`DELETE FROM orgs WHERE id = $1`, [orgId]);
  });
});

test('one approved agent-to-agent document handoff is pull-readable without an automatic reply loop', async () => {
  const content = '# Handoff brief\n\nOwner: Agent B\nStatus: ready for review\n';
  const queuedResult = await documentSend({
    caller_employee_slug: employeeContext('a').employee_slug,
    source_message_id: sourceMessageId,
    filename: 'handoff-brief.md',
    mime_type: 'text/markdown',
    content,
    caption: 'Reviewed handoff brief for Agent B',
    target: { user_id: agentBUserId },
    idempotency_key: `handoff-brief-${suffix}`,
  }, employeeContext('a'));
  assert.equal(queuedResult.isError, false, queuedResult.content[0]?.text);
  const queued = toolPayload(queuedResult);
  assert.equal(queued.status, 'pending');

  const preApproval = await withClient(async (client) => (await client.query<{
    files: number;
    dm_spaces: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM files WHERE org_id = $1) AS files,
       (SELECT count(*)::int FROM spaces WHERE org_id = $1 AND type = 'dm') AS dm_spaces`,
    [orgId],
  )).rows[0]!);
  assert.deepEqual(preApproval, { files: 0, dm_spaces: 0 });

  const approvalResponse = await testApp!.request(`/api/agent/actions/${queued.action_id}/approve`, { method: 'POST' });
  const approvalText = await approvalResponse.text();
  assert.equal(approvalResponse.status, 200, approvalText);
  const approved = JSON.parse(approvalText) as any;
  assert.equal(approved.success, true, approvalText);
  storageKey = `${approved.result.file_id}-handoff-brief.md`;

  const inbox = toolPayload(await fetchUnread({
    caller_employee_slug: employeeContext('b').employee_slug,
    limit: 20,
  }, employeeContext('b')));
  const delivered = inbox.unread_messages.find((message: any) => message.id === approved.result.message_id);
  assert.ok(delivered, JSON.stringify(inbox));
  assert.equal(delivered.is_dm, true);
  assert.equal(delivered.attachments.length, 1);
  assert.equal(delivered.attachments[0].id, approved.result.file_id);
  assert.deepEqual(inbox.pending_actions, []);

  const read = await attachmentRead({
    caller_employee_slug: employeeContext('b').employee_slug,
    attachment_id: approved.result.file_id,
    mode: 'text',
  }, employeeContext('b'));
  assert.equal(read.isError, false, read.content[0]?.text);
  const readBody = toolPayload(read);
  assert.equal(readBody.content, content);
  assert.equal(readBody.trust, 'untrusted_attachment_content');

  const senderInbox = toolPayload(await fetchUnread({
    caller_employee_slug: employeeContext('a').employee_slug,
    space_id: approved.result.space_id,
  }, employeeContext('a')));
  assert.deepEqual(senderInbox.unread_messages, []);
  assert.deepEqual(senderInbox.pending_actions, []);

  const evidence = await withClient(async (client) => (await client.query<{
    dm_spaces: number;
    dm_members: number;
    messages: number;
    files: number;
    actions: number;
    receipts: number;
    channel_events: number;
    sender_budget: number;
    recipient_budget: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM spaces WHERE org_id = $1 AND type = 'dm') AS dm_spaces,
       (SELECT count(*)::int FROM space_members WHERE space_id = $2) AS dm_members,
       (SELECT count(*)::int FROM messages WHERE org_id = $1 AND space_id = $2) AS messages,
       (SELECT count(*)::int FROM files WHERE org_id = $1) AS files,
       (SELECT count(*)::int FROM agent_actions WHERE org_id = $1 AND action = 'document_send') AS actions,
       (SELECT count(*)::int FROM action_receipts WHERE org_id = $1 AND action_name = 'document_send') AS receipts,
       (SELECT count(*)::int FROM agent_channel_events WHERE org_id = $1) AS channel_events,
       (SELECT daily_action_count FROM agent_employees WHERE id = $3) AS sender_budget,
       (SELECT daily_action_count FROM agent_employees WHERE id = $4) AS recipient_budget`,
    [orgId, approved.result.space_id, employeeAId, employeeBId],
  )).rows[0]!);
  assert.deepEqual(evidence, {
    dm_spaces: 1,
    dm_members: 2,
    messages: 1,
    files: 1,
    actions: 1,
    receipts: 1,
    channel_events: 0,
    sender_budget: 1,
    recipient_budget: 0,
  });

  await withClient((client) => client.query(
    `DELETE FROM space_members WHERE space_id = $1 AND user_id = $2`,
    [approved.result.space_id, agentBUserId],
  ));
  const revoked = await attachmentRead({
    caller_employee_slug: employeeContext('b').employee_slug,
    attachment_id: approved.result.file_id,
    mode: 'text',
  }, employeeContext('b'));
  assert.equal(revoked.isError, true);
  assert.match(revoked.content[0]?.text ?? '', /not found or not visible/);
});
