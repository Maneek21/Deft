import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { Hono } from 'hono';
import {
  DOCUMENT_SEND_ACTION,
  executeDocumentSend,
  validateDocumentSendDraft,
} from '../src/lib/document-send.js';
import { getVisibleAttachment } from '../src/lib/attachment-access.js';
import { localFileStore } from '../src/lib/file-store.js';
import { documentSend } from '../src/lib/mcp-tools/document-send.js';
import { toolSchemas, WRITE_TOOLS } from '../src/lib/mcp-tools/index.js';
import type { ToolContext, ToolResult } from '../src/lib/mcp-tools/types.js';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let orgId = '';
let humanUserId = '';
let agentUserId = '';
let outsiderUserId = '';
let employeeId = '';
let sourceSpaceId = '';
let hiddenSpaceId = '';
let sourceMessageId = '';
let testApp: Hono | null = null;
const storageKeys = new Set<string>();

async function withClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function context(): ToolContext {
  return {
    org_id: orgId,
    employee_id: employeeId,
    employee_slug: `document-agent-${suffix}`,
    trust_level: 'autonomous',
    runtime_request_key: `document-runtime-${suffix}`,
  };
}

function payload(result: ToolResult): any {
  return JSON.parse(result.content[0]?.text ?? 'null');
}

before(async () => {
  await withClient(async (client) => {
    const org = await client.query<{ id: string }>(
      `INSERT INTO orgs (id, name, slug) VALUES (gen_random_uuid()::text, 'Document send', $1) RETURNING id`,
      [`document-send-${suffix}`],
    );
    orgId = org.rows[0]!.id;
    const userRows = await client.query<{ id: string; name: string }>(
      `INSERT INTO users (id, email, name, kind, is_agent, email_verified) VALUES
        (gen_random_uuid()::text, $1, 'Document Human', 'human', false, true),
        (gen_random_uuid()::text, $2, 'Document Agent', 'agent', true, true),
        (gen_random_uuid()::text, $3, 'Document Outsider', 'human', false, true)
       RETURNING id, name`,
      [
        `document-human-${suffix}@test.local`,
        `document-agent-${suffix}@test.local`,
        `document-outsider-${suffix}@test.local`,
      ],
    );
    humanUserId = userRows.rows.find((row) => row.name === 'Document Human')!.id;
    agentUserId = userRows.rows.find((row) => row.name === 'Document Agent')!.id;
    outsiderUserId = userRows.rows.find((row) => row.name === 'Document Outsider')!.id;
    await client.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES
        (gen_random_uuid()::text, $1, $2, 'owner', true),
        (gen_random_uuid()::text, $1, $3, 'member', true),
        (gen_random_uuid()::text, $1, $4, 'member', true)`,
      [orgId, humanUserId, agentUserId, outsiderUserId],
    );
    const spaces = await client.query<{ id: string; name: string }>(
      `INSERT INTO spaces (id, org_id, name, type, created_by) VALUES
        (gen_random_uuid()::text, $1, $2, 'private', $4),
        (gen_random_uuid()::text, $1, $3, 'private', $4)
       RETURNING id, name`,
      [orgId, `document-source-${suffix}`, `document-hidden-${suffix}`, humanUserId],
    );
    sourceSpaceId = spaces.rows.find((row) => row.name === `document-source-${suffix}`)!.id;
    hiddenSpaceId = spaces.rows.find((row) => row.name === `document-hidden-${suffix}`)!.id;
    await client.query(
      `INSERT INTO space_members (id, space_id, user_id) VALUES
        (gen_random_uuid()::text, $1, $2),
        (gen_random_uuid()::text, $1, $3),
        (gen_random_uuid()::text, $4, $2)`,
      [sourceSpaceId, humanUserId, agentUserId, hiddenSpaceId],
    );
    const employee = await client.query<{ id: string }>(
      `INSERT INTO agent_employees (
         id, org_id, user_id, name, slug, role, system_prompt, project_ids,
         trust_level, max_daily_actions, created_by, is_active, is_byoa
       ) VALUES (
         gen_random_uuid()::text, $1, $2, 'Document Agent', $3, 'project_manager',
         'test', ARRAY[]::text[], 'autonomous', 50, $4, true, true
       ) RETURNING id`,
      [orgId, agentUserId, `document-agent-${suffix}`, humanUserId],
    );
    employeeId = employee.rows[0]!.id;
    const source = await client.query<{ id: string }>(
      `INSERT INTO messages (id, org_id, space_id, user_id, content)
       VALUES (gen_random_uuid()::text, $1, $2, $3, 'Create and share the requested report')
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
      email: `document-human-${suffix}@test.local`,
      org_id: orgId,
      role: 'owner',
    } as any);
    await next();
  });
  testApp.route('/api/agent', agentRoutes);
});

