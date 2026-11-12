/**
 * S4: small tenant and visibility gaps left by the space-membership work.
 *
 * One user (CALLER) is an active member of two orgs (A and B). OTHER is a
 * member of org A only, FOREIGN of org B only, GUEST is a guest in org A.
 * A session is for one org; every id taken from the request must be bound to
 * the session's org and the caller's own rights, and a foreign or unreadable
 * id must be indistinguishable from a missing one.
 *
 * Run:
 *   DATABASE_URL=... DEFT_TEST_DATABASE_URL=... pnpm --filter @deft/api test test/tenant-small-gaps-db.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';
const stamp = Date.now();
const ORG_A = `s4-org-a-${stamp}`;
const ORG_B = `s4-org-b-${stamp}`;
const CALLER = `s4-caller-${stamp}`;
const OTHER = `s4-other-${stamp}`;
const FOREIGN = `s4-foreign-${stamp}`;
const GUEST = `s4-guest-${stamp}`;
const USERS = [CALLER, OTHER, FOREIGN, GUEST];
const email = (id: string) => `${id}@test.local`;

const FOLDER_OWN_A = `s4-folder-own-a-${stamp}`;
const FOLDER_OTHER_A = `s4-folder-other-a-${stamp}`;
const FOLDER_CALLER_B = `s4-folder-caller-b-${stamp}`;
const FOLDER_FOREIGN_B = `s4-folder-foreign-b-${stamp}`;
const MISSING = `s4-missing-${stamp}`;
const NOTE_OWN_A = `s4-note-own-a-${stamp}`;

const SPACE_OWN_A = `s4-space-own-a-${stamp}`;
const SPACE_PRIV_A = `s4-space-priv-a-${stamp}`;
const SPACE_B = `s4-space-b-${stamp}`;
const SPACES = [SPACE_OWN_A, SPACE_PRIV_A, SPACE_B];
const MSG_OWN_A = `s4-msg-own-a-${stamp}`;
const MSG_PRIV_A = `s4-msg-priv-a-${stamp}`;
const MSG_B = `s4-msg-b-${stamp}`;

const PROJECT_A = `s4-project-a-${stamp}`;
const TASK_OPEN = `s4-task-open-${stamp}`;
const TASK_RESTRICTED = `s4-task-restricted-${stamp}`;
const SECRET = `s4secret${stamp}`;

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
    for (const org of [ORG_A, ORG_B]) {
      await c.query(`INSERT INTO orgs (id, name, slug) VALUES ($1, $1, $1)`, [org]);
    }
    for (const u of USERS) {
      await c.query(`INSERT INTO users (id, email, name, is_agent) VALUES ($1, $2, $3, false)`, [u, email(u), `${SECRET} ${u}`]);
    }
    const memberships: Array<[string, string, string]> = [
      [ORG_A, CALLER, 'member'], [ORG_B, CALLER, 'member'],
      [ORG_A, OTHER, 'member'], [ORG_B, FOREIGN, 'member'], [ORG_A, GUEST, 'guest'],
    ];
    for (const [org, u, role] of memberships) {
      await c.query(
        `INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES (gen_random_uuid()::text, $1, $2, $3, true)`,
        [org, u, role],
      );
    }
    for (const [id, org, u] of [
      [FOLDER_OWN_A, ORG_A, CALLER], [FOLDER_OTHER_A, ORG_A, OTHER],
      [FOLDER_CALLER_B, ORG_B, CALLER], [FOLDER_FOREIGN_B, ORG_B, FOREIGN],
    ] as const) {
      await c.query(
        `INSERT INTO note_folders (id, org_id, user_id, name, created_at, updated_at) VALUES ($1, $2, $3, $4, NOW(), NOW())`,
        [id, org, u, `${SECRET} ${id}`],
      );
    }
    await c.query(
      `INSERT INTO notes (id, org_id, user_id, title, created_at, updated_at) VALUES ($1, $2, $3, 's4 own note', NOW(), NOW())`,
      [NOTE_OWN_A, ORG_A, CALLER],
    );

    for (const [space, org, creator, members] of [
      [SPACE_OWN_A, ORG_A, CALLER, [CALLER, OTHER]],
      [SPACE_PRIV_A, ORG_A, OTHER, [OTHER]],
      [SPACE_B, ORG_B, CALLER, [CALLER]],
    ] as const) {
      await c.query(
        `INSERT INTO spaces (id, org_id, name, type, is_default, is_archived, agent_enabled, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, 'private', false, false, true, $4, NOW(), NOW())`,
        [space, org, `${SECRET} ${space}`, creator],
      );
      for (const m of members) {
        await c.query(
          `INSERT INTO space_members (id, space_id, user_id, is_muted, notification_level, joined_at)
           VALUES (gen_random_uuid()::text, $1, $2, false, 'all', NOW())`,
          [space, m],
        );
      }
    }
    for (const [id, org, space, u] of [
      [MSG_OWN_A, ORG_A, SPACE_OWN_A, OTHER], [MSG_PRIV_A, ORG_A, SPACE_PRIV_A, OTHER], [MSG_B, ORG_B, SPACE_B, CALLER],
    ] as const) {
      await c.query(
        `INSERT INTO messages (id, org_id, space_id, user_id, content, is_deleted, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, false, NOW() - interval '1 hour', NOW())`,
        [id, org, space, u, `${SECRET} ${id}`],
      );
    }

    // Dashboard fixtures: today's org-A standup, one open and one restricted
    // task with activity, and an org-B notification for the caller.
    await c.query(
      `INSERT INTO standups (id, org_id, date, generated_by, summary, raw_data, created_at, updated_at)
       VALUES (gen_random_uuid()::text, $1, NOW(), 'system', $2, '{"audience":"workspace_members"}'::jsonb, NOW(), NOW())`,
      [ORG_A, `${SECRET} standup summary`],
    );
    await c.query(
      `INSERT INTO projects (id, org_id, name, prefix, created_at, updated_at) VALUES ($1, $2, 's4 project', 'SFOUR', NOW(), NOW())`,
      [PROJECT_A, ORG_A],
    );
    for (const [id, n, title, metadata] of [
      [TASK_OPEN, 1, 's4 open task', '{}'],
      [TASK_RESTRICTED, 2, `${SECRET} restricted task`, `{"visibility":"restricted"}`],
    ] as const) {
      await c.query(
        `INSERT INTO tasks (id, org_id, project_id, number, title, status, priority, created_by, metadata, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'todo', 'p2', $6, $7::jsonb, NOW(), NOW())`,
        [id, ORG_A, PROJECT_A, n, title, OTHER, metadata],
      );
      await c.query(
        `INSERT INTO task_activity (id, org_id, task_id, user_id, action, new_value, created_at)
         VALUES (gen_random_uuid()::text, $1, $2, $3, 'created', $4, NOW())`,
        [ORG_A, id, OTHER, `${SECRET} activity ${id}`],
      );
    }
    await c.query(
      `INSERT INTO notifications (id, org_id, user_id, type, title, is_read, created_at, updated_at)
       VALUES (gen_random_uuid()::text, $1, $2, 'system', 's4 org B notification', false, NOW(), NOW())`,
      [ORG_B, CALLER],
    );
  });
});

after(async () => {
  await withClient(async (c) => {
    const q = (sql: string, params: unknown[]) => c.query(sql, params).catch((err) => console.error('cleanup:', sql, err.message));
    await q(`DELETE FROM job_queue WHERE data::text LIKE $1`, [`%s4-%${stamp}%`]);
    await q(`DELETE FROM notifications WHERE user_id = ANY($1)`, [USERS]);
    await q(`DELETE FROM task_activity WHERE org_id = ANY($1)`, [[ORG_A, ORG_B]]);
    await q(`DELETE FROM tasks WHERE org_id = ANY($1)`, [[ORG_A, ORG_B]]);
    await q(`DELETE FROM projects WHERE org_id = ANY($1)`, [[ORG_A, ORG_B]]);
    await q(`DELETE FROM standups WHERE org_id = ANY($1)`, [[ORG_A, ORG_B]]);
    await q(`DELETE FROM note_shares WHERE note_id IN (SELECT id FROM notes WHERE user_id = ANY($1))`, [USERS]);
    await q(`DELETE FROM note_versions WHERE note_id IN (SELECT id FROM notes WHERE user_id = ANY($1))`, [USERS]);
    await q(`DELETE FROM notes WHERE user_id = ANY($1)`, [USERS]);
    await q(`UPDATE note_folders SET parent_folder_id = NULL WHERE user_id = ANY($1)`, [USERS]);
    await q(`DELETE FROM note_folders WHERE user_id = ANY($1)`, [USERS]);
    await q(`DELETE FROM messages WHERE space_id = ANY($1)`, [SPACES]);
    await q(`DELETE FROM space_members WHERE space_id = ANY($1)`, [SPACES]);
    await q(`DELETE FROM spaces WHERE id = ANY($1)`, [SPACES]);
    await q(`DELETE FROM org_members WHERE user_id = ANY($1)`, [USERS]);
    await q(`DELETE FROM users WHERE id = ANY($1)`, [USERS]);
    await q(`DELETE FROM orgs WHERE id = ANY($1)`, [[ORG_A, ORG_B]]);
  });
});

type RouteName = 'daily-notes' | 'spaces' | 'dashboard';

async function call(route: RouteName, who: { id: string; org: string; role?: string }, method: string, path: string, body?: unknown) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', { id: who.id, org_id: who.org, email: email(who.id), role: who.role ?? 'member', sid: `s4-sid-${stamp}` } as never);
    await next();
  });
  if (route === 'daily-notes') app.route('/api/daily-notes', (await import('../src/routes/daily-notes.js')).dailyNoteRoutes);
  if (route === 'spaces') app.route('/api/spaces', (await import('../src/routes/spaces.js')).spaceRoutes);
  if (route === 'dashboard') app.route('/api/dashboard', (await import('../src/routes/dashboard.js')).dashboardRoutes);
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

const callerA = { id: CALLER, org: ORG_A };
const callerB = { id: CALLER, org: ORG_B };

async function scalar(sql: string, params: unknown[]): Promise<unknown> {
  return withClient(async (c) => (await c.query(sql, params)).rows[0]?.v);
}

/** The probe response must be identical to the response for a missing id and must not leak. */
function assertSameAsMissing(probe: { status: number; json: unknown; text: string }, missing: { status: number; json: unknown; text: string }, label: string) {
  assert.ok(missing.status >= 400, `${label}: missing baseline should be refused (${missing.status} ${missing.text})`);
  assert.equal(probe.status, missing.status, `${label}: status (body: ${probe.text})`);
  assert.deepEqual(probe.json, missing.json, `${label}: body`);
  assert.ok(!probe.text.includes(SECRET), `${label}: leaked foreign data`);
}

