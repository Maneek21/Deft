import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { attachmentList, attachmentRead } from '../src/lib/mcp-tools/attachments.js';
import { fetchUnread, threadFetch } from '../src/lib/mcp-tools/messages.js';
import { READ_ONLY_TOOLS, toolSchemas } from '../src/lib/mcp-tools/index.js';
import type { ToolContext, ToolResult } from '../src/lib/mcp-tools/types.js';
import { localFileStore } from '../src/lib/file-store.js';
import {
  getMessageAttachmentContext,
  getMessageTextAttachments,
} from '../src/lib/agent-message-attachments.js';
import { handleAgentEmployeeMessage } from '../src/workers/handlers/agent-employee-message.js';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let orgId = '';
let otherOrgId = '';
let humanUserId = '';
let agentUserId = '';
let otherUserId = '';
let employeeId = '';
let publicSpaceId = '';
let privateSpaceId = '';
let allowedProjectId = '';
let deniedProjectId = '';
let publicMessageId = '';
let privateMessageId = '';
let lazyMessageId = '';
let blockedMessageId = '';
let allowedTaskId = '';
let deniedTaskId = '';
let restrictedTaskId = '';
let publicFileId = '';
let privateFileId = '';
let allowedTaskFileId = '';
let deniedTaskFileId = '';
let restrictedTaskFileId = '';
let lazyFileId = '';
let blockedFileId = '';
let unattachedFileId = '';
let crossOrgFileId = '';
const lazyStorageKey = `${randomUUID()}-lazy.csv`;

async function withClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function ctx(): ToolContext {
  return {
    org_id: orgId,
    employee_id: employeeId,
    employee_slug: `attachment-agent-${suffix}`,
    trust_level: 'autonomous',
  };
}

function payload(result: ToolResult): any {
  return JSON.parse(result.content[0]?.text ?? 'null');
}