after(async () => {
  for (const key of storageKeys) await localFileStore.delete(key);
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
    await client.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[humanUserId, agentUserId, outsiderUserId]]);
    await client.query(`DELETE FROM orgs WHERE id = $1`, [orgId]);
  });
});

test('document draft validation supports bounded text formats and blocks active CSV cells', () => {
  assert.equal(WRITE_TOOLS.document_send, documentSend);
  assert.ok(toolSchemas.some((tool) => tool.name === 'document_send'));
  assert.doesNotThrow(() => validateDocumentSendDraft({
    filename: 'report.md',
    mime_type: 'text/markdown',
    content: '# Report\n\nAll clear.',
  }));
  assert.throws(() => validateDocumentSendDraft({
    filename: 'report.txt',
    mime_type: 'text/markdown',
    content: '# Wrong extension',
  }), /extension does not match/);
  assert.throws(() => validateDocumentSendDraft({
    filename: 'report.csv',
    mime_type: 'text/csv',
    content: 'Name,Value\nAttack,"=HYPERLINK(""https://attacker.test"")"',
  }), /formula-like cells/);
});

test('stock Hermes queues full review; approval atomically shares one protected document with a receipt', async () => {
  const content = '# Launch report\n\n- Scope reviewed\n- No buyer promise\n';
  const args = {
    caller_employee_slug: context().employee_slug,
    source_message_id: sourceMessageId,
    filename: 'launch-report.md',
    mime_type: 'text/markdown' as const,
    content,
    caption: 'Launch report ready for review',
    idempotency_key: `launch-report-${suffix}`,
  };
  const queued = await documentSend(args, context());
  assert.equal(queued.isError, false, queued.content[0]?.text);
  const body = payload(queued);
  assert.equal(body.status, 'pending');
  assert.match(body.message, /No file or message has been created yet/);
  assert.equal(body.preview.content, undefined);
  assert.match(body.preview.content_sha256, /^sha256:[a-f0-9]{64}$/);
  assert.match(body.preview.preview_digest, /^sha256:[a-f0-9]{64}$/);

  const repeated = payload(await documentSend(args, context()));
  assert.equal(repeated.action_id, body.action_id);
  assert.equal(repeated.idempotent, true);

  const before = await withClient(async (client) => (await client.query<{ files: number; messages: number }>(
    `SELECT
       (SELECT count(*)::int FROM files WHERE org_id = $1) AS files,
       (SELECT count(*)::int FROM messages WHERE org_id = $1) AS messages`,
    [orgId],
  )).rows[0]!);
  assert.deepEqual(before, { files: 0, messages: 1 });
  const originalParams = await withClient(async (client) => (await client.query<{ params: Record<string, unknown> }>(
    `SELECT params FROM agent_actions WHERE id = $1`,
    [body.action_id],
  )).rows[0]!.params);

  const response = await testApp!.request(`/api/agent/actions/${body.action_id}/approve`, { method: 'POST' });
  const responseText = await response.text();
  assert.equal(response.status, 200, responseText);
  const approved = JSON.parse(responseText) as any;
  assert.equal(approved.success, true, JSON.stringify(approved));
  assert.equal(approved.result.replayed, false);
  storageKeys.add(`${approved.result.file_id}-launch-report.md`);

  const committed = await withClient(async (client) => (await client.query<{
    files: number;
    messages: number;
    links: number;
    derivatives: number;
    receipts: number;
    channel_events: number;
    action_params: Record<string, unknown>;
    receipt_params: Record<string, unknown>;
  }>(
    `SELECT
       (SELECT count(*)::int FROM files WHERE org_id = $1) AS files,
       (SELECT count(*)::int FROM messages WHERE org_id = $1) AS messages,
       (SELECT count(*)::int FROM message_attachments WHERE org_id = $1) AS links,
       (SELECT count(*)::int FROM attachment_derivatives WHERE org_id = $1) AS derivatives,
       (SELECT count(*)::int FROM action_receipts WHERE action_id = $2) AS receipts,
       (SELECT count(*)::int FROM agent_channel_events WHERE org_id = $1) AS channel_events,
       (SELECT params FROM agent_actions WHERE id = $2) AS action_params,
       (SELECT action_params_json FROM action_receipts WHERE action_id = $2 LIMIT 1) AS receipt_params`,
    [orgId, body.action_id],
  )).rows[0]!);
  assert.deepEqual(
    {
      files: committed.files,
      messages: committed.messages,
      links: committed.links,
      derivatives: committed.derivatives,
      receipts: committed.receipts,
      channel_events: committed.channel_events,
    },
    { files: 1, messages: 2, links: 1, derivatives: 1, receipts: 1, channel_events: 0 },
  );
  assert.equal(committed.action_params.content, undefined);
  assert.equal(committed.receipt_params.content, undefined);

  const bytes = await localFileStore.get(`${approved.result.file_id}-launch-report.md`);
  assert.equal(bytes.toString('utf8'), content);
  assert.ok(await getVisibleAttachment(approved.result.file_id, orgId, humanUserId));
  assert.equal(await getVisibleAttachment(approved.result.file_id, orgId, outsiderUserId), null);
  assert.equal(await getVisibleAttachment(approved.result.file_id, 'wrong-org', humanUserId), null);

  const replay = await executeDocumentSend({
    actionId: body.action_id,
    actionParams: originalParams,
    orgId,
    actorUserId: agentUserId,
    employeeId,
  });
  assert.equal(replay.replayed, true);
  const finalCounts = await withClient(async (client) => (await client.query<{ files: number; messages: number }>(
    `SELECT
       (SELECT count(*)::int FROM files WHERE org_id = $1) AS files,
       (SELECT count(*)::int FROM messages WHERE org_id = $1) AS messages`,
    [orgId],
  )).rows[0]!);
  assert.deepEqual(finalCounts, { files: 1, messages: 2 });

  await withClient((client) => client.query(
    `DELETE FROM space_members WHERE space_id = $1 AND user_id = $2`,
    [sourceSpaceId, humanUserId],
  ));
  assert.equal(await getVisibleAttachment(approved.result.file_id, orgId, humanUserId), null);
  await withClient((client) => client.query(
    `INSERT INTO space_members (id, space_id, user_id) VALUES (gen_random_uuid()::text, $1, $2)`,
    [sourceSpaceId, humanUserId],
  ));
});