test('S4-a: folder create refuses a parent folder the caller does not own in the active org', async () => {
  const missing = await call('daily-notes', callerA, 'POST', '/api/daily-notes/folders', { name: 's4 child', parent_folder_id: MISSING });
  for (const parent of [FOLDER_OTHER_A, FOLDER_CALLER_B, FOLDER_FOREIGN_B]) {
    const res = await call('daily-notes', callerA, 'POST', '/api/daily-notes/folders', { name: 's4 child', parent_folder_id: parent });
    assertSameAsMissing(res, missing, `create under ${parent}`);
  }
  assert.equal(await scalar(`SELECT count(*)::int AS v FROM note_folders WHERE user_id = $1 AND name = 's4 child'`, [CALLER]), 0);

  const ok = await call('daily-notes', callerA, 'POST', '/api/daily-notes/folders', { name: 's4 owned child', parent_folder_id: FOLDER_OWN_A });
  assert.equal(ok.status, 201, ok.text);
  const okRoot = await call('daily-notes', callerA, 'POST', '/api/daily-notes/folders', { name: 's4 owned root' });
  assert.equal(okRoot.status, 201, okRoot.text);
});

test('S4-a: folder reparenting refuses a parent folder the caller does not own in the active org', async () => {
  const missing = await call('daily-notes', callerA, 'PATCH', `/api/daily-notes/folders/${MISSING}`, { name: 'x' });
  for (const parent of [FOLDER_OTHER_A, FOLDER_CALLER_B, FOLDER_FOREIGN_B, MISSING]) {
    const res = await call('daily-notes', callerA, 'PATCH', `/api/daily-notes/folders/${FOLDER_OWN_A}`, { parent_folder_id: parent });
    assertSameAsMissing(res, missing, `reparent under ${parent}`);
  }
  const self = await call('daily-notes', callerA, 'PATCH', `/api/daily-notes/folders/${FOLDER_OWN_A}`, { parent_folder_id: FOLDER_OWN_A });
  assert.ok(self.status >= 400, `self-parent must be refused: ${self.text}`);
  assert.equal(await scalar(`SELECT parent_folder_id AS v FROM note_folders WHERE id = $1`, [FOLDER_OWN_A]), null);

  const sibling = await call('daily-notes', callerA, 'POST', '/api/daily-notes/folders', { name: 's4 sibling' });
  const ok = await call('daily-notes', callerA, 'PATCH', `/api/daily-notes/folders/${(sibling.json as { id: string }).id}`, { parent_folder_id: FOLDER_OWN_A });
  assert.equal(ok.status, 200, ok.text);
  const unset = await call('daily-notes', callerA, 'PATCH', `/api/daily-notes/folders/${(sibling.json as { id: string }).id}`, { parent_folder_id: null });
  assert.equal(unset.status, 200, unset.text);
});

