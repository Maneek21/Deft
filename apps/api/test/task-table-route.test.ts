import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { Hono } from 'hono';

import { taskRoutes } from '../src/routes/tasks.js';

const DATABASE_URL = process.env.DATABASE_URL!;
const ORG_ID = crypto.randomUUID();
const OTHER_ORG_ID = crypto.randomUUID();
const USER_ID = crypto.randomUUID();
const OTHER_USER_ID = crypto.randomUUID();
const PROJECT_ID = crypto.randomUUID();
const OTHER_PROJECT_ID = crypto.randomUUID();

const app = new Hono();
app.use('*', async (c, next) => {
  c.set('user', { id: USER_ID, org_id: ORG_ID, email: 'table-route@test.local', name: 'Table Route User' });
  await next();
});
app.route('/api/tasks', taskRoutes);

async function withClient<T>(fn: (client: pg.Client) => Promise<T>) {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

before(async () => {
  await withClient(async (client) => {
    await client.query(
      `INSERT INTO orgs (id, name, slug) VALUES ($1, 'Table Route Org', $2), ($3, 'Other Table Org', $4)`,
      [ORG_ID, `table-${ORG_ID}`, OTHER_ORG_ID, `table-${OTHER_ORG_ID}`],
    );
    await client.query(
      `INSERT INTO users (id, email, name, email_verified) VALUES
       ($1, $2, 'Table User', true), ($3, $4, 'Other Table User', true)`,
      [USER_ID, `table-${USER_ID}@test.local`, OTHER_USER_ID, `table-${OTHER_USER_ID}@test.local`],
    );
    await client.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES
       ($1, $2, $3, 'owner', true), ($4, $5, $6, 'owner', true)`,
      [crypto.randomUUID(), ORG_ID, USER_ID, crypto.randomUUID(), OTHER_ORG_ID, OTHER_USER_ID],
    );
    await client.query(
      `INSERT INTO projects (id, org_id, name, prefix, lead_id, task_counter) VALUES
       ($1, $2, 'Table Project', 'TBL', $3, 6), ($4, $5, 'Other Project', 'OTH', $6, 1)`,
      [PROJECT_ID, ORG_ID, USER_ID, OTHER_PROJECT_ID, OTHER_ORG_ID, OTHER_USER_ID],
    );
    await client.query(
      `INSERT INTO tasks (id, org_id, project_id, number, title, status, priority, created_by, is_deleted)
       SELECT gen_random_uuid()::text, $1, $2, n, 'Table task ' || n,
         CASE WHEN n % 2 = 0 THEN 'todo'::task_status ELSE 'in_progress'::task_status END,
         CASE WHEN n % 3 = 0 THEN 'p0'::task_priority ELSE 'p2'::task_priority END,
         $3, false
       FROM generate_series(1, 6) n`,
      [ORG_ID, PROJECT_ID, USER_ID],
    );
    await client.query(
      `UPDATE tasks SET due_date = CASE number
        WHEN 1 THEN current_date - interval '1 day'
        WHEN 2 THEN current_date
        WHEN 3 THEN current_date + interval '1 day'
        WHEN 4 THEN current_date + interval '10 days'
        WHEN 6 THEN current_date - interval '2 days'
        ELSE NULL END
       WHERE project_id = $1`,
      [PROJECT_ID],
    );
  });
});

after(async () => {
  await withClient(async (client) => {
    await client.query(`DELETE FROM tasks WHERE project_id IN ($1, $2)`, [PROJECT_ID, OTHER_PROJECT_ID]);
    await client.query(`DELETE FROM projects WHERE id IN ($1, $2)`, [PROJECT_ID, OTHER_PROJECT_ID]);
    await client.query(`DELETE FROM org_members WHERE org_id IN ($1, $2)`, [ORG_ID, OTHER_ORG_ID]);
    await client.query(`DELETE FROM users WHERE id IN ($1, $2)`, [USER_ID, OTHER_USER_ID]);
    await client.query(`DELETE FROM orgs WHERE id IN ($1, $2)`, [ORG_ID, OTHER_ORG_ID]);
  });
});

test('table route paginates deterministically without duplicate or skipped tasks', async () => {
  const first = await app.request(`/api/tasks/table?project_id=${PROJECT_ID}&sort=number:desc:last&page_size=2`);
  assert.equal(first.status, 200);
  const firstBody = await first.json() as { data: Array<{ id: string; number: number }>; total: number; next_cursor: string };
  assert.equal(firstBody.total, 6);
  assert.deepEqual(firstBody.data.map((task) => task.number), [6, 5]);

  const second = await app.request(`/api/tasks/table?project_id=${PROJECT_ID}&sort=number:desc:last&page_size=2&cursor=${encodeURIComponent(firstBody.next_cursor)}`);
  assert.equal(second.status, 200);
  const secondBody = await second.json() as { data: Array<{ id: string; number: number }> };
  assert.deepEqual(secondBody.data.map((task) => task.number), [4, 3]);
  assert.equal(new Set([...firstBody.data, ...secondBody.data].map((task) => task.id)).size, 4);
});

test('table cursor is rejected when the query order changes', async () => {
  const first = await app.request(`/api/tasks/table?project_id=${PROJECT_ID}&sort=number:desc:last&page_size=2`);
  const body = await first.json() as { next_cursor: string };
  const changed = await app.request(`/api/tasks/table?project_id=${PROJECT_ID}&sort=title:asc:last&page_size=2&cursor=${encodeURIComponent(body.next_cursor)}`);
  assert.equal(changed.status, 400);
});

test('table route keeps database-computed due-date groups stable across pages', async () => {
  const first = await app.request(`/api/tasks/table?project_id=${PROJECT_ID}&group=due_date:asc&page_size=3`);
  const firstBody = await first.json() as { data: Array<{ id: string; number: number }>; next_cursor: string };
  assert.deepEqual(firstBody.data.map((task) => task.number), [4, 3, 5]);

  const second = await app.request(`/api/tasks/table?project_id=${PROJECT_ID}&group=due_date:asc&page_size=3&cursor=${encodeURIComponent(firstBody.next_cursor)}`);
  const secondBody = await second.json() as { data: Array<{ id: string; number: number }> };
  assert.deepEqual(secondBody.data.map((task) => task.number), [6, 1, 2]);
  assert.equal(new Set([...firstBody.data, ...secondBody.data].map((task) => task.id)).size, 6);
});

test('table route rejects a project outside the active organization', async () => {
  const response = await app.request(`/api/tasks/table?project_id=${OTHER_PROJECT_ID}`);
  assert.equal(response.status, 404);
});