test('document send fails closed when the target or source access is unavailable', async () => {
  const hidden = await documentSend({
    caller_employee_slug: context().employee_slug,
    source_message_id: sourceMessageId,
    filename: 'hidden.txt',
    mime_type: 'text/plain',
    content: 'Do not leak this.',
    target: { space_id: hiddenSpaceId },
    idempotency_key: `hidden-${suffix}`,
  }, context());
  assert.equal(hidden.isError, true);
  assert.match(hidden.content[0]?.text ?? '', /Target space is not accessible/);

  const queued = payload(await documentSend({
    caller_employee_slug: context().employee_slug,
    source_message_id: sourceMessageId,
    filename: 'revoked.txt',
    mime_type: 'text/plain',
    content: 'This should never be written.',
    idempotency_key: `revoked-${suffix}`,
  }, context()));
  const action = await withClient(async (client) => (await client.query<{ params: Record<string, unknown> }>(
    `SELECT params FROM agent_actions WHERE id = $1`,
    [queued.action_id],
  )).rows[0]!);
  await withClient((client) => client.query(`UPDATE messages SET is_deleted = true WHERE id = $1`, [sourceMessageId]));
  const failure = await import('../src/lib/agent-actions.js').then(({ executeAction }) => executeAction(
    queued.action_id,
    DOCUMENT_SEND_ACTION,
    action.params,
    orgId,
    agentUserId,
    { agentEmployeeId: employeeId },
  ));
  assert.equal(failure.success, false);
  assert.match(failure.error ?? '', /Source message is unavailable/);
  await withClient((client) => client.query(`UPDATE messages SET is_deleted = false WHERE id = $1`, [sourceMessageId]));
  const fileCount = await withClient(async (client) => (await client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM files WHERE org_id = $1`,
    [orgId],
  )).rows[0]!.count);
  assert.equal(fileCount, 1);
});

test('approved agent output covers plain text and inert CSV without public links', async () => {
  const cases = [
    {
      filename: 'notes.txt',
      mime_type: 'text/plain' as const,
      content: 'Reviewed notes\nNo external promises.\n',
    },
    {
      filename: 'plan.csv',
      mime_type: 'text/csv' as const,
      content: 'Task,Owner,Days\nReview,Ada,2\nShip,Lin,3\n',
    },
  ];
  const before = await withClient(async (client) => (await client.query<{ files: number; messages: number }>(
    `SELECT
       (SELECT count(*)::int FROM files WHERE org_id = $1) AS files,
       (SELECT count(*)::int FROM messages WHERE org_id = $1) AS messages`,
    [orgId],
  )).rows[0]!);

  for (const item of cases) {
    const queued = payload(await documentSend({
      caller_employee_slug: context().employee_slug,
      source_message_id: sourceMessageId,
      ...item,
      idempotency_key: `${item.filename}-${suffix}`,
    }, context()));
    const response = await testApp!.request(`/api/agent/actions/${queued.action_id}/approve`, { method: 'POST' });
    const responseText = await response.text();
    assert.equal(response.status, 200, responseText);
    const approved = JSON.parse(responseText) as any;
    assert.equal(approved.success, true, responseText);
    assert.equal(approved.result.url, `/api/files/${approved.result.file_id}`);
    assert.equal(/^https?:\/\//.test(approved.result.url), false);
    const key = `${approved.result.file_id}-${item.filename}`;
    storageKeys.add(key);
    assert.equal((await localFileStore.get(key)).toString('utf8'), item.content);
    assert.ok(await getVisibleAttachment(approved.result.file_id, orgId, humanUserId));
  }

  const afterCounts = await withClient(async (client) => (await client.query<{
    files: number;
    messages: number;
    ready: number;
    receipts: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM files WHERE org_id = $1) AS files,
       (SELECT count(*)::int FROM messages WHERE org_id = $1) AS messages,
       (SELECT count(*)::int FROM files WHERE org_id = $1 AND processing_status = 'ready') AS ready,
       (SELECT count(*)::int FROM action_receipts WHERE org_id = $1 AND action_name = 'document_send' AND decision = 'approved') AS receipts`,
    [orgId],
  )).rows[0]!);
  assert.equal(afterCounts.files, before.files + 2);
  assert.equal(afterCounts.messages, before.messages + 2);
  assert.equal(afterCounts.ready, 3);
  assert.equal(afterCounts.receipts, 3);
});