test('S4-b: note create and update refuse a folder the caller does not own in the active org', async () => {
  const missingCreate = await call('daily-notes', callerA, 'POST', '/api/daily-notes', { title: 's4 foldered', folder_id: MISSING });
  for (const folder of [FOLDER_OTHER_A, FOLDER_CALLER_B, FOLDER_FOREIGN_B]) {
    const res = await call('daily-notes', callerA, 'POST', '/api/daily-notes', { title: 's4 foldered', folder_id: folder });
    assertSameAsMissing(res, missingCreate, `create note in ${folder}`);
  }
  assert.equal(await scalar(`SELECT count(*)::int AS v FROM notes WHERE user_id = $1 AND title = 's4 foldered'`, [CALLER]), 0);

  const missingUpdate = await call('daily-notes', callerA, 'PATCH', `/api/daily-notes/${NOTE_OWN_A}`, { folder_id: MISSING });
  for (const folder of [FOLDER_OTHER_A, FOLDER_CALLER_B, FOLDER_FOREIGN_B]) {
    const res = await call('daily-notes', callerA, 'PATCH', `/api/daily-notes/${NOTE_OWN_A}`, { folder_id: folder });
    assertSameAsMissing(res, missingUpdate, `move note to ${folder}`);
  }
  assert.equal(await scalar(`SELECT folder_id AS v FROM notes WHERE id = $1`, [NOTE_OWN_A]), null);

  const created = await call('daily-notes', callerA, 'POST', '/api/daily-notes', { title: 's4 own foldered', folder_id: FOLDER_OWN_A });
  assert.equal(created.status, 201, created.text);
  const moved = await call('daily-notes', callerA, 'PATCH', `/api/daily-notes/${NOTE_OWN_A}`, { folder_id: FOLDER_OWN_A });
  assert.equal(moved.status, 200, moved.text);
  const unfiled = await call('daily-notes', callerA, 'PATCH', `/api/daily-notes/${NOTE_OWN_A}`, { folder_id: null });
  assert.equal(unfiled.status, 200, unfiled.text);
});

