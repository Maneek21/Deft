/**
 * Regression test — dashboard day buckets must follow the *viewer's*
 * timezone, not the server's calendar day.
 *
 * The route used to compute `todayStart` from `new Date(y, m, d)`, i.e. the
 * server's local calendar day (UTC in containers). For a viewer whose timezone
 * differs from the server's by more than an hour, a task due at 01:00 or 23:00
 * viewer-local lands in the wrong bucket: "overdue" or "due this week" instead
 * of "due today".
 *
 * The test picks a viewer timezone at runtime whose current UTC offset is at
 * least two hours away from the server's, so the bug reproduces on any CI
 * machine regardless of its own timezone. The dashboard route accepts an
 * optional `?tz=` override (validated), then falls back to `users.timezone`,
 * then the org timezone, then UTC.
 *
 * Run from apps/api:
 *   DEFT_TEST_DATABASE_URL=... DATABASE_URL=... \
 *     pnpm exec tsx --test --test-concurrency=1 --test-force-exit \
 *     test/dashboard-due-today-timezone.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { Hono } from 'hono';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';
import { getDayBoundaries } from '../src/lib/task-dates.js';

const DATABASE_URL = safeTestDatabaseUrl();
if (!DATABASE_URL) {
  throw new Error(
    'dashboard-due-today-timezone.test.ts: DEFT_TEST_DATABASE_URL must point at a safe test database',
  );
}

const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';

const USER_ID = 'test-dashboard-tz-user';
const USER_EMAIL = 'dashboard-tz@test.local';

/** Current UTC offset of `tz` in minutes (positive = east of UTC). */
function tzOffsetMinutes(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const value = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    value('year'), value('month') - 1, value('day'),
    value('hour'), value('minute'), value('second'),
  );
  return Math.round((asUtc - at.getTime()) / 60000);
}

/**
 * Pick a viewer zone that is clearly not the server's zone, so the old
 * server-local bucketing logic demonstrably disagrees. One of these always
 * differs by at least two hours from any server offset in [-12, +14].
 */
function pickViewerTimezone(now: Date): string {
  const serverTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const serverOffset = tzOffsetMinutes(serverTz, now);
  const candidates = [
    'Pacific/Kiritimati', // UTC+14, no DST
    'Pacific/Pago_Pago', // UTC-11, no DST
    'Asia/Kolkata', // UTC+05:30, no DST
    'UTC',
  ];
  for (const tz of candidates) {
    if (Math.abs(tzOffsetMinutes(tz, now) - serverOffset) >= 120) return tz;
  }
  // Unreachable in practice; keeps the test honest if Intl data is odd.
  return serverOffset >= 0 ? 'Pacific/Pago_Pago' : 'Pacific/Kiritimati';
}

const SEED_NOW = new Date();
const VIEWER_TZ = pickViewerTimezone(SEED_NOW);

let testApp: Hono | null = null;
let createdProjectId: string | null = null;
const taskIds: string[] = [];

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function seedFixtures() {
  const { start } = getDayBoundaries(VIEWER_TZ, 0, SEED_NOW);
  const dueInOneHourLocal = new Date(start.getTime() + 60 * 60 * 1000); // 01:00 viewer-local today
  const dueLateLocal = new Date(start.getTime() + 23 * 60 * 60 * 1000); // 23:00 viewer-local today
  const dueTomorrowEarlyLocal = new Date(start.getTime() + 26 * 60 * 60 * 1000); // 02:00 viewer-local tomorrow

  await withClient(async (c) => {
    await c.query(
      `INSERT INTO users (id, email, name, is_agent, timezone)
       VALUES ($1, $2, 'Dashboard TZ User', false, $3)
       ON CONFLICT (id) DO UPDATE SET timezone = EXCLUDED.timezone`,
      [USER_ID, USER_EMAIL, VIEWER_TZ],
    );
    await c.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES (gen_random_uuid()::text, $1, $2, 'member', true)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [ORG_ID, USER_ID],
    );

    const proj = await c.query(
      `SELECT id FROM projects WHERE org_id = $1 ORDER BY created_at ASC LIMIT 1`,
      [ORG_ID],
    );
    let projectId: string;
    if (proj.rows.length > 0) {
      projectId = proj.rows[0].id as string;
    } else {
      const r = await c.query(
        `INSERT INTO projects (id, org_id, name, prefix, lead_id, task_counter)
         VALUES (gen_random_uuid()::text, $1, 'Dashboard TZ Project', 'DTZ', $2, 0)
         RETURNING id`,
        [ORG_ID, USER_ID],
      );
      projectId = r.rows[0].id as string;
      createdProjectId = projectId;
    }

    for (const [title, due] of [
      ['due-today-early-local', dueInOneHourLocal],
      ['due-today-late-local', dueLateLocal],
      ['due-tomorrow-early-local', dueTomorrowEarlyLocal],
    ] as Array<[string, Date]>) {
      const t = await c.query(
        `INSERT INTO tasks
           (id, org_id, project_id, number, title, status, priority, assignee_id, created_by, due_date, is_deleted)
         VALUES (gen_random_uuid()::text, $1, $2,
           (SELECT coalesce(max(number), 0) + 1 FROM tasks WHERE project_id = $2),
           $3, 'todo', 'p2', $4, $4, $5, false)
         RETURNING id`,
        [ORG_ID, projectId, `${title} ${Date.now()}`, USER_ID, due.toISOString()],
      );
      taskIds.push(t.rows[0].id as string);
    }
  });
}

