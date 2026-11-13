/**
 * Message, bookmark and tag routes check the caller's workspace and their
 * access to the message's space. A refused id answers exactly like a missing
 * one, and a member keeps every path they had.
 *
 * Run:
 *   DATABASE_URL=... DEFT_TEST_DATABASE_URL=... pnpm --filter @deft/api test test/message-id-access-db.test.ts
 */
import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

// Lets one test act between the pages of the tag entity scan.
let onClipAccessCheck: (() => Promise<void>) | null = null;
const actualClips = await import('../src/routes/clips.js');
mock.module(new URL('../src/routes/clips.ts', import.meta.url).href, { namedExports: { ...actualClips,
  canAccessClip: async (...args: Parameters<typeof actualClips.canAccessClip>) => {
    const hook = onClipAccessCheck; onClipAccessCheck = null;
    if (hook) await hook();
    return actualClips.canAccessClip(...args);
  } } });

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';
const stamp = Date.now();
const p = (name: string) => `w2m-${name}-${stamp}`;

const ORG_A = p('org-a');
const ORG_B = p('org-b');
const MEMBER = p('member');       // org A (and org B), member of the private space
const OUTSIDER = p('outsider');   // org A, not in the private space
const FOREIGN = p('foreign');     // org B only
const PRIVATE_SPACE = p('space-private');
const OTHER_SPACE = p('space-other');
const STRAY_REPLY = p('stray-reply');
const SPACE_B = p('space-b');
const MESSAGE = p('message');
const MESSAGE_B = p('message-b');
const MISSING = p('missing');
const TAG_A = p('tag-a');
const TAG_B = p('tag-b');
const PROJECT_A = p('project-a');
const PROJECT_B = p('project-b');
const UUID_PROJECT_A = randomUUID();
const UUID_PROJECT_B = randomUUID();
const MIXED_MESSAGE = p('mixed-message');
const RESTRICTED_TASK = p('task-restricted');
const TASK_B = p('task-b');
const PRIVATE_NOTE = p('note-private');
const NOTE_B = p('note-b');
const DELETED_NOTE = p('note-deleted');
const SECRET = `w2msecret${stamp}`;
const SECRET_B = `w2mforeign${stamp}`;

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function q(sql: string, params: unknown[] = []) {
  return withClient((c) => c.query(sql, params));
}

async function count(sql: string, params: unknown[]) {
  return Number((await q(sql, params)).rows[0].n);
}