test('S4-c: note sharing requires an active member of the active org and the listing hides strangers', async () => {
  const missing = await call('daily-notes', callerA, 'POST', `/api/daily-notes/${NOTE_OWN_A}/shares`, { user_id: MISSING });
  const foreign = await call('daily-notes', callerA, 'POST', `/api/daily-notes/${NOTE_OWN_A}/shares`, { user_id: FOREIGN });
  assertSameAsMissing(foreign, missing, 'share with a foreign user');
  assert.equal(await scalar(`SELECT count(*)::int AS v FROM note_shares WHERE note_id = $1 AND shared_with_user_id = $2`, [NOTE_OWN_A, FOREIGN]), 0);

  const ok = await call('daily-notes', callerA, 'POST', `/api/daily-notes/${NOTE_OWN_A}/shares`, { user_id: OTHER });
  assert.equal(ok.status, 201, ok.text);

  // A share row for a stranger that predates the check must not expose that user's name or email.
  await withClient((c) => c.query(
    `INSERT INTO note_shares (id, note_id, shared_with_user_id, permission, created_at) VALUES (gen_random_uuid()::text, $1, $2, 'view', NOW())`,
    [NOTE_OWN_A, FOREIGN],
  ));
  const list = await call('daily-notes', callerA, 'GET', `/api/daily-notes/${NOTE_OWN_A}/shares`);
  assert.equal(list.status, 200, list.text);
  const shares = (list.json as { shares: Array<{ user_id: string }> }).shares;
  assert.deepEqual(shares.map((s) => s.user_id), [OTHER]);
  assert.ok(!list.text.includes(email(FOREIGN)), 'listing leaked a stranger email');
});