before(async () => {
  const lazyContent = Buffer.from('phase,owner\nBuild,Alex\n', 'utf8');
  await localFileStore.put(lazyStorageKey, lazyContent);
  await withClient(async (client) => {
    const orgs = await client.query<{ id: string; slug: string }>(
      `INSERT INTO orgs (id, name, slug) VALUES
        (gen_random_uuid()::text, 'Attachment boundary', $1),
        (gen_random_uuid()::text, 'Other attachment boundary', $2)
       RETURNING id, slug`,
      [`attachment-boundary-${suffix}`, `other-attachment-boundary-${suffix}`],
    );
    orgId = orgs.rows.find((row) => row.slug === `attachment-boundary-${suffix}`)!.id;
    otherOrgId = orgs.rows.find((row) => row.slug === `other-attachment-boundary-${suffix}`)!.id;

    const users = await client.query<{ id: string; name: string }>(
      `INSERT INTO users (id, email, name, kind, is_agent, email_verified) VALUES
        (gen_random_uuid()::text, $1, 'Attachment Human', 'human', false, true),
        (gen_random_uuid()::text, $2, 'Attachment Agent', 'agent', true, true),
        (gen_random_uuid()::text, $3, 'Other Attachment Human', 'human', false, true)
       RETURNING id, name`,
      [
        `attachment-human-${suffix}@test.local`,
        `attachment-agent-${suffix}@test.local`,
        `attachment-other-${suffix}@test.local`,
      ],
    );
    humanUserId = users.rows.find((row) => row.name === 'Attachment Human')!.id;
    agentUserId = users.rows.find((row) => row.name === 'Attachment Agent')!.id;
    otherUserId = users.rows.find((row) => row.name === 'Other Attachment Human')!.id;
    await client.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES
        (gen_random_uuid()::text, $1, $2, 'owner', true),
        (gen_random_uuid()::text, $1, $3, 'member', true),
        (gen_random_uuid()::text, $4, $5, 'owner', true)`,
      [orgId, humanUserId, agentUserId, otherOrgId, otherUserId],
    );

    const spaces = await client.query<{ id: string; name: string }>(
      `INSERT INTO spaces (id, org_id, name, type, created_by) VALUES
        (gen_random_uuid()::text, $1, $2, 'public', $3),
        (gen_random_uuid()::text, $1, $4, 'private', $3),
        (gen_random_uuid()::text, $5, $6, 'public', $7)
       RETURNING id, name`,
      [
        orgId,
        `attachment-public-${suffix}`,
        humanUserId,
        `attachment-private-${suffix}`,
        otherOrgId,
        `attachment-other-${suffix}`,
        otherUserId,
      ],
    );
    publicSpaceId = spaces.rows.find((row) => row.name === `attachment-public-${suffix}`)!.id;
    privateSpaceId = spaces.rows.find((row) => row.name === `attachment-private-${suffix}`)!.id;
    const otherSpaceId = spaces.rows.find((row) => row.name === `attachment-other-${suffix}`)!.id;
    await client.query(
      `INSERT INTO space_members (id, space_id, user_id) VALUES
        (gen_random_uuid()::text, $1, $2),
        (gen_random_uuid()::text, $1, $3),
        (gen_random_uuid()::text, $4, $2)`,
      [publicSpaceId, humanUserId, agentUserId, privateSpaceId],
    );

    const projects = await client.query<{ id: string; name: string }>(
      `INSERT INTO projects (id, org_id, name, prefix, lead_id, task_counter) VALUES
        (gen_random_uuid()::text, $1, $2, $3, $4, 1),
        (gen_random_uuid()::text, $1, $5, $6, $4, 1)
       RETURNING id, name`,
      [
        orgId,
        `Attachment allowed ${suffix}`,
        `A${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
        humanUserId,
        `Attachment denied ${suffix}`,
        `D${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
      ],
    );
    allowedProjectId = projects.rows.find((row) => row.name === `Attachment allowed ${suffix}`)!.id;
    deniedProjectId = projects.rows.find((row) => row.name === `Attachment denied ${suffix}`)!.id;
    const tasks = await client.query<{ id: string; project_id: string; title: string }>(
      `INSERT INTO tasks (id, org_id, project_id, number, title, status, priority, assignee_id, created_by) VALUES
        (gen_random_uuid()::text, $1, $2, 1, 'Allowed attachment task', 'todo', 'p2', $3, $3),
        (gen_random_uuid()::text, $1, $4, 1, 'Denied attachment task', 'todo', 'p2', $3, $3),
        (gen_random_uuid()::text, $1, $2, 2, 'Restricted attachment task', 'todo', 'p2', $3, $3)
       RETURNING id, project_id, title`,
      [orgId, allowedProjectId, humanUserId, deniedProjectId],
    );
    allowedTaskId = tasks.rows.find((row) => row.project_id === allowedProjectId)!.id;
    deniedTaskId = tasks.rows.find((row) => row.project_id === deniedProjectId)!.id;
    restrictedTaskId = tasks.rows.find((row) => row.title === 'Restricted attachment task')!.id;
    await client.query(
      `UPDATE tasks SET metadata = '{"visibility":"restricted"}'::jsonb WHERE id = $1`,
      [restrictedTaskId],
    );

    const employee = await client.query<{ id: string }>(
      `INSERT INTO agent_employees (
         id, org_id, user_id, name, slug, role, system_prompt, project_ids,
         trust_level, max_daily_actions, created_by, is_active, is_byoa
       ) VALUES (
         gen_random_uuid()::text, $1, $2, 'Attachment Agent', $3, 'project_manager',
         'test', ARRAY[$4]::text[], 'autonomous', 50, $5, true, true
       ) RETURNING id`,
      [orgId, agentUserId, `attachment-agent-${suffix}`, allowedProjectId, humanUserId],
    );
    employeeId = employee.rows[0]!.id;

    const messages = await client.query<{ id: string; content: string }>(
      `INSERT INTO messages (id, org_id, space_id, user_id, content) VALUES
        (gen_random_uuid()::text, $1, $2, $3, 'public attachment message'),
        (gen_random_uuid()::text, $1, $4, $3, 'private attachment message'),
        (gen_random_uuid()::text, $1, $2, $3, 'lazy attachment message'),
        (gen_random_uuid()::text, $1, $2, $3, 'blocked attachment message'),
        (gen_random_uuid()::text, $5, $6, $7, 'cross org attachment message')
       RETURNING id, content`,
      [orgId, publicSpaceId, humanUserId, privateSpaceId, otherOrgId, otherSpaceId, otherUserId],
    );
    publicMessageId = messages.rows.find((row) => row.content === 'public attachment message')!.id;
    privateMessageId = messages.rows.find((row) => row.content === 'private attachment message')!.id;
    lazyMessageId = messages.rows.find((row) => row.content === 'lazy attachment message')!.id;
    blockedMessageId = messages.rows.find((row) => row.content === 'blocked attachment message')!.id;
    const otherMessageId = messages.rows.find((row) => row.content === 'cross org attachment message')!.id;

    const fileRows = await client.query<{ id: string; filename: string }>(
      `INSERT INTO files (
         id, org_id, uploaded_by, filename, mime_type, detected_mime_type,
         size_bytes, storage_key, attachment_kind, processing_status, processing_error,
         content_sha256, processed_at, message_id
       ) VALUES
        (gen_random_uuid()::text, $1, $2, 'brief.txt', 'text/plain', 'text/plain', 12, $3, 'text', 'ready', NULL, $4, now(), NULL),
        (gen_random_uuid()::text, $1, $2, 'private.txt', 'text/plain', 'text/plain', 14, $5, 'text', 'ready', NULL, $4, now(), NULL),
        (gen_random_uuid()::text, $1, $2, 'allowed-task.txt', 'text/plain', 'text/plain', 12, $6, 'text', 'ready', NULL, $4, now(), NULL),
        (gen_random_uuid()::text, $1, $2, 'denied-task.txt', 'text/plain', 'text/plain', 11, $7, 'text', 'ready', NULL, $4, now(), NULL),
        (gen_random_uuid()::text, $1, $2, 'restricted-task.txt', 'text/plain', 'text/plain', 15, $8, 'text', 'ready', NULL, $4, now(), NULL),
        (gen_random_uuid()::text, $1, $2, 'lazy.csv', 'text/csv', NULL, $9, $10, 'binary', 'pending', NULL, NULL, NULL, $11),
        (gen_random_uuid()::text, $1, $2, 'blocked.exe', 'application/x-msdownload', 'application/x-executable', 2, $12, 'binary', 'blocked', 'unsafe_executable', $4, now(), NULL),
        (gen_random_uuid()::text, $1, $2, 'unattached.txt', 'text/plain', 'text/plain', 8, $13, 'text', 'ready', NULL, $4, now(), NULL),
        (gen_random_uuid()::text, $14, $15, 'other.txt', 'text/plain', 'text/plain', 12, $16, 'text', 'ready', NULL, $4, now(), NULL)
       RETURNING id, filename`,
      [
        orgId,
        humanUserId,
        `${randomUUID()}-brief.txt`,
        `sha256:${'a'.repeat(64)}`,
        `${randomUUID()}-private.txt`,
        `${randomUUID()}-allowed-task.txt`,
        `${randomUUID()}-denied-task.txt`,
        `${randomUUID()}-restricted-task.txt`,
        lazyContent.byteLength,
        lazyStorageKey,
        lazyMessageId,
        `${randomUUID()}-blocked.exe`,
        `${randomUUID()}-unattached.txt`,
        otherOrgId,
        otherUserId,
        `${randomUUID()}-other.txt`,
      ],
    );
    const fileId = (name: string) => fileRows.rows.find((row) => row.filename === name)!.id;
    publicFileId = fileId('brief.txt');
    privateFileId = fileId('private.txt');
    allowedTaskFileId = fileId('allowed-task.txt');
    deniedTaskFileId = fileId('denied-task.txt');
    restrictedTaskFileId = fileId('restricted-task.txt');
    lazyFileId = fileId('lazy.csv');
    blockedFileId = fileId('blocked.exe');
    unattachedFileId = fileId('unattached.txt');
    crossOrgFileId = fileId('other.txt');

    await client.query(
      `INSERT INTO message_attachments (org_id, message_id, file_id, position) VALUES
        ($1, $2, $3, 0), ($1, $4, $5, 0), ($1, $6, $7, 0)`,
      [orgId, publicMessageId, publicFileId, privateMessageId, privateFileId, blockedMessageId, blockedFileId],
    );
    await client.query(
      `INSERT INTO task_attachments (org_id, task_id, file_id, position) VALUES
        ($1, $2, $3, 0), ($1, $4, $5, 0), ($1, $6, $7, 0)`,
      [
        orgId,
        allowedTaskId,
        allowedTaskFileId,
        deniedTaskId,
        deniedTaskFileId,
        restrictedTaskId,
        restrictedTaskFileId,
      ],
    );
    await client.query(
      `INSERT INTO message_attachments (org_id, message_id, file_id, position) VALUES ($1, $2, $3, 0)`,
      [otherOrgId, otherMessageId, crossOrgFileId],
    );
    await client.query(
      `INSERT INTO attachment_derivatives (org_id, file_id, kind, mime_type, content, size_bytes) VALUES
        ($1, $2, 'text', 'text/plain', 'public brief', 12),
        ($1, $3, 'text', 'text/plain', 'private brief', 13),
        ($1, $4, 'text', 'text/plain', 'allowed task', 12),
        ($1, $5, 'text', 'text/plain', 'denied task', 11),
        ($1, $6, 'text', 'text/plain', 'restricted task', 15),
        ($1, $7, 'text', 'text/plain', 'detached', 8),
        ($8, $9, 'text', 'text/plain', 'other secret', 12)`,
      [
        orgId,
        publicFileId,
        privateFileId,
        allowedTaskFileId,
        deniedTaskFileId,
        restrictedTaskFileId,
        unattachedFileId,
        otherOrgId,
        crossOrgFileId,
      ],
    );
  });
});

after(async () => {
  await localFileStore.delete(lazyStorageKey);
  if (!orgId) return;
  await withClient(async (client) => {
    for (const id of [orgId, otherOrgId]) {
      await client.query(`DELETE FROM agent_channel_delivery_attempts WHERE org_id = $1`, [id]);
      await client.query(`DELETE FROM agent_channel_events WHERE org_id = $1`, [id]);
      await client.query(`DELETE FROM agent_channel_cursors WHERE org_id = $1`, [id]);
      await client.query(`DELETE FROM agent_channel_connections WHERE org_id = $1`, [id]);
      await client.query(`DELETE FROM notifications WHERE org_id = $1`, [id]);
      await client.query(`DELETE FROM agent_actions WHERE org_id = $1`, [id]);
      await client.query(`DELETE FROM attachment_derivatives WHERE org_id = $1`, [id]);
      await client.query(`DELETE FROM message_attachments WHERE org_id = $1`, [id]);
      await client.query(`DELETE FROM task_attachments WHERE org_id = $1`, [id]);
      await client.query(`DELETE FROM files WHERE org_id = $1`, [id]);
      await client.query(`DELETE FROM messages WHERE org_id = $1`, [id]);
      await client.query(`DELETE FROM tasks WHERE org_id = $1`, [id]);
      await client.query(`DELETE FROM agent_employees WHERE org_id = $1`, [id]);
      await client.query(`DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE org_id = $1)`, [id]);
      await client.query(`DELETE FROM spaces WHERE org_id = $1`, [id]);
      await client.query(`DELETE FROM projects WHERE org_id = $1`, [id]);
      await client.query(`DELETE FROM org_members WHERE org_id = $1`, [id]);
    }
    await client.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[humanUserId, agentUserId, otherUserId]]);
    await client.query(`DELETE FROM orgs WHERE id = ANY($1::text[])`, [[orgId, otherOrgId]]);
  });
});

test('attachment tools are registered with stock-Hermes MCP schemas', () => {
  assert.equal(typeof READ_ONLY_TOOLS.attachment_list, 'function');
  assert.equal(typeof READ_ONLY_TOOLS.attachment_read, 'function');
  assert.ok(toolSchemas.some((schema) => schema.name === 'attachment_list'));
  assert.ok(toolSchemas.some((schema) => schema.name === 'attachment_read'));
});

test('visible typed message attachments list and read without storage secrets', async () => {
  const listed = await attachmentList({ caller_employee_slug: ctx().employee_slug, message_id: publicMessageId }, ctx());
  assert.equal(listed.isError, false, listed.content[0]?.text);
  const body = payload(listed);
  assert.equal(body.attachments[0].id, publicFileId);
  assert.deepEqual(body.attachments[0].read_modes, ['text']);
  assert.equal(JSON.stringify(body).includes('storage_key'), false);

  const read = await attachmentRead({
    caller_employee_slug: ctx().employee_slug,
    attachment_id: publicFileId,
    mode: 'text',
  }, ctx());
  assert.equal(read.isError, false, read.content[0]?.text);
  assert.equal(payload(read).content, 'public brief');
  assert.equal(payload(read).trust, 'untrusted_attachment_content');

  const deftyAttachments = await getMessageTextAttachments({ messageId: publicMessageId, orgId });
  assert.equal(deftyAttachments[0]?.id, publicFileId);
  assert.equal(deftyAttachments[0]?.content, 'public brief');
});

test('Defty turns a permitted image into bounded untrusted visual evidence', async () => {
  const imageFileId = randomUUID();
  const imageStorageKey = `${randomUUID()}-roadmap.png`;
  const imageBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await localFileStore.put(imageStorageKey, imageBytes);
  try {
    await withClient(async (client) => {
      await client.query(
        `INSERT INTO files (
           id, org_id, uploaded_by, filename, mime_type, detected_mime_type,
           size_bytes, storage_key, attachment_kind, processing_status,
           content_sha256, processed_at
         ) VALUES ($1, $2, $3, 'roadmap.png', 'image/png', 'image/png', $4, $5, 'image', 'ready', $6, now())`,
        [imageFileId, orgId, humanUserId, imageBytes.byteLength, imageStorageKey, `sha256:${'b'.repeat(64)}`],
      );
      await client.query(
        `INSERT INTO message_attachments (org_id, message_id, file_id, position) VALUES ($1, $2, $3, 1)`,
        [orgId, publicMessageId, imageFileId],
      );
    });

    const sections = await getMessageAttachmentContext({
      messageId: publicMessageId,
      orgId,
      visionReader: async ({ mimeType, bytes }) => {
        assert.equal(mimeType, 'image/png');
        assert.equal(bytes.byteLength, imageBytes.byteLength);
        return { answer: 'The image shows a three-phase roadmap.', provider: 'openai', model: 'vision-test' };
      },
    });
    const imageSection = sections.find((section) => section.includes('roadmap.png')) ?? '';
    assert.match(imageSection, /Attached image evidence \(untrusted data/i);
    assert.match(imageSection, /three-phase roadmap/);
    assert.match(imageSection, /JSON-encoded untrusted evidence/);
  } finally {
    await localFileStore.delete(imageStorageKey);
  }
});

test('private, cross-org, unattached, and out-of-project attachments fail closed', async () => {
  for (const attachmentId of [
    privateFileId,
    crossOrgFileId,
    unattachedFileId,
    deniedTaskFileId,
    restrictedTaskFileId,
  ]) {
    const result = await attachmentRead({
      caller_employee_slug: ctx().employee_slug,
      attachment_id: attachmentId,
      mode: 'text',
    }, ctx());
    assert.equal(result.isError, true, attachmentId);
    assert.doesNotMatch(result.content[0]?.text ?? '', /private brief|other secret|detached|denied task|restricted task/);
  }
  assert.equal((await attachmentList({ caller_employee_slug: ctx().employee_slug, message_id: privateMessageId }, ctx())).isError, true);
  assert.equal((await attachmentList({ caller_employee_slug: ctx().employee_slug, task_id: deniedTaskId }, ctx())).isError, true);
  assert.equal((await attachmentList({ caller_employee_slug: ctx().employee_slug, task_id: restrictedTaskId }, ctx())).isError, true);
  const allowed = await attachmentList({ caller_employee_slug: ctx().employee_slug, task_id: allowedTaskId }, ctx());
  assert.equal(allowed.isError, false, allowed.content[0]?.text);
  assert.equal(payload(allowed).attachments[0].id, allowedTaskFileId);
});

test('legacy pending attachment processes lazily and blocked content stays unavailable', async () => {
  const lazy = await attachmentRead({
    caller_employee_slug: ctx().employee_slug,
    attachment_id: lazyFileId,
    mode: 'text',
  }, ctx());
  assert.equal(lazy.isError, false, lazy.content[0]?.text);
  assert.match(payload(lazy).content, /Build,Alex/);
  const persisted = await withClient((client) => client.query<{ processing_status: string }>(
    `SELECT processing_status FROM files WHERE id = $1`,
    [lazyFileId],
  ));
  assert.equal(persisted.rows[0]?.processing_status, 'ready');

  const blocked = await attachmentRead({
    caller_employee_slug: ctx().employee_slug,
    attachment_id: blockedFileId,
    mode: 'text',
  }, ctx());
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0]?.text ?? '', /blocked by safety policy.*unsafe_executable/);
});

test('thread and unread payloads carry bounded manifests without file URLs', async () => {
  const thread = await threadFetch({ caller_employee_slug: ctx().employee_slug, parent_message_id: publicMessageId }, ctx());
  assert.equal(thread.isError, false, thread.content[0]?.text);
  const threadMessage = payload(thread).find((message: any) => message.id === publicMessageId);
  assert.equal(threadMessage.attachments[0].id, publicFileId);
  assert.equal(JSON.stringify(threadMessage.attachments).includes('storage_key'), false);

  const unread = await fetchUnread({ caller_employee_slug: ctx().employee_slug, limit: 100 }, ctx());
  assert.equal(unread.isError, false, unread.content[0]?.text);
  const unreadMessage = payload(unread).unread_messages.find((message: any) => message.id === publicMessageId);
  assert.equal(unreadMessage.attachments[0].id, publicFileId);
});

test('employee live event and pull fallback carry the same safe attachment manifest', async () => {
  await handleAgentEmployeeMessage({
    id: randomUUID(),
    name: 'agent-employee-message',
    data: {
      messageId: publicMessageId,
      spaceId: publicSpaceId,
      orgId,
      employeeId,
      isDM: false,
    },
  } as any);

  const rows = await withClient(async (client) => {
    const event = await client.query<{ payload: any }>(
      `SELECT payload FROM agent_channel_events
       WHERE org_id = $1 AND agent_employee_id = $2 AND source_id = $3
       ORDER BY created_at DESC LIMIT 1`,
      [orgId, employeeId, publicMessageId],
    );
    const action = await client.query<{ params: any }>(
      `SELECT params FROM agent_actions
       WHERE org_id = $1 AND agent_employee_id = $2 AND params->>'message_id' = $3
       ORDER BY created_at DESC LIMIT 1`,
      [orgId, employeeId, publicMessageId],
    );
    return { event: event.rows[0]?.payload, action: action.rows[0]?.params };
  });
  assert.equal(rows.event.attachments[0].id, publicFileId);
  assert.deepEqual(rows.action.attachments, rows.event.attachments);
  assert.equal(JSON.stringify(rows).includes('storage_key'), false);
});