before(async () => {
  await withClient(async (c) => {
    for (const org of [ORG_A, ORG_B]) {
      await c.query(`INSERT INTO orgs (id, name, slug) VALUES ($1, $1, $1)`, [org]);
    }
    for (const user of [MEMBER, OUTSIDER, FOREIGN]) {
      await c.query(`INSERT INTO users (id, email, name, is_agent) VALUES ($1, $2, $1, false)`, [user, `${user}@test.local`]);
    }
    for (const [org, user] of [[ORG_A, MEMBER], [ORG_A, OUTSIDER], [ORG_B, MEMBER], [ORG_B, FOREIGN]] as const) {
      await c.query(
        `INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES (gen_random_uuid()::text, $1, $2, 'member', true)`,
        [org, user],
      );
    }
    for (const [space, org, members] of [[PRIVATE_SPACE, ORG_A, [MEMBER]], [OTHER_SPACE, ORG_A, [OUTSIDER]], [SPACE_B, ORG_B, [MEMBER, FOREIGN]]] as const) {
      await c.query(
        `INSERT INTO spaces (id, org_id, name, type, is_default, is_archived, agent_enabled, created_by, created_at, updated_at)
         VALUES ($1, $2, $1, 'private', false, false, true, $3, NOW(), NOW())`,
        [space, org, members[0]],
      );
      for (const member of members) {
        await c.query(
          `INSERT INTO space_members (id, space_id, user_id, is_muted, notification_level, joined_at)
           VALUES (gen_random_uuid()::text, $1, $2, false, 'all', NOW())`,
          [space, member],
        );
      }
    }
    for (const [id, org, space, content] of [[MESSAGE, ORG_A, PRIVATE_SPACE, `${SECRET} message`], [MESSAGE_B, ORG_B, SPACE_B, `${SECRET_B} message`]]) {
      await c.query(
        `INSERT INTO messages (id, org_id, space_id, user_id, content, is_pinned, is_deleted, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, false, false, NOW(), NOW())`,
        [id, org, space, MEMBER, content],
      );
    }
    await c.query(`INSERT INTO tags (id, org_id, name) VALUES ($1, $2, $1), ($3, $4, $3)`, [TAG_A, ORG_A, TAG_B, ORG_B]);
    await c.query(
      `INSERT INTO projects (id, org_id, name, prefix, lead_id) VALUES ($1, $2, $1, 'WMA', $3), ($4, $5, $4, 'WMB', $6)`,
      [PROJECT_A, ORG_A, MEMBER, PROJECT_B, ORG_B, FOREIGN],
    );
    await c.query(
      `INSERT INTO projects (id, org_id, name, prefix, lead_id) VALUES ($1, $2, $1, 'WMC', $3), ($4, $5, $4, 'WMD', $6)`,
      [UUID_PROJECT_A, ORG_A, MEMBER, UUID_PROJECT_B, ORG_B, FOREIGN],
    );
    // A message row whose org differs from its space's org.
    await c.query(
      `INSERT INTO messages (id, org_id, space_id, user_id, content, is_pinned, is_deleted, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, false, false, NOW(), NOW())`,
      [MIXED_MESSAGE, ORG_A, SPACE_B, MEMBER, `${SECRET} mixed`],
    );
    await c.query(
      `INSERT INTO tasks (id, org_id, project_id, number, title, status, created_by, metadata)
       VALUES ($1, $2, $3, 1, $4, 'todo', $5, '{"visibility":"restricted"}'::jsonb),
              ($6, $7, $8, 1, $9, 'todo', $10, '{}'::jsonb)`,
      [RESTRICTED_TASK, ORG_A, PROJECT_A, `${SECRET} task`, MEMBER, TASK_B, ORG_B, PROJECT_B, `${SECRET_B} task`, FOREIGN],
    );
    await c.query(
      `INSERT INTO notes (id, org_id, user_id, title, created_at, updated_at) VALUES ($1, $2, $3, $4, NOW(), NOW()), ($5, $6, $7, $8, NOW(), NOW())`,
      [PRIVATE_NOTE, ORG_A, MEMBER, `${SECRET} note`, NOTE_B, ORG_B, FOREIGN, `${SECRET_B} note`],
    );
    await c.query(
      `INSERT INTO notes (id, org_id, user_id, title, visibility, is_deleted, created_at, updated_at) VALUES ($1, $2, $3, $4, 'org', true, NOW(), NOW())`,
      [DELETED_NOTE, ORG_A, MEMBER, `${SECRET} deleted note`],
    );
  });
});

after(async () => {
  await withClient(async (c) => {
    const users = [MEMBER, OUTSIDER, FOREIGN];
    const orgs = [ORG_A, ORG_B];
    await c.query(`DELETE FROM entity_tags WHERE org_id = ANY($1)`, [orgs]);
    await c.query(`DELETE FROM tags WHERE org_id = ANY($1)`, [orgs]);
    await c.query(`DELETE FROM message_bookmarks WHERE org_id = ANY($1) OR user_id = ANY($2)`, [orgs, users]);
    await c.query(`DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE org_id = ANY($1))`, [orgs]).catch(() => undefined);
    await c.query(`DELETE FROM message_versions WHERE message_id IN (SELECT id FROM messages WHERE org_id = ANY($1))`, [orgs]).catch(() => undefined);
    await c.query(`DELETE FROM notes WHERE org_id = ANY($1)`, [orgs]);
    await c.query(`DELETE FROM task_activity WHERE task_id IN (SELECT id FROM tasks WHERE org_id = ANY($1))`, [orgs]).catch(() => undefined);
    await c.query(`DELETE FROM native_create_requests WHERE org_id = ANY($1)`, [orgs]).catch(() => undefined);
    await c.query(`DELETE FROM tasks WHERE org_id = ANY($1)`, [orgs]);
    await c.query(`DELETE FROM projects WHERE org_id = ANY($1)`, [orgs]);
    await c.query(`DELETE FROM job_queue WHERE payload::text LIKE $1`, [`%w2m-%${stamp}%`]).catch(() => undefined);
    await c.query(`DELETE FROM messages WHERE org_id = ANY($1)`, [orgs]);
    await c.query(`DELETE FROM space_members WHERE space_id = ANY($1)`, [[PRIVATE_SPACE, OTHER_SPACE, SPACE_B]]);
    await c.query(`DELETE FROM spaces WHERE org_id = ANY($1)`, [orgs]);
    await c.query(`DELETE FROM org_members WHERE org_id = ANY($1)`, [orgs]);
    await c.query(`DELETE FROM users WHERE id = ANY($1)`, [users]).catch(() => undefined);
    await c.query(`DELETE FROM orgs WHERE id = ANY($1)`, [orgs]).catch(() => undefined);
  });
});