test('S4-d: mark-unread checks membership before looking at the message', async () => {
  const missing = await call('spaces', callerA, 'POST', `/api/spaces/${MISSING}/mark-unread`, { message_id: MISSING });
  const probe = await call('spaces', callerA, 'POST', `/api/spaces/${SPACE_PRIV_A}/mark-unread`, { message_id: MSG_PRIV_A });
  assertSameAsMissing(probe, missing, 'mark-unread non-member existing pair');
  const probeWrongMsg = await call('spaces', callerA, 'POST', `/api/spaces/${SPACE_PRIV_A}/mark-unread`, { message_id: MISSING });
  assertSameAsMissing(probeWrongMsg, missing, 'mark-unread non-member missing message');
  const crossOrg = await call('spaces', callerA, 'POST', `/api/spaces/${SPACE_B}/mark-unread`, { message_id: MSG_B });
  assertSameAsMissing(crossOrg, missing, 'mark-unread cross-org');

  const ok = await call('spaces', callerA, 'POST', `/api/spaces/${SPACE_OWN_A}/mark-unread`, { message_id: MSG_OWN_A });
  assert.equal(ok.status, 200, ok.text);
  const notFoundMsg = await call('spaces', callerA, 'POST', `/api/spaces/${SPACE_OWN_A}/mark-unread`, { message_id: MSG_PRIV_A });
  assert.equal(notFoundMsg.status, 404, notFoundMsg.text);
});

test('S4-d: leaving a space answers a missing, foreign or non-member space identically', async () => {
  // DELETE /:id/members/me is shadowed by DELETE /:id/members/:userId (registered
  // first, returns notFound() for 'me'), so today every leave request gets the
  // same plain 404. This pins that the answer stays uniform and nothing is deleted.
  const missing = await call('spaces', callerA, 'DELETE', `/api/spaces/${MISSING}/members/me`);
  const nonMember = await call('spaces', callerA, 'DELETE', `/api/spaces/${SPACE_PRIV_A}/members/me`);
  assertSameAsMissing(nonMember, missing, 'leave non-member space');
  const crossOrg = await call('spaces', callerA, 'DELETE', `/api/spaces/${SPACE_B}/members/me`);
  assertSameAsMissing(crossOrg, missing, 'leave cross-org space');
  assert.equal(await scalar(`SELECT count(*)::int AS v FROM space_members WHERE space_id = $1 AND user_id = $2`, [SPACE_B, CALLER]), 1);
});

test('S4-f: creator-only space routes answer a missing space and a same-org space the caller cannot see identically', async () => {
  const cases: Array<[string, (s: string) => string, unknown]> = [
    ['PATCH', (s) => `/api/spaces/${s}`, { name: 's4 renamed' }],
    ['DELETE', (s) => `/api/spaces/${s}/members/${OTHER}`, undefined],
    ['DELETE', (s) => `/api/spaces/${s}`, undefined],
  ];
  for (const [method, path, body] of cases) {
    const missing = await call('spaces', callerA, method, path(MISSING), body);
    const probe = await call('spaces', callerA, method, path(SPACE_PRIV_A), body);
    assertSameAsMissing(probe, missing, `${method} ${path('<space>')}`);
  }
  assert.equal(await scalar(`SELECT is_archived AS v FROM spaces WHERE id = $1`, [SPACE_PRIV_A]), false);

  // A same-org member who is not the creator still gets the creator-only refusal.
  const memberNotCreator = await call('spaces', { id: OTHER, org: ORG_A }, 'PATCH', `/api/spaces/${SPACE_OWN_A}`, { name: 's4 x' });
  assert.equal(memberNotCreator.status, 403, memberNotCreator.text);
  // The creator keeps working.
  const creator = await call('spaces', callerA, 'PATCH', `/api/spaces/${SPACE_OWN_A}`, { name: 's4 renamed own' });
  assert.equal(creator.status, 200, creator.text);
});

