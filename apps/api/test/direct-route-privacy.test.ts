/**
 * Regression coverage for direct-ID route authorization.
 *
 * Run:
 *   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/deft \
 *   pnpm --filter @deft/api exec tsx --test --test-concurrency=1 test/direct-route-privacy.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import pg from 'pg';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';
const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';

const stamp = Date.now();
const USER_ID = `drp-user-${stamp}`;
const USER_EMAIL = `drp-user-${stamp}@test.local`;
const OTHER_USER_ID = `drp-other-${stamp}`;
const OTHER_EMAIL = `drp-other-${stamp}@test.local`;
const SECRET_TERM = `directrouteprivacy${stamp}z`;

const ids: { table: string; id: string }[] = [];

let visibleSpaceId: string;
let privateSpaceId: string;
let privateMessageId: string;
let privateReplyId: string;
let privateWikiSlug: string;
let privateSpaceWikiId: string;
let privateFileId: string;
let privateStorageKey: string;
let projectId: string;
let visibleTaskId: string;
let restrictedTaskId: string;
let restrictedTaskFileId: string;
let restrictedTaskStorageKey: string;
let taskWikiCitationId: string;

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

before(async () => {
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'Direct Privacy User', false)
       ON CONFLICT (id) DO NOTHING`,
      [USER_ID, USER_EMAIL],
    );
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'Direct Privacy Other', false)
       ON CONFLICT (id) DO NOTHING`,
      [OTHER_USER_ID, OTHER_EMAIL],
    );
    await c.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES (gen_random_uuid()::text, $1, $2, 'member', true)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [ORG_ID, USER_ID],
    );
    await c.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES (gen_random_uuid()::text, $1, $2, 'member', true)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [ORG_ID, OTHER_USER_ID],
    );

    visibleSpaceId = `drp-visible-space-${stamp}`;
    privateSpaceId = `drp-private-space-${stamp}`;
    await c.query(
      `INSERT INTO spaces (id, org_id, name, type, is_default, is_archived, agent_enabled, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, 'private', false, false, true, $4, NOW(), NOW())`,
      [visibleSpaceId, ORG_ID, `${SECRET_TERM} visible`, USER_ID],
    );
    ids.push({ table: 'spaces', id: visibleSpaceId });
    await c.query(
      `INSERT INTO spaces (id, org_id, name, type, is_default, is_archived, agent_enabled, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, 'private', false, false, true, $4, NOW(), NOW())`,
      [privateSpaceId, ORG_ID, `${SECRET_TERM} private`, OTHER_USER_ID],
    );
    ids.push({ table: 'spaces', id: privateSpaceId });

    await c.query(
      `INSERT INTO space_members (id, space_id, user_id, is_muted, notification_level, joined_at)
       VALUES (gen_random_uuid()::text, $1, $2, false, 'all', NOW())`,
      [visibleSpaceId, USER_ID],
    );
    await c.query(
      `INSERT INTO space_members (id, space_id, user_id, is_muted, notification_level, joined_at)
       VALUES (gen_random_uuid()::text, $1, $2, false, 'all', NOW())`,
      [privateSpaceId, OTHER_USER_ID],
    );

    privateMessageId = `drp-private-message-${stamp}`;
    await c.query(
      `INSERT INTO messages (id, org_id, space_id, user_id, content, is_pinned, is_deleted, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, false, false, NOW(), NOW())`,
      [privateMessageId, ORG_ID, privateSpaceId, OTHER_USER_ID, `${SECRET_TERM} private message`],
    );
    ids.push({ table: 'messages', id: privateMessageId });

    privateReplyId = `drp-private-reply-${stamp}`;
    await c.query(
      `INSERT INTO messages (id, org_id, space_id, user_id, parent_id, content, is_pinned, is_deleted, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, false, false, NOW(), NOW())`,
      [privateReplyId, ORG_ID, privateSpaceId, OTHER_USER_ID, privateMessageId, `${SECRET_TERM} private reply`],
    );
    ids.push({ table: 'messages', id: privateReplyId });

    privateWikiSlug = `drp-private-wiki-${stamp}`;
    await c.query(
      `INSERT INTO wiki_pages (id, org_id, scope, user_id, type, title, slug, content, confidence, is_deleted, created_at, updated_at)
       VALUES ($1, $2, 'user', $3, 'fact', $4, $5, $6, 1, false, NOW(), NOW())`,
      [`drp-private-wiki-${stamp}`, ORG_ID, OTHER_USER_ID, `${SECRET_TERM} private wiki`, privateWikiSlug, `${SECRET_TERM} private wiki content`],
    );
    ids.push({ table: 'wiki_pages', id: `drp-private-wiki-${stamp}` });

    privateSpaceWikiId = `drp-space-wiki-${stamp}`;
    await c.query(
      `INSERT INTO wiki_pages (id, org_id, scope, space_id, user_id, type, title, slug, content, confidence, is_deleted, created_at, updated_at)
       VALUES ($1, $2, 'space', $3, $4, 'fact', $5, $6, $7, 1, false, NOW(), NOW())`,
      [privateSpaceWikiId, ORG_ID, privateSpaceId, OTHER_USER_ID, `${SECRET_TERM} private space wiki`, `drp-space-wiki-${stamp}`, `${SECRET_TERM} private space wiki content`],
    );
    ids.push({ table: 'wiki_pages', id: privateSpaceWikiId });

    privateFileId = `drp-file-${stamp}`;
    privateStorageKey = `drp-file-${stamp}.txt`;
    const uploadDir = join(process.cwd(), 'uploads');
    await mkdir(uploadDir, { recursive: true });
    await writeFile(join(uploadDir, privateStorageKey), 'private file body');
    await c.query(
      `INSERT INTO files (id, org_id, uploaded_by, filename, mime_type, size_bytes, storage_key, message_id, created_at, updated_at)
       VALUES ($1, $2, $3, 'private.txt', 'text/plain', 17, $4, $5, NOW(), NOW())`,
      [privateFileId, ORG_ID, OTHER_USER_ID, privateStorageKey, privateMessageId],
    );
    ids.push({ table: 'files', id: privateFileId });

    projectId = `drp-project-${stamp}`;
    await c.query(
      `INSERT INTO projects (id, org_id, name, prefix, lead_id, task_counter, is_archived, is_deleted, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 2, false, false, NOW(), NOW())`,
      [projectId, ORG_ID, `${SECRET_TERM} project`, `DRP${stamp % 100000}`, OTHER_USER_ID],
    );
    ids.push({ table: 'projects', id: projectId });

    visibleTaskId = `drp-visible-task-${stamp}`;
    await c.query(
      `INSERT INTO tasks (id, org_id, project_id, number, title, description, status, priority, assignee_id, created_by, is_deleted, is_template, sort_order, created_at, updated_at)
       VALUES ($1, $2, $3, 1, $4, $5, 'todo', 'p2', $6, $6, false, false, 1, NOW(), NOW())`,
      [visibleTaskId, ORG_ID, projectId, `${SECRET_TERM} visible task`, `${SECRET_TERM} visible task`, USER_ID],
    );
    ids.push({ table: 'tasks', id: visibleTaskId });

    restrictedTaskId = `drp-restricted-task-${stamp}`;
    await c.query(
      `INSERT INTO tasks (id, org_id, project_id, number, title, description, status, priority, assignee_id, created_by, is_deleted, is_template, sort_order, metadata, created_at, updated_at)
       VALUES ($1, $2, $3, 2, $4, $5, 'todo', 'p1', $6, $6, false, false, 2, $7::jsonb, NOW(), NOW())`,
      [
        restrictedTaskId,
        ORG_ID,
        projectId,
        `${SECRET_TERM} restricted task`,
        `${SECRET_TERM} restricted task`,
        OTHER_USER_ID,
        JSON.stringify({ visibility: 'restricted', visible_user_ids: [OTHER_USER_ID] }),
      ],
    );
    ids.push({ table: 'tasks', id: restrictedTaskId });

    restrictedTaskFileId = `drp-task-file-${stamp}`;
    restrictedTaskStorageKey = `drp-task-file-${stamp}.txt`;
    await writeFile(join(uploadDir, restrictedTaskStorageKey), 'restricted task file');
    await c.query(
      `INSERT INTO files (id, org_id, uploaded_by, filename, mime_type, size_bytes, storage_key, task_id, created_at, updated_at)
       VALUES ($1, $2, $3, 'task-private.txt', 'text/plain', 20, $4, $5, NOW(), NOW())`,
      [restrictedTaskFileId, ORG_ID, OTHER_USER_ID, restrictedTaskStorageKey, restrictedTaskId],
    );
    ids.push({ table: 'files', id: restrictedTaskFileId });

    taskWikiCitationId = `drp-task-wiki-citation-${stamp}`;
    await c.query(
      `INSERT INTO wiki_citations (id, page_id, source_type, source_id, created_at)
       VALUES ($1, $2, 'task', $3, NOW())`,
      [taskWikiCitationId, privateSpaceWikiId, visibleTaskId],
    );
    ids.push({ table: 'wiki_citations', id: taskWikiCitationId });
  });
});

after(async () => {
  await withClient(async (c) => {
    const spaceIds = new Set([visibleSpaceId, privateSpaceId]);
    for (const { table, id } of [...ids].reverse().filter(row => row.table !== 'spaces')) {
      await c.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
    }
    await c.query(`DELETE FROM space_members WHERE space_id IN ($1, $2)`, [visibleSpaceId, privateSpaceId]);
    for (const { table, id } of [...ids].reverse().filter(row => row.table === 'spaces' && spaceIds.has(row.id))) {
      await c.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
    }
    await c.query(`DELETE FROM org_members WHERE user_id IN ($1, $2)`, [USER_ID, OTHER_USER_ID]);
    await c.query(`DELETE FROM users WHERE id IN ($1, $2)`, [USER_ID, OTHER_USER_ID]);
  });
  await rm(join(process.cwd(), 'uploads', privateStorageKey), { force: true });
  await rm(join(process.cwd(), 'uploads', restrictedTaskStorageKey), { force: true });
});

async function routeResponse(routeName: 'messages' | 'spaces' | 'wiki' | 'knowledge' | 'files' | 'tasks', path: string, userId = USER_ID, init?: RequestInit) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, org_id: ORG_ID, email: USER_EMAIL, name: 'Direct Privacy User' });
    await next();
  });

  if (routeName === 'messages') app.route('/api/messages', (await import('../src/routes/messages.js')).messageRoutes);
  if (routeName === 'spaces') app.route('/api/spaces', (await import('../src/routes/spaces.js')).spaceRoutes);
  if (routeName === 'wiki') app.route('/api/wiki', (await import('../src/routes/wiki.js')).wikiRoutes);
  if (routeName === 'knowledge') app.route('/api/spaces', (await import('../src/routes/knowledge.js')).knowledgeRoutes);
  if (routeName === 'files') app.route('/api/files', (await import('../src/routes/upload.js')).fileServingRoutes);
  if (routeName === 'tasks') app.route('/api/tasks', (await import('../src/routes/tasks.js')).taskRoutes);

  return app.request(path, init);
}

test('message direct routes require membership in the message space', async () => {
  assert.equal((await routeResponse('messages', `/api/messages/${privateMessageId}/thread`)).status, 404);
  assert.equal((await routeResponse('messages', `/api/messages/${privateMessageId}/history`)).status, 404);
  assert.equal((await routeResponse('messages', `/api/messages/${privateMessageId}/reactions`, USER_ID, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ emoji: 'eyes' }),
  })).status, 404);
  assert.equal((await routeResponse('messages', `/api/messages/${privateMessageId}/thread-read`, USER_ID, {
    method: 'POST',
  })).status, 404);
  assert.equal((await routeResponse('messages', `/api/messages/${privateSpaceId}/read-receipts`)).status, 403);

  assert.equal((await routeResponse('messages', `/api/messages/${privateMessageId}/thread`, OTHER_USER_ID)).status, 200);
});

test('space direct routes require membership', async () => {
  assert.equal((await routeResponse('spaces', `/api/spaces/${privateSpaceId}`)).status, 403);
  assert.equal((await routeResponse('spaces', `/api/spaces/${privateSpaceId}/mute`, USER_ID, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ muted: true }),
  })).status, 403);
  assert.equal((await routeResponse('spaces', `/api/spaces/${privateSpaceId}/mark-unread`, USER_ID, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message_id: privateMessageId }),
  })).status, 403);
});

test('wiki and knowledge routes respect user and space scope', async () => {
  assert.equal((await routeResponse('wiki', `/api/wiki/${privateWikiSlug}`)).status, 404);
  assert.equal((await routeResponse('wiki', `/api/wiki/${privateWikiSlug}`, OTHER_USER_ID)).status, 200);

  const search = await routeResponse('wiki', `/api/wiki?q=${encodeURIComponent(SECRET_TERM)}`);
  assert.equal(search.status, 200);
  const searchBody = await search.json() as any;
  assert.ok(!searchBody.pages.some((p: any) => p.slug === privateWikiSlug));

  assert.equal((await routeResponse('knowledge', `/api/spaces/${privateSpaceId}/knowledge`)).status, 403);
  assert.equal((await routeResponse('knowledge', `/api/spaces/${privateSpaceId}/knowledge`, OTHER_USER_ID)).status, 200);
});

test('file serving follows linked message visibility', async () => {
  assert.equal((await routeResponse('files', `/api/files/${privateFileId}`)).status, 404);
  const allowed = await routeResponse('files', `/api/files/${privateFileId}`, OTHER_USER_ID);
  assert.equal(allowed.status, 200);
  assert.equal(await allowed.text(), 'private file body');
});

test('task detail adjunct routes respect restricted task and wiki visibility', async () => {
  assert.equal((await routeResponse('tasks', `/api/tasks/${restrictedTaskId}/attachments`)).status, 404);
  assert.equal((await routeResponse('tasks', `/api/tasks/${restrictedTaskId}/wiki-links`)).status, 404);
  assert.equal((await routeResponse('files', `/api/files/${restrictedTaskFileId}`)).status, 404);

  const otherAttachments = await routeResponse('tasks', `/api/tasks/${restrictedTaskId}/attachments`, OTHER_USER_ID);
  assert.equal(otherAttachments.status, 200);
  assert.ok((await otherAttachments.json() as any[]).some((f: any) => f.id === restrictedTaskFileId));

  const visibleTaskLinks = await routeResponse('tasks', `/api/tasks/${visibleTaskId}/wiki-links`);
  assert.equal(visibleTaskLinks.status, 200);
  const visibleTaskLinksBody = await visibleTaskLinks.json() as any;
  assert.ok(!visibleTaskLinksBody.wiki_links.some((p: any) => p.page_id === privateSpaceWikiId));
});