async function call(userId: string, orgId: string, method: string, path: string, body?: unknown) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, org_id: orgId, email: `${userId}@test.local`, role: 'member', sid: `w2m-sid-${stamp}` });
    await next();
  });
  app.route('/api/bookmarks', (await import('../src/routes/bookmarks.js')).bookmarkRoutes);
  app.route('/api/tags', (await import('../src/routes/tags.js')).tagRoutes);
  app.route('/api/messages', (await import('../src/routes/messages.js')).messageRoutes);
  app.route('/api/projects', (await import('../src/routes/projects.js')).projectRoutes);
  app.route('/api/tasks', (await import('../src/routes/tasks.js')).taskRoutes);
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  const res = await app.request(path, init);
  const text = await res.text();
  let json: unknown = text;
  try { json = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, json, text };
}

/** A refused id must answer exactly like an id that does not exist. */
async function assertLikeMissing(userId: string, orgId: string, method: string, path: (id: string) => string, body?: (id: string) => unknown) {
  const refused = await call(userId, orgId, method, path(MESSAGE), body?.(MESSAGE));
  const missing = await call(userId, orgId, method, path(MISSING), body?.(MISSING));
  assert.equal(missing.status, 404, `${method} ${path(MISSING)} baseline: ${missing.text}`);
  assert.equal(refused.status, missing.status, `${method} ${path(MESSAGE)}: ${refused.text}`);
  assert.deepEqual(refused.json, missing.json);
  assert.ok(!refused.text.includes(SECRET));
}

const tagRowCount = (entityId: string) =>
  count(`SELECT count(*)::int AS n FROM entity_tags WHERE entity_id = $1`, [entityId]);

for (const [label, userId, orgId, tagId] of [
  ['a caller from another workspace', FOREIGN, ORG_B, TAG_B],
  ['a same-workspace non-member of a private space', OUTSIDER, ORG_A, TAG_A],
] as const) {
  test(`${label} cannot bookmark, tag, react to or read a message by id`, async () => {
    await assertLikeMissing(userId, orgId, 'POST', () => '/api/bookmarks', (id) => ({ message_id: id, space_id: PRIVATE_SPACE }));
    assert.equal(await count(`SELECT count(*)::int AS n FROM message_bookmarks WHERE user_id = $1`, [userId]), 0);

    await assertLikeMissing(userId, orgId, 'POST', () => `/api/tags/${tagId}/apply`, (id) => ({ entity_type: 'message', entity_id: id }));
    assert.equal(await tagRowCount(MESSAGE), 0);

    await assertLikeMissing(userId, orgId, 'POST', (id) => `/api/messages/${id}/reactions`, () => ({ emoji: 'thumbsup' }));
    await assertLikeMissing(userId, orgId, 'PATCH', (id) => `/api/messages/${id}`, () => ({ content: 'edited' }));
    await assertLikeMissing(userId, orgId, 'DELETE', (id) => `/api/messages/${id}`);
    await assertLikeMissing(userId, orgId, 'GET', (id) => `/api/messages/${id}/thread`);
    await assertLikeMissing(userId, orgId, 'GET', (id) => `/api/messages/${id}/history`);
    await assertLikeMissing(userId, orgId, 'DELETE', (id) => `/api/messages/${id}/reactions/thumbsup`);
    await assertLikeMissing(userId, orgId, 'POST', (id) => `/api/messages/${id}/thread-read`);
    const project = orgId === ORG_A ? PROJECT_A : PROJECT_B;
    const sourced = await call(userId, orgId, 'POST', `/api/projects/${project}/tasks`, { title: 'w2m sourced', source_message_id: MESSAGE });
    const sourcedMissing = await call(userId, orgId, 'POST', `/api/projects/${project}/tasks`, { title: 'w2m sourced', source_message_id: MISSING });
    assert.equal(sourced.status, 400, sourced.text);
    assert.equal(sourced.status, sourcedMissing.status);
    assert.deepEqual(sourced.json, sourcedMissing.json);
    assert.equal(await count(`SELECT count(*)::int AS n FROM tasks WHERE source_message_id = $1`, [MESSAGE]), 0);

    const uuidProject = orgId === ORG_A ? UUID_PROJECT_A : UUID_PROJECT_B;
    const viaRoot = await call(userId, orgId, 'POST', '/api/tasks', { project_id: uuidProject, title: 'w2m sourced', source_message_id: MESSAGE });
    const viaRootMissing = await call(userId, orgId, 'POST', '/api/tasks', { project_id: uuidProject, title: 'w2m sourced', source_message_id: MISSING });
    assert.equal(viaRoot.status, 400, viaRoot.text);
    assert.deepEqual(viaRoot.json, viaRootMissing.json);

    const viaTasks = await call(userId, orgId, 'POST', `/api/tasks/project/${project}`, { title: 'w2m sourced', source_message_id: MESSAGE });
    const viaTasksMissing = await call(userId, orgId, 'POST', `/api/tasks/project/${project}`, { title: 'w2m sourced', source_message_id: MISSING });
    assert.equal(viaTasks.status, 400, viaTasks.text);
    assert.deepEqual(viaTasks.json, viaTasksMissing.json);
    assert.equal(await count(`SELECT count(*)::int AS n FROM tasks WHERE source_message_id = $1`, [MESSAGE]), 0);

    const message = await q(`SELECT content, is_deleted FROM messages WHERE id = $1`, [MESSAGE]);
    assert.equal(message.rows[0].is_deleted, false);
    assert.equal(message.rows[0].content, `${SECRET} message`);
  });
}