test('S4-e: guests do not receive the org standup on the dashboard', async () => {
  const guest = await call('dashboard', { id: GUEST, org: ORG_A, role: 'guest' }, 'GET', '/api/dashboard?tz=UTC');
  assert.equal(guest.status, 200, guest.text);
  assert.equal((guest.json as { standup: unknown }).standup, null, `guest saw standup: ${guest.text.slice(0, 300)}`);

  const member = await call('dashboard', callerA, 'GET', '/api/dashboard?tz=UTC');
  assert.equal(member.status, 200, member.text);
  assert.match(String((member.json as { standup: { summary: string } | null }).standup?.summary), /standup summary/);
});

test('S4-f: dashboard recent activity hides restricted tasks and the notification count is bound to the active org', async () => {
  const res = await call('dashboard', callerA, 'GET', '/api/dashboard?tz=UTC');
  assert.equal(res.status, 200, res.text);
  const body = res.json as { recent_activity: Array<{ task_id: string }>; unread_notifications: number };
  const ids = body.recent_activity.map((a) => a.task_id);
  assert.ok(ids.includes(TASK_OPEN), 'open task activity should be visible');
  assert.ok(!ids.includes(TASK_RESTRICTED), 'restricted task activity leaked');
  assert.equal(body.unread_notifications, 0, 'org-B notification counted in an org-A session');

  // The restricted task's creator still sees it.
  const creator = await call('dashboard', { id: OTHER, org: ORG_A }, 'GET', '/api/dashboard?tz=UTC');
  const creatorIds = (creator.json as { recent_activity: Array<{ task_id: string }> }).recent_activity.map((a) => a.task_id);
  assert.ok(creatorIds.includes(TASK_RESTRICTED));

  const inB = await call('dashboard', callerB, 'GET', '/api/dashboard?tz=UTC');
  assert.equal((inB.json as { unread_notifications: number }).unread_notifications, 1);
});

test('S4-a/c review: parent ids must be strings, deleting a folder detaches its children, removed members leave the share list', async () => {
  const arr = await call('daily-notes', callerA, 'POST', '/api/daily-notes/folders', { name: 's4 array parent', parent_folder_id: [FOLDER_OWN_A] });
  assert.equal(arr.status, 400, arr.text);
  assert.equal(await scalar(`SELECT count(*)::int AS v FROM note_folders WHERE user_id = $1 AND name = 's4 array parent'`, [CALLER]), 0);

  const parent = await call('daily-notes', callerA, 'POST', '/api/daily-notes/folders', { name: 's4 doomed parent' });
  const parentId = (parent.json as { id: string }).id;
  const child = await call('daily-notes', callerA, 'POST', '/api/daily-notes/folders', { name: 's4 orphan', parent_folder_id: parentId });
  const childId = (child.json as { id: string }).id;
  const arrPatch = await call('daily-notes', callerA, 'PATCH', `/api/daily-notes/folders/${childId}`, { parent_folder_id: [FOLDER_OWN_A] });
  assert.equal(arrPatch.status, 400, arrPatch.text);
  assert.equal(await scalar(`SELECT parent_folder_id AS v FROM note_folders WHERE id = $1`, [childId]), parentId);

  const del = await call('daily-notes', callerA, 'DELETE', `/api/daily-notes/folders/${parentId}`);
  assert.equal(del.status, 200, del.text);
  assert.equal(await scalar(`SELECT parent_folder_id AS v FROM note_folders WHERE id = $1`, [childId]), null);
  const deadParent = await call('daily-notes', callerA, 'PATCH', `/api/daily-notes/folders/${childId}`, { parent_folder_id: parentId });
  assert.equal(deadParent.status, 404, deadParent.text);

  await call('daily-notes', callerA, 'POST', `/api/daily-notes/${NOTE_OWN_A}/shares`, { user_id: OTHER });
  await withClient((c) => c.query(`UPDATE org_members SET is_active = false WHERE org_id = $1 AND user_id = $2`, [ORG_A, OTHER]));
  try {
    const list = await call('daily-notes', callerA, 'GET', `/api/daily-notes/${NOTE_OWN_A}/shares`);
    assert.equal(list.status, 200, list.text);
    assert.ok(!list.text.includes(email(OTHER)), 'listing shows a removed member');
  } finally {
    await withClient((c) => c.query(`UPDATE org_members SET is_active = true WHERE org_id = $1 AND user_id = $2`, [ORG_A, OTHER]));
  }
});