async function teardownFixtures() {
  await withClient(async (c) => {
    if (taskIds.length > 0) {
      await c.query(`DELETE FROM task_assignees WHERE task_id = ANY($1::text[])`, [taskIds]);
      await c.query(`DELETE FROM tasks WHERE id = ANY($1::text[])`, [taskIds]);
    }
    if (createdProjectId) {
      await c.query(`DELETE FROM projects WHERE id = $1 AND org_id = $2`, [createdProjectId, ORG_ID]);
      createdProjectId = null;
    }
    await c.query(`DELETE FROM org_members WHERE user_id = $1`, [USER_ID]);
    await c.query(`DELETE FROM users WHERE id = $1`, [USER_ID]);
  });
}

before(async () => {
  await seedFixtures();

  const { dashboardRoutes } = await import('../src/routes/dashboard.js');
  testApp = new Hono();
  testApp.use('*', async (c, next) => {
    c.set('user', {
      id: USER_ID,
      email: USER_EMAIL,
      org_id: ORG_ID,
    } as any);
    await next();
  });
  testApp.route('/api/dashboard', dashboardRoutes);
});

after(async () => {
  await teardownFixtures();
});

function app(): Hono {
  if (!testApp) throw new Error('test app not initialized');
  return testApp;
}

async function fetchBuckets(query = ''): Promise<any> {
  const res = await app().request(`/api/dashboard${query}`, { method: 'GET' });
  assert.equal(res.status, 200, `dashboard request failed: ${res.status}`);
  return (await res.json()) as any;
}

function ids(rows: any[]): string[] {
  return rows.map((r: any) => r.id);
}

// ─────────────────────────────────────────────────────────────────────────────

test(`dashboard buckets days in the viewer-supplied ?tz (viewer ${VIEWER_TZ})`, async () => {
  const body = await fetchBuckets(`?tz=${encodeURIComponent(VIEWER_TZ)}`);

  const dueToday = ids(body.due_today);
  const dueThisWeek = ids(body.due_this_week);
  const overdue = ids(body.overdue);

  assert.ok(
    dueToday.includes(taskIds[0]),
    '01:00 viewer-local task must be due today for the viewer',
  );
  assert.ok(
    dueToday.includes(taskIds[1]),
    '23:00 viewer-local task must be due today for the viewer',
  );
  assert.ok(
    !overdue.includes(taskIds[0]) && !overdue.includes(taskIds[1]),
    'viewer-local today tasks must not be reported overdue for the viewer',
  );
  assert.ok(
    dueThisWeek.includes(taskIds[2]),
    '02:00 viewer-local tomorrow must be due this week',
  );
  assert.ok(
    !dueToday.includes(taskIds[2]),
    '02:00 viewer-local tomorrow must not be due today for the viewer',
  );
});

test('dashboard falls back to the user profile timezone when ?tz is absent', async () => {
  const body = await fetchBuckets();

  assert.ok(
    ids(body.due_today).includes(taskIds[0]),
    'profile timezone must bucket the 01:00 viewer-local task as due today',
  );
  assert.ok(
    !ids(body.overdue).includes(taskIds[0]),
    'profile timezone must not bucket the 01:00 viewer-local task as overdue',
  );
});

test('invalid ?tz falls back to the profile timezone instead of failing', async () => {
  const body = await fetchBuckets('?tz=Not/A_Real_Zone');

  assert.ok(
    ids(body.due_today).includes(taskIds[1]),
    'invalid tz must not break bucketing; profile timezone should be used',
  );
});