test('a caller from another workspace cannot tag tasks or notes of a workspace by id', async () => {
  for (const [type, id] of [['task', RESTRICTED_TASK], ['note', PRIVATE_NOTE]] as const) {
    const res = await call(FOREIGN, ORG_B, 'POST', `/api/tags/${TAG_B}/apply`, { entity_type: type, entity_id: id });
    assert.equal(res.status, 404, res.text);
    assert.equal(await tagRowCount(id), 0);
  }
});

test('a deleted note cannot be tagged under either note type', async () => {
  for (const type of ['note', 'daily_note'] as const) {
    const deleted = await call(MEMBER, ORG_A, 'POST', `/api/tags/${TAG_A}/apply`, { entity_type: type, entity_id: DELETED_NOTE });
    const missing = await call(MEMBER, ORG_A, 'POST', `/api/tags/${TAG_A}/apply`, { entity_type: type, entity_id: MISSING });
    assert.equal(deleted.status, 404, deleted.text);
    assert.deepEqual(deleted.json, missing.json);
  }
  assert.equal(await tagRowCount(DELETED_NOTE), 0);
});

test('a member can create a task from a message they can read', async () => {
  const created = await call(MEMBER, ORG_A, 'POST', `/api/projects/${PROJECT_A}/tasks`, { title: 'w2m from message', source_message_id: MESSAGE });
  assert.equal(created.status, 201, created.text);
  const viaTasks = await call(MEMBER, ORG_A, 'POST', `/api/tasks/project/${PROJECT_A}`, { title: 'w2m from message 2', source_message_id: MESSAGE });
  assert.equal(viaTasks.status, 201, viaTasks.text);
  const viaRoot = await call(MEMBER, ORG_A, 'POST', '/api/tasks', { project_id: UUID_PROJECT_A, title: 'w2m from message 3', source_message_id: MESSAGE });
  assert.equal(viaRoot.status, 201, viaRoot.text);
  assert.equal(await count(`SELECT count(*)::int AS n FROM tasks WHERE source_message_id = $1 AND org_id = $2`, [MESSAGE, ORG_A]), 3);
});

test('a message is not reachable through a workspace other than the workspace of its space', async () => {
  const history = await call(MEMBER, ORG_A, 'GET', `/api/messages/${MIXED_MESSAGE}/history`);
  const missing = await call(MEMBER, ORG_A, 'GET', `/api/messages/${MISSING}/history`);
  assert.equal(history.status, 404, history.text);
  assert.deepEqual(history.json, missing.json);
  const saved = await call(MEMBER, ORG_A, 'POST', '/api/bookmarks', { message_id: MIXED_MESSAGE, space_id: SPACE_B });
  assert.equal(saved.status, 404, saved.text);
});

