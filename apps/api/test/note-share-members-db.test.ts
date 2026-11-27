// Note-sharing cases were retired with Notes (the old share API now answers
// 410 NOTES_MOVED; document sharing is covered by the drives tests). This file
// now covers the members list's `is_defty` flag, which the Share dialog uses to
// leave Defty out, and that a guest sees no email addresses.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Hono } from 'hono';
import { memberRoutes } from '../src/routes/members.js';
import { ensureDeftyDm, ensureDeftyMembership } from '../src/lib/ensure-defty-membership.js';

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
const run = randomUUID().slice(0, 8);
const org = randomUUID();
const owner = randomUUID(), raj = randomUUID(), gus = randomUUID();
const people: Array<[string, string, string]> = [
  [owner, 'Sam Owner', 'owner'],
  [raj, 'Raj Patel', 'member'],
  [gus, 'Gus Guest', 'guest'],
];
const emailOf = (id: string) => `nsm-${run}-${id}@test.local`;

before(async () => {
  await c.connect();
  await c.query(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'Note Share', $2)`, [org, `note-share-${run}`]);
  for (const [id, name, role] of people) {
    await c.query(`INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, 'hash')`, [id, emailOf(id), `${name} ${run}`]);
    await c.query(`INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES (gen_random_uuid()::text, $1, $2, $3, true)`, [org, id, role]);
  }
});

after(async () => {
  await c.query(`DELETE FROM messages WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE org_id = $1)`, [org]);
  await c.query(`DELETE FROM spaces WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM org_members WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [people.map(([id]) => id)]);
  await c.query(`DELETE FROM orgs WHERE id = $1`, [org]);
  await c.end();
});

function app(viewer: string) {
  const hono = new Hono();
  hono.use('*', async (ctx, next) => {
    ctx.set('user', { id: viewer, org_id: org, email: emailOf(viewer), sid: 's', role: people.find(([id]) => id === viewer)![2] } as never);
    await next();
  });
  hono.route('/api/members', memberRoutes);
  return hono;
}

async function call(viewer: string, path: string, init?: { method: string; body?: unknown }) {
  const res = await app(viewer).request(path, init ? {
    method: init.method,
    headers: { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  } : undefined);
  return { status: res.status, body: await res.json() as any };
}

test('members list: Defty is flagged is_defty, also for a guest, who sees no email addresses', async () => {
  // The Share dialog leaves Defty out by this flag: Defty reads notes as the
  // person asking it, so a share gives it nothing.
  const defty = await ensureDeftyMembership(org);
  await ensureDeftyDm(org, gus);
  const asOwner = (await call(owner, '/api/members')).body as Array<Record<string, unknown>>;
  assert.equal(asOwner.find((m) => m.id === defty)?.is_defty, true);
  assert.equal(asOwner.find((m) => m.id === raj)?.is_defty, false);
  const asGuest = (await call(gus, '/api/members')).body as Array<Record<string, unknown>>;
  const deftyForGuest = asGuest.find((m) => m.id === defty);
  assert.ok(deftyForGuest, 'the guest sees Defty, with whom they have a DM');
  assert.equal(deftyForGuest.email, null, 'a guest sees no one else\'s email address');
  assert.equal(deftyForGuest.is_defty, true);
});