test('Defty-created documents are authored by Defty rather than the human approver', async () => {
  const content = '# Defty note\n\nPrepared for the current conversation.\n';
  const { actionId } = await withClient(async (client) => {
    const proposalMessage = await client.query<{ id: string }>(
      `INSERT INTO messages (id, org_id, space_id, user_id, content, metadata)
       VALUES (gen_random_uuid()::text, $1, $2, $3, 'I drafted a document for approval.', '{"is_agent_reply":true}'::jsonb)
       RETURNING id`,
      [orgId, sourceSpaceId, agentUserId],
    );
    const action = await client.query<{ id: string }>(
      `INSERT INTO agent_actions (
         id, org_id, user_id, conversation_id, message_id, source, action, params,
         approval_tier, approval_status
       ) VALUES (
         gen_random_uuid()::text, $1, $2, $3, $4, 'defty_capture', 'document_send', $5::jsonb,
         'full', 'pending'
       ) RETURNING id`,
      [
        orgId,
        humanUserId,
        sourceSpaceId,
        proposalMessage.rows[0]!.id,
        JSON.stringify({
          source_message_id: sourceMessageId,
          filename: 'defty-note.md',
          mime_type: 'text/markdown',
          content,
          caption: 'Defty note ready',
          idempotency_key: `defty-note-${suffix}`,
        }),
      ],
    );
    return { actionId: action.rows[0]!.id };
  });

  const response = await testApp!.request(`/api/agent/actions/${actionId}/approve`, { method: 'POST' });
  const responseText = await response.text();
  assert.equal(response.status, 200, responseText);
  const approved = JSON.parse(responseText) as any;
  assert.equal(approved.success, true, responseText);
  storageKeys.add(`${approved.result.file_id}-defty-note.md`);
  const authorship = await withClient(async (client) => (await client.query<{
    message_user_id: string;
    uploaded_by: string;
    proposer: string;
    receipt_params: Record<string, unknown>;
  }>(
    `SELECT
       (SELECT user_id FROM messages WHERE id = $1) AS message_user_id,
       (SELECT uploaded_by FROM files WHERE id = $2) AS uploaded_by,
       (SELECT proposer FROM action_receipts WHERE action_id = $3 LIMIT 1) AS proposer,
       (SELECT action_params_json FROM action_receipts WHERE action_id = $3 LIMIT 1) AS receipt_params`,
    [approved.result.message_id, approved.result.file_id, actionId],
  )).rows[0]!);
  assert.equal(authorship.message_user_id, agentUserId);
  assert.equal(authorship.uploaded_by, agentUserId);
  assert.equal(authorship.proposer, 'defty');
  assert.equal(authorship.receipt_params.content, undefined);
});