test('a thread lists only replies in the space of its root', async () => {
  await q(
    `INSERT INTO messages (id, org_id, space_id, user_id, parent_id, content, is_pinned, is_deleted, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, false, false, NOW(), NOW())`,
    [STRAY_REPLY, ORG_A, OTHER_SPACE, OUTSIDER, MESSAGE, `${SECRET} stray reply`],
  );
  try {
    const thread = await call(MEMBER, ORG_A, 'GET', `/api/messages/${MESSAGE}/thread`);
    assert.equal(thread.status, 200, thread.text);
    assert.ok(!thread.text.includes(STRAY_REPLY), thread.text);
  } finally {
    await q(`DELETE FROM messages WHERE id = $1`, [STRAY_REPLY]);
  }
});

test('the tag entity list reaches visible entities behind many entities the caller cannot see', async () => {
  await q(`INSERT INTO entity_tags (id, org_id, tag_id, entity_type, entity_id, created_at) VALUES ($1, $2, $3, 'message', $4, NOW() - interval '1 day')`, [p('et-old'), ORG_A, TAG_A, MESSAGE]);
  await q(
    `INSERT INTO entity_tags (id, org_id, tag_id, entity_type, entity_id)
     SELECT gen_random_uuid()::text, $1, $2, 'message', $3 || g FROM generate_series(1, 250) g`,
    [ORG_A, TAG_A, p('ghost')],
  );
  try {
    const listed = await call(MEMBER, ORG_A, 'GET', `/api/tags/${TAG_A}/entities`);
    assert.equal(listed.status, 200, listed.text);
    assert.deepEqual((listed.json as Array<{ entity_id: string }>).map((r) => r.entity_id), [MESSAGE]);
  } finally {
    await q(`DELETE FROM entity_tags WHERE tag_id = $1`, [TAG_A]);
  }
});

test('the tag entity list keeps scanning when the last row of a page is removed meanwhile', async () => {
  await q(`INSERT INTO entity_tags (id, org_id, tag_id, entity_type, entity_id, created_at) VALUES ($1, $2, $3, 'message', $4, NOW() - interval '1 day')`, [p('et-older'), ORG_A, TAG_A, MESSAGE]);
  await q(`INSERT INTO clips (id, org_id, context_type, context_id, created_by, file_key)
           SELECT $1 || g, $2, 'space', $3, $4, 'k' FROM generate_series(1, 200) g`, [p('clip'), ORG_A, OTHER_SPACE, MEMBER]);
  await q(`INSERT INTO entity_tags (id, org_id, tag_id, entity_type, entity_id)
           SELECT gen_random_uuid()::text, $1, $2, 'clip', $3 || g FROM generate_series(1, 200) g`, [ORG_A, TAG_A, p('clip')]);
  onClipAccessCheck = async () => { await q(`DELETE FROM entity_tags WHERE tag_id = $1 AND entity_type = 'clip'`, [TAG_A]); };
  try {
    const member = await call(MEMBER, ORG_A, 'GET', `/api/tags/${TAG_A}/entities`);
    assert.deepEqual((member.json as Array<{ entity_id: string }>).map((r) => r.entity_id), [MESSAGE]);
  } finally {
    onClipAccessCheck = null;
    await q(`DELETE FROM entity_tags WHERE tag_id = $1`, [TAG_A]);
    await q(`DELETE FROM clips WHERE org_id = $1`, [ORG_A]);
  }
});

test('a bookmark list reports the own space of the message; a bookmark held under another org is re-homed on save', async () => {
  await q(`INSERT INTO message_bookmarks (id, org_id, user_id, message_id, space_id) VALUES ($1, $2, $3, $4, $5)`, [p('bm-wrong-space'), ORG_A, MEMBER, MESSAGE, SPACE_B]);
  try {
    const listed = await call(MEMBER, ORG_A, 'GET', '/api/bookmarks');
    const rows = listed.json as Array<{ message_id: string; space_id: string; space_name: string }>;
    assert.deepEqual(rows.map((r) => [r.message_id, r.space_id, r.space_name]), [[MESSAGE, PRIVATE_SPACE, PRIVATE_SPACE]]);
    await q(`UPDATE message_bookmarks SET org_id = $1 WHERE id = $2`, [ORG_B, p('bm-wrong-space')]);
    const saved = await call(MEMBER, ORG_A, 'POST', '/api/bookmarks', { message_id: MESSAGE, space_id: PRIVATE_SPACE });
    assert.equal(saved.status, 201, saved.text);
    const row = (await q(`SELECT org_id, space_id FROM message_bookmarks WHERE user_id = $1 AND message_id = $2`, [MEMBER, MESSAGE])).rows;
    assert.deepEqual(row, [{ org_id: ORG_A, space_id: PRIVATE_SPACE }]);
  } finally {
    await q(`DELETE FROM message_bookmarks WHERE user_id = $1`, [MEMBER]);
  }
});

