/**
 * Regression coverage for global search authorization.
 *
 * Run: pnpm --filter @deft/api test -- search-route-privacy
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import pg from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';

const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';
const USER_ID = `srp-user-${Date.now()}`;
const USER_EMAIL = `srp-user-${Date.now()}@test.local`;
const OTHER_USER_ID = `srp-other-${Date.now()}`;
const OTHER_USER_EMAIL = `srp-other-${Date.now()}@test.local`;
const SEARCH_TERM = `searchprivacy${Date.now()}z`;

const ids: { table: string; id: string }[] = [];

let visibleSpaceId: string;
let privateSpaceId: string;
let visibleMessageId: string;
let privateMessageId: string;
let ownNoteId: string;
let otherPrivateNoteId: string;
let projectId: string;
let visibleTaskId: string;
let restrictedTaskId: string;

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
       VALUES ($1, $2, 'Search Privacy User', false)
       ON CONFLICT (id) DO NOTHING`,
      [USER_ID, USER_EMAIL],
    );
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'Search Privacy Other', false)
       ON CONFLICT (id) DO NOTHING`,
      [OTHER_USER_ID, OTHER_USER_EMAIL],
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

    visibleSpaceId = `srp-visible-space-${Date.now()}`;
    await c.query(
      `INSERT INTO spaces (id, org_id, name, type, is_default, is_archived, agent_enabled, created_at, updated_at)
       VALUES ($1, $2, $3, 'private', false, false, true, NOW(), NOW())`,
      [visibleSpaceId, ORG_ID, `${SEARCH_TERM} visible`],
    );
    ids.push({ table: 'spaces', id: visibleSpaceId });

    const visibleMemberId = `srp-visible-member-${Date.now()}`;
    await c.query(
      `INSERT INTO space_members (id, space_id, user_id, is_muted, notification_level, joined_at)
       VALUES ($1, $2, $3, false, 'all', NOW())`,
      [visibleMemberId, visibleSpaceId, USER_ID],
    );
    ids.push({ table: 'space_members', id: visibleMemberId });

    visibleMessageId = `srp-visible-message-${Date.now()}`;
    await c.query(
      `INSERT INTO messages (id, org_id, space_id, user_id, content, is_pinned, is_deleted, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, false, false, NOW(), NOW())`,
      [visibleMessageId, ORG_ID, visibleSpaceId, USER_ID, `Visible ${SEARCH_TERM} message.`],
    );
    ids.push({ table: 'messages', id: visibleMessageId });

    privateSpaceId = `srp-private-space-${Date.now()}`;
    await c.query(
      `INSERT INTO spaces (id, org_id, name, type, is_default, is_archived, agent_enabled, created_at, updated_at)
       VALUES ($1, $2, $3, 'private', false, false, true, NOW(), NOW())`,
      [privateSpaceId, ORG_ID, `${SEARCH_TERM} hidden`],
    );
    ids.push({ table: 'spaces', id: privateSpaceId });

    const privateMemberId = `srp-private-member-${Date.now()}`;
    await c.query(
      `INSERT INTO space_members (id, space_id, user_id, is_muted, notification_level, joined_at)
       VALUES ($1, $2, $3, false, 'all', NOW())`,
      [privateMemberId, privateSpaceId, OTHER_USER_ID],
    );
    ids.push({ table: 'space_members', id: privateMemberId });

    privateMessageId = `srp-private-message-${Date.now()}`;
    await c.query(
      `INSERT INTO messages (id, org_id, space_id, user_id, content, is_pinned, is_deleted, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, false, false, NOW(), NOW())`,
      [privateMessageId, ORG_ID, privateSpaceId, OTHER_USER_ID, `Hidden ${SEARCH_TERM} message.`],
    );
    ids.push({ table: 'messages', id: privateMessageId });

    ownNoteId = `srp-own-note-${Date.now()}`;
    await c.query(
      `INSERT INTO notes (id, org_id, user_id, title, content, visibility, is_deleted, is_pinned, is_template, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'private', false, false, false, 1, NOW(), NOW())`,
      [ownNoteId, ORG_ID, USER_ID, `${SEARCH_TERM} own note`, `Own ${SEARCH_TERM} note.`],
    );
    ids.push({ table: 'notes', id: ownNoteId });

    otherPrivateNoteId = `srp-other-note-${Date.now()}`;
    await c.query(
      `INSERT INTO notes (id, org_id, user_id, title, content, visibility, is_deleted, is_pinned, is_template, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'private', false, false, false, 1, NOW(), NOW())`,
      [otherPrivateNoteId, ORG_ID, OTHER_USER_ID, `${SEARCH_TERM} other note`, `Other ${SEARCH_TERM} note.`],
    );
    ids.push({ table: 'notes', id: otherPrivateNoteId });

    projectId = `srp-project-${Date.now()}`;
    await c.query(
      `INSERT INTO projects (id, org_id, name, prefix, lead_id, task_counter, is_archived, is_deleted, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 2, false, false, NOW(), NOW())`,
      [projectId, ORG_ID, `${SEARCH_TERM} task project`, `SP${Date.now() % 10000}`, OTHER_USER_ID],
    );
    ids.push({ table: 'projects', id: projectId });

    visibleTaskId = `srp-visible-task-${Date.now()}`;
    await c.query(
      `INSERT INTO tasks (id, org_id, project_id, number, title, description, status, priority, assignee_id, created_by, is_deleted, is_template, sort_order, created_at, updated_at)
       VALUES ($1, $2, $3, 1, $4, $5, 'todo', 'p2', $6, $6, false, false, 1, NOW(), NOW())`,
      [visibleTaskId, ORG_ID, projectId, `${SEARCH_TERM} visible task`, `Visible ${SEARCH_TERM} task.`, OTHER_USER_ID],
    );
    ids.push({ table: 'tasks', id: visibleTaskId });

    restrictedTaskId = `srp-restricted-task-${Date.now()}`;
    await c.query(
      `INSERT INTO tasks (id, org_id, project_id, number, title, description, status, priority, assignee_id, created_by, is_deleted, is_template, sort_order, metadata, created_at, updated_at)
       VALUES ($1, $2, $3, 2, $4, $5, 'todo', 'p1', $6, $6, false, false, 2, $7::jsonb, NOW(), NOW())`,
      [
        restrictedTaskId,
        ORG_ID,
        projectId,
        `${SEARCH_TERM} restricted task`,
        `Restricted ${SEARCH_TERM} task.`,
        OTHER_USER_ID,
        JSON.stringify({ visibility: 'restricted', visible_user_ids: [OTHER_USER_ID] }),
      ],
    );
    ids.push({ table: 'tasks', id: restrictedTaskId });
  });
});

after(async () => {
  await withClient(async (c) => {
    for (const { table, id } of [...ids].reverse()) {
      await c.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
    }
    await c.query(`DELETE FROM people_patterns WHERE user_id IN ($1, $2)`, [USER_ID, OTHER_USER_ID]);
    await c.query(`DELETE FROM people_expertise WHERE user_id IN ($1, $2)`, [USER_ID, OTHER_USER_ID]);
    await c.query(`DELETE FROM people_influence WHERE user_id IN ($1, $2)`, [USER_ID, OTHER_USER_ID]);
    await c.query(`DELETE FROM people_interactions WHERE user_a_id IN ($1, $2) OR user_b_id IN ($1, $2)`, [USER_ID, OTHER_USER_ID]);
    await c.query(`DELETE FROM people_relationships WHERE user_a_id IN ($1, $2) OR user_b_id IN ($1, $2)`, [USER_ID, OTHER_USER_ID]);
    await c.query(`DELETE FROM org_members WHERE user_id IN ($1, $2)`, [USER_ID, OTHER_USER_ID]);
    await c.query(`DELETE FROM users WHERE id IN ($1, $2)`, [USER_ID, OTHER_USER_ID]);
  });
});

async function callSearch(userId = USER_ID): Promise<any> {
  const { searchRoutes } = await import('../src/routes/search.js');
  const app = new Hono();

  app.use('*', async (c, next) => {
    c.set('user', { id: userId, org_id: ORG_ID, email: USER_EMAIL, name: 'Search Privacy User' });
    await next();
  });
  app.route('/', searchRoutes);

  const res = await app.fetch(new Request(`http://localhost/?q=${encodeURIComponent(SEARCH_TERM)}`));
  assert.equal(res.status, 200);
  return res.json();
}

async function callTaskRoute(path: string, userId = USER_ID): Promise<Response> {
  const { taskRoutes } = await import('../src/routes/tasks.js');
  const app = new Hono();

  app.use('*', async (c, next) => {
    c.set('user', { id: userId, org_id: ORG_ID, email: USER_EMAIL, name: 'Search Privacy User' });
    await next();
  });
  app.route('/api/tasks', taskRoutes);

  return app.request(path, { method: 'GET' });
}

async function callProjectRoute(path: string, userId = USER_ID): Promise<Response> {
  const { projectRoutes } = await import('../src/routes/projects.js');
  const app = new Hono();

  app.use('*', async (c, next) => {
    c.set('user', { id: userId, org_id: ORG_ID, email: USER_EMAIL, name: 'Search Privacy User' });
    await next();
  });
  app.route('/api/projects', projectRoutes);

  return app.request(path, { method: 'GET' });
}

test('global search only returns spaces and messages the caller can access', async () => {
  const body = await callSearch();

  assert.ok(body.spaces.some((s: any) => s.id === visibleSpaceId));
  assert.ok(!body.spaces.some((s: any) => s.id === privateSpaceId));

  assert.ok(body.messages.some((m: any) => m.id === visibleMessageId));
  assert.ok(!body.messages.some((m: any) => m.id === privateMessageId));
});

test('global search legacy notes group respects private-note ownership', async () => {
  const body = await callSearch();

  assert.ok(body.notes.some((n: any) => n.id === ownNoteId));
  assert.ok(!body.notes.some((n: any) => n.id === otherPrivateNoteId));
});

test('global search retrieved privateNotes group respects private-note ownership', async () => {
  const body = await callSearch();

  assert.ok(body.privateNotes.some((n: any) => n.id === ownNoteId));
  assert.ok(!body.privateNotes.some((n: any) => n.id === otherPrivateNoteId));
});

test('global search hides restricted tasks unless caller has direct access', async () => {
  const memberBody = await callSearch(USER_ID);

  assert.ok(memberBody.tasks.some((t: any) => t.id === visibleTaskId));
  assert.ok(!memberBody.tasks.some((t: any) => t.id === restrictedTaskId));

  const assigneeBody = await callSearch(OTHER_USER_ID);
  assert.ok(assigneeBody.tasks.some((t: any) => t.id === restrictedTaskId));
});

test('task and project routes hide restricted tasks from unrelated members', async () => {
  const memberSearch = await callTaskRoute(`/api/tasks/search?q=${encodeURIComponent(SEARCH_TERM)}`, USER_ID);
  assert.equal(memberSearch.status, 200);
  const memberSearchBody = await memberSearch.json() as any[];
  assert.ok(memberSearchBody.some((t: any) => t.id === visibleTaskId));
  assert.ok(!memberSearchBody.some((t: any) => t.id === restrictedTaskId));

  const memberDetail = await callTaskRoute(`/api/tasks/${restrictedTaskId}`, USER_ID);
  assert.equal(memberDetail.status, 404);

  const assigneeDetail = await callTaskRoute(`/api/tasks/${restrictedTaskId}`, OTHER_USER_ID);
  assert.equal(assigneeDetail.status, 200);

  const memberProject = await callProjectRoute(`/api/projects/${projectId}/tasks`, USER_ID);
  assert.equal(memberProject.status, 200);
  const memberProjectBody = await memberProject.json() as any[];
  assert.ok(memberProjectBody.some((t: any) => t.id === visibleTaskId));
  assert.ok(!memberProjectBody.some((t: any) => t.id === restrictedTaskId));
});
