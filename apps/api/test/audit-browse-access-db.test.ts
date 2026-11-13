/**
 * Workspace audit browsing is for active owners and admins. A message's text
 * is shown only to a viewer who can read the message's space; other entries
 * keep who, when, the action and the space id.
 *
 * Run:
 *   DATABASE_URL=... DEFT_TEST_DATABASE_URL=... pnpm --filter @deft/api test test/audit-browse-access-db.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';
const stamp = Date.now();
const p = (name: string) => `w2a-${name}-${stamp}`;

const ORG_A = p('org-a');
const ORG_B = p('org-b');
const OWNER = p('owner');       // owner of org A, not in the private space
const ADMIN = p('admin');       // admin of org A, in the private space
const MEMBER = p('member');     // member of org A, in the private space
const GUEST = p('guest');       // guest of org A
const OWNER_B = p('owner-b');   // owner of org B
const FORMER_OWNER = p('former-owner'); // inactive owner of org A
const PRIVATE_SPACE = p('space');
const MESSAGE = p('message');
const SECRET = `w2asecret${stamp}`;
const SECRET_B = `w2aforeign${stamp}`;

async function q(sql: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    return await c.query(sql, params);
  } finally {
    await c.end();
  }
}

before(async () => {
  for (const org of [ORG_A, ORG_B]) await q(`INSERT INTO orgs (id, name, slug) VALUES ($1, $1, $1)`, [org]);
  for (const [user, org, role] of [[OWNER, ORG_A, 'owner'], [ADMIN, ORG_A, 'admin'], [MEMBER, ORG_A, 'member'], [GUEST, ORG_A, 'guest'], [OWNER_B, ORG_B, 'owner'], [FORMER_OWNER, ORG_A, 'owner']]) {
    await q(`INSERT INTO users (id, email, name, is_agent) VALUES ($1, $2, $1, false)`, [user, `${user}@test.local`]);
    await q(`INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES (gen_random_uuid()::text, $1, $2, $3, $4)`, [org, user, role, user !== FORMER_OWNER]);
  }
  await q(
    `INSERT INTO spaces (id, org_id, name, type, is_default, is_archived, agent_enabled, created_by, created_at, updated_at)
     VALUES ($1, $2, $1, 'private', false, false, true, $3, NOW(), NOW())`,
    [PRIVATE_SPACE, ORG_A, ADMIN],
  );
  for (const user of [ADMIN, MEMBER]) {
    await q(
      `INSERT INTO space_members (id, space_id, user_id, is_muted, notification_level, joined_at)
       VALUES (gen_random_uuid()::text, $1, $2, false, 'all', NOW())`,
      [PRIVATE_SPACE, user],
    );
  }
  await q(
    `INSERT INTO messages (id, org_id, space_id, user_id, content, is_pinned, is_deleted, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, false, false, NOW(), NOW())`,
    [MESSAGE, ORG_A, PRIVATE_SPACE, ADMIN, `${SECRET} message`],
  );
  await q(
    `INSERT INTO audit_log (id, org_id, actor_type, actor_id, action, entity_type, entity_id, before_state, after_state, metadata)
     VALUES ($1, $2, 'agent', $3, 'post_message', 'message', $4, $5::jsonb, $5::jsonb, $6::jsonb),
            ($7, $8, 'user', $9, 'post_message', 'message', $10, NULL, $11::jsonb, '{}'::jsonb)`,
    [
      p('audit-a'), ORG_A, ADMIN, MESSAGE,
      JSON.stringify({ message_id: MESSAGE, space_id: PRIVATE_SPACE, content: `${SECRET} message` }),
      JSON.stringify({ action_id: p('action'), space_name: `${SECRET} space`, filename: `${SECRET}.pdf` }),
      p('audit-b'), ORG_B, OWNER_B, p('message-b'), JSON.stringify({ content: SECRET_B }),
    ],
  );
});

after(async () => {
  const orgs = [ORG_A, ORG_B];
  await q(`DELETE FROM audit_log WHERE org_id = ANY($1)`, [orgs]);
  await q(`DELETE FROM messages WHERE org_id = ANY($1)`, [orgs]);
  await q(`DELETE FROM space_members WHERE space_id = $1`, [PRIVATE_SPACE]);
  await q(`DELETE FROM spaces WHERE org_id = ANY($1)`, [orgs]);
  await q(`DELETE FROM org_members WHERE org_id = ANY($1)`, [orgs]);
  await q(`DELETE FROM users WHERE id = ANY($1)`, [[OWNER, ADMIN, MEMBER, GUEST, OWNER_B, FORMER_OWNER]]).catch(() => undefined);
  await q(`DELETE FROM orgs WHERE id = ANY($1)`, [orgs]).catch(() => undefined);
});

async function browse(userId: string, orgId: string, role: string, query = '') {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, org_id: orgId, email: `${userId}@test.local`, role, sid: `w2a-${stamp}` });
    await next();
  });
  app.route('/api/audit', (await import('../src/routes/audit.js')).auditRoutes);
  const res = await app.request(`/api/audit${query}`);
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as unknown };
}

test('members, guests and inactive owners cannot browse the workspace audit log', async () => {
  for (const user of [MEMBER, GUEST, FORMER_OWNER]) {
    // The session role is not trusted; the live membership role decides.
    const res = await browse(user, ORG_A, 'admin');
    assert.equal(res.status, 403, res.text);
    assert.ok(['FORBIDDEN', 'ORG_MEMBERSHIP_INACTIVE'].includes((res.json as { code: string }).code), res.text);
    assert.ok(!res.text.includes(SECRET));
  }
});

test('an owner or admin in the space sees the entry with its text', async () => {
  const res = await browse(ADMIN, ORG_A, 'admin');
  assert.equal(res.status, 200, res.text);
  const rows = res.json as Array<{ entity_id: string; after_state: { content?: string } }>;
  assert.deepEqual(rows.map((r) => r.entity_id), [MESSAGE]);
  assert.equal(rows[0]!.after_state.content, `${SECRET} message`);
});

test('an owner outside a private space sees the entry without the message text', async () => {
  const res = await browse(OWNER, ORG_A, 'owner', '?entity_type=message');
  assert.equal(res.status, 200, res.text);
  const rows = res.json as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.entity_id, MESSAGE);
  assert.equal(rows[0]!.actor_id, ADMIN);
  assert.equal(rows[0]!.action, 'post_message');
  assert.deepEqual(rows[0]!.after_state, { message_id: MESSAGE, space_id: PRIVATE_SPACE });
  assert.deepEqual(rows[0]!.before_state, { message_id: MESSAGE, space_id: PRIVATE_SPACE });
  assert.deepEqual(rows[0]!.metadata, { action_id: p('action') });
  assert.equal(rows[0]!.content_omitted, true);
  assert.ok(!res.text.includes(SECRET), res.text);
  const unfiltered = await browse(OWNER, ORG_A, 'owner');
  assert.equal(unfiltered.status, 200, unfiltered.text);
  assert.ok(unfiltered.text.includes(MESSAGE), unfiltered.text);
  assert.ok(!unfiltered.text.includes(SECRET), unfiltered.text);
});

test('another workspace never sees these entries', async () => {
  const res = await browse(OWNER_B, ORG_B, 'owner');
  assert.equal(res.status, 200, res.text);
  assert.ok(!res.text.includes(SECRET), res.text);
  assert.ok(!res.text.includes(MESSAGE), res.text);
  const own = await browse(OWNER, ORG_A, 'owner');
  assert.ok(!own.text.includes(SECRET_B), own.text);
});