test('a non-member cannot untag a message in a private space or read its tags', async () => {
  await q(`INSERT INTO entity_tags (id, org_id, tag_id, entity_type, entity_id) VALUES ($1, $2, $3, 'message', $4)`, [p('et-msg'), ORG_A, TAG_A, MESSAGE]);
  try {
    const removed = await call(OUTSIDER, ORG_A, 'DELETE', `/api/tags/${TAG_A}/apply`, { entity_type: 'message', entity_id: MESSAGE });
    const missing = await call(OUTSIDER, ORG_A, 'DELETE', `/api/tags/${TAG_A}/apply`, { entity_type: 'message', entity_id: MISSING });
    assert.equal(removed.status, missing.status, removed.text);
    assert.deepEqual(removed.json, missing.json);
    assert.equal(await tagRowCount(MESSAGE), 1);

    const tagsOf = await call(OUTSIDER, ORG_A, 'GET', `/api/tags/entity/message/${MESSAGE}`);
    assert.equal(tagsOf.status, 200, tagsOf.text);
    assert.deepEqual(tagsOf.json, []);

    const listed = await call(OUTSIDER, ORG_A, 'GET', `/api/tags/${TAG_A}/entities`);
    assert.equal(listed.status, 200, listed.text);
    assert.ok(!listed.text.includes(SECRET), listed.text);
    assert.ok(!listed.text.includes(MESSAGE), listed.text);
  } finally {
    await q(`DELETE FROM entity_tags WHERE entity_id = $1`, [MESSAGE]);
  }
});

test('the tag entity list shows only entities of the caller\'s workspace that the caller can see', async () => {
  const rows: Array<[string, string]> = [
    ['message', MESSAGE], ['task', RESTRICTED_TASK], ['note', PRIVATE_NOTE],
    ['message', MESSAGE_B], ['task', TASK_B], ['note', NOTE_B],
  ];
  for (const [type, id] of rows) {
    await q(`INSERT INTO entity_tags (id, org_id, tag_id, entity_type, entity_id) VALUES (gen_random_uuid()::text, $1, $2, $3, $4)`, [ORG_A, TAG_A, type, id]);
  }
  try {
    const outsider = await call(OUTSIDER, ORG_A, 'GET', `/api/tags/${TAG_A}/entities`);
    assert.equal(outsider.status, 200, outsider.text);
    assert.ok(!outsider.text.includes(SECRET), outsider.text);
    assert.ok(!outsider.text.includes(SECRET_B), outsider.text);

    const member = await call(MEMBER, ORG_A, 'GET', `/api/tags/${TAG_A}/entities`);
    assert.equal(member.status, 200, member.text);
    assert.ok(!member.text.includes(SECRET_B), member.text);
    const ids = (member.json as Array<{ entity_id: string }>).map((r) => r.entity_id).sort();
    assert.deepEqual(ids, [MESSAGE, PRIVATE_NOTE, RESTRICTED_TASK].sort());
    assert.ok(member.text.includes(`${SECRET} message`));
    assert.ok(member.text.includes(`${SECRET} task`));
    assert.ok(member.text.includes(`${SECRET} note`));
  } finally {
    await q(`DELETE FROM entity_tags WHERE tag_id = $1`, [TAG_A]);
  }
});