test('rejecting a document scrubs draft content and creates neither file nor message', async () => {
  const before = await withClient(async (client) => (await client.query<{ files: number; messages: number }>(
    `SELECT
       (SELECT count(*)::int FROM files WHERE org_id = $1) AS files,
       (SELECT count(*)::int FROM messages WHERE org_id = $1) AS messages`,
    [orgId],
  )).rows[0]!);
  const queued = payload(await documentSend({
    caller_employee_slug: context().employee_slug,
    source_message_id: sourceMessageId,
    filename: 'rejected.txt',
    mime_type: 'text/plain',
    content: 'This draft must be discarded.',
    idempotency_key: `rejected-${suffix}`,
  }, context()));
  const response = await testApp!.request(`/api/agent/actions/${queued.action_id}/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'Not ready' }),
  });
  const responseText = await response.text();
  assert.equal(response.status, 200, responseText);
  const afterState = await withClient(async (client) => (await client.query<{
    files: number;
    messages: number;
    status: string;
    params: Record<string, unknown>;
    decision: string;
    receipt_params: Record<string, unknown>;
  }>(
    `SELECT
       (SELECT count(*)::int FROM files WHERE org_id = $1) AS files,
       (SELECT count(*)::int FROM messages WHERE org_id = $1) AS messages,
       (SELECT approval_status FROM agent_actions WHERE id = $2) AS status,
       (SELECT params FROM agent_actions WHERE id = $2) AS params,
       (SELECT decision FROM action_receipts WHERE action_id = $2 LIMIT 1) AS decision,
       (SELECT action_params_json FROM action_receipts WHERE action_id = $2 LIMIT 1) AS receipt_params`,
    [orgId, queued.action_id],
  )).rows[0]!);
  assert.equal(afterState.files, before.files);
  assert.equal(afterState.messages, before.messages);
  assert.equal(afterState.status, 'rejected');
  assert.equal(afterState.params.content, undefined);
  assert.equal(afterState.receipt_params.content, undefined);
  assert.equal(afterState.decision, 'rejected');
});