test('a member can bookmark, tag and untag a message as before; lists hold only their own rows', async () => {
  // Rows the member must never see in their org-A list.
  await q(`INSERT INTO message_bookmarks (id, org_id, user_id, message_id, space_id) VALUES ($1, $2, $3, $4, $5)`, [p('bm-other-user'), ORG_A, OUTSIDER, MESSAGE, PRIVATE_SPACE]);
  await q(`INSERT INTO message_bookmarks (id, org_id, user_id, message_id, space_id) VALUES ($1, $2, $3, $4, $5)`, [p('bm-other-org'), ORG_B, MEMBER, MESSAGE_B, SPACE_B]);
  try {
    const created = await call(MEMBER, ORG_A, 'POST', '/api/bookmarks', { message_id: MESSAGE, space_id: PRIVATE_SPACE });
    assert.equal(created.status, 201, created.text);
    const duplicate = await call(MEMBER, ORG_A, 'POST', '/api/bookmarks', { message_id: MESSAGE, space_id: PRIVATE_SPACE });
    assert.equal(duplicate.status, 409, duplicate.text);

    const checked = await call(MEMBER, ORG_A, 'GET', `/api/bookmarks/check/${MESSAGE}`);
    assert.deepEqual(checked.json, { bookmarked: true });

    const listed = await call(MEMBER, ORG_A, 'GET', '/api/bookmarks');
    assert.equal(listed.status, 200, listed.text);
    const saved = listed.json as Array<{ id: string; message_id: string; message_content: string }>;
    assert.deepEqual(saved.map((r) => r.message_id), [MESSAGE]);
    assert.equal(saved[0]!.message_content, `${SECRET} message`);
    assert.ok(!listed.text.includes(SECRET_B));

    const tagged = await call(MEMBER, ORG_A, 'POST', `/api/tags/${TAG_A}/apply`, { entity_type: 'message', entity_id: MESSAGE });
    assert.equal(tagged.status, 200, tagged.text);
    const tagsOf = await call(MEMBER, ORG_A, 'GET', `/api/tags/entity/message/${MESSAGE}`);
    assert.deepEqual((tagsOf.json as Array<{ id: string }>).map((t) => t.id), [TAG_A]);
    const untagged = await call(MEMBER, ORG_A, 'DELETE', `/api/tags/${TAG_A}/apply`, { entity_type: 'message', entity_id: MESSAGE });
    assert.equal(untagged.status, 200, untagged.text);
    assert.equal(await tagRowCount(MESSAGE), 0);

    const reacted = await call(MEMBER, ORG_A, 'POST', `/api/messages/${MESSAGE}/reactions`, { emoji: 'thumbsup' });
    assert.ok(reacted.status === 200 || reacted.status === 201, reacted.text);

    const removed = await call(MEMBER, ORG_A, 'DELETE', `/api/bookmarks/${MESSAGE}`);
    assert.equal(removed.status, 200, removed.text);
    assert.equal(await count(`SELECT count(*)::int AS n FROM message_bookmarks WHERE user_id = $1 AND org_id = $2`, [MEMBER, ORG_A]), 0);
    // The member's org-B bookmark is untouched by an org-A session.
    const crossDelete = await call(MEMBER, ORG_A, 'DELETE', `/api/bookmarks/${MESSAGE_B}`);
    assert.equal(crossDelete.status, 404, crossDelete.text);
    assert.equal(await count(`SELECT count(*)::int AS n FROM message_bookmarks WHERE user_id = $1 AND org_id = $2`, [MEMBER, ORG_B]), 1);
  } finally {
    await q(`DELETE FROM message_bookmarks WHERE org_id = ANY($1)`, [[ORG_A, ORG_B]]);
  }
});

test('a bookmark list omits a message after the caller leaves its space; the caller can still remove it', async () => {
  const created = await call(MEMBER, ORG_A, 'POST', '/api/bookmarks', { message_id: MESSAGE, space_id: PRIVATE_SPACE });
  assert.equal(created.status, 201, created.text);
  await q(`DELETE FROM space_members WHERE space_id = $1 AND user_id = $2`, [PRIVATE_SPACE, MEMBER]);
  try {
    const listed = await call(MEMBER, ORG_A, 'GET', '/api/bookmarks');
    assert.equal(listed.status, 200, listed.text);
    assert.ok(!listed.text.includes(SECRET), listed.text);
    const removed = await call(MEMBER, ORG_A, 'DELETE', `/api/bookmarks/${MESSAGE}`);
    assert.equal(removed.status, 200, removed.text);
  } finally {
    await q(
      `INSERT INTO space_members (id, space_id, user_id, is_muted, notification_level, joined_at)
       VALUES (gen_random_uuid()::text, $1, $2, false, 'all', NOW())`,
      [PRIVATE_SPACE, MEMBER],
    );
    await q(`DELETE FROM message_bookmarks WHERE user_id = $1`, [MEMBER]);
  }
});
