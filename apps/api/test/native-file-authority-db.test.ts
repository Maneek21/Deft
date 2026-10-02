import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import * as s from '@deft/db/schema';
import { db, closeDb } from '../src/lib/db.js';
import { createWebSession } from '../src/lib/web-sessions.js';
import { authMiddleware } from '../src/middleware/auth.js';
import { resourceRoutes } from '../src/routes/resources.js';
import { spaceRoutes } from '../src/routes/spaces.js';
import { taskRoutes } from '../src/routes/tasks.js';

const target = process.env.DATABASE_URL ?? '';
const safe = /^postgresql:\/\/gate_g_test@127\.0\.0\.1:55435\/gate_g_20260926_c17_file_download_test(?:_v[0-9]+)?$/.test(target)
  && process.env.DEFT_TEST_DATABASE_URL === target;
after(async () => { if (safe) await closeDb(); });

async function fixture(staged = false, taskParent = false) {
  const org = randomUUID(), owner = randomUUID(), reader = randomUUID(), space = randomUUID(), message = randomUUID(), file = randomUUID();
  await db.insert(s.orgs).values({ id: org, slug: org, name: 'Native File metadata fixture' });
  await db.insert(s.users).values([owner, reader].map(id => ({ id, name: 'Synthetic human', email: `${id}@example.test` })));
  await db.insert(s.orgMembers).values([{ org_id: org, user_id: owner, role: 'owner' }, { org_id: org, user_id: reader, role: 'guest' }]);
  await db.insert(s.spaces).values({ id: space, org_id: org, name: 'Private File parent', type: 'private', created_by: owner });
  await db.insert(s.spaceMembers).values([owner, reader].map(user_id => ({ space_id: space, user_id })));
  await db.insert(s.messages).values({ id: message, org_id: org, space_id: space, user_id: owner, content: 'Synthetic parent' });
  const label = 'PRIVATE_METADATA_SENTINEL.txt';
  await db.insert(s.files).values({ id: file, org_id: org, uploaded_by: owner, filename: label,
    mime_type: 'text/plain', size_bytes: 1, storage_key: `synthetic-${file}`, processing_status: 'ready' });
  const project = randomUUID(), task = randomUUID();
  if (taskParent) {
    await db.insert(s.projects).values({ id: project, org_id: org, name: 'Restricted parent', prefix: 'NFM', lead_id: owner });
    await db.insert(s.tasks).values({ id: task, org_id: org, project_id: project, number: 1, title: 'Private parent', created_by: owner, metadata: { visibility: 'restricted' } });
    await db.insert(s.taskWatchers).values({ task_id: task, user_id: reader });
    await db.insert(s.taskAttachments).values({ org_id: org, task_id: task, file_id: file });
  } else if (!staged) await db.insert(s.messageAttachments).values({ org_id: org, message_id: message, file_id: file });
  const ownerWeb = await createWebSession({ id: owner, org_id: org, email: `${owner}@example.test` });
  const readerWeb = await createWebSession({ id: reader, org_id: org, email: `${reader}@example.test` });
  const app = new Hono(); app.use('/api/*', authMiddleware); app.route('/api/resources', resourceRoutes); app.route('/api/spaces', spaceRoutes);
  app.route('/api/tasks', taskRoutes);
  const ref = { schema_version: 'deft.resource_ref.v2', provider: { kind: 'core', provider_instance_id: 'files' }, resource_type: 'file', resource_id: file };
  const get = (token = readerWeb.accessToken) => app.request(`/api/resources/resolve?ref=${encodeURIComponent(JSON.stringify(ref))}`, { headers: { Authorization: `Bearer ${token}` } });
  const remove = () => app.request(`/api/spaces/${space}/members/${reader}`, { method: 'DELETE', headers: { Authorization: `Bearer ${ownerWeb.accessToken}` } });
  return { org, owner, reader, space, message, file, task, label, app, ref, get, remove, ownerWeb, readerWeb };
}

// Delay delivery of an actual PostgreSQL result; no authority result is mocked.
// The fixture mutates through the supported HTTP route while that response waits.
async function heldParentResult(run: () => Promise<Response>, change: () => Promise<void>, task = false) {
  const pool = db.$client;
  const original = pool.query;
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>(r => { entered = r; }), released = new Promise<void>(r => { release = r; });
  let held = false;
  pool.query = (async function (...args: unknown[]) {
    const result = await (original as Function).apply(pool, args);
    const query = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string })?.text ?? '';
    const parentQuery = task ? query.includes('from "tasks"') && query.includes('inner join "projects"')
      : query.includes('from "messages"') && query.includes('inner join "space_members"');
    if (!held && query.startsWith('select ') && parentQuery) {
      held = true; entered(); await released;
    }
    return result;
  }) as typeof pool.query;
  let pending: Promise<Response> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  try {
    pending = run();
    await Promise.race([reached, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Parent read not reached')), 3000); timer.unref(); })]);
    clearTimeout(timer);
    await change(); release(); return await pending;
  } finally { clearTimeout(timer); release(); await pending?.catch(() => {}); pool.query = original; }
}

test('Native File metadata denies a supported parent withdrawal while the actual parent query result is delayed', { skip: !safe }, async () => {
  const h = await fixture();
  assert.equal((await (await h.get()).json() as { state: string }).state, 'available');
  const response = await heldParentResult(h.get, async () => { assert.equal((await h.remove()).status, 200); });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.equal(JSON.parse(body).state, 'unavailable');
  assert.equal(body.includes(h.label), false);
});

test('Native File metadata honors Task watcher withdrawal after the actual visibility result waits', { skip: !safe }, async () => {
  const h = await fixture(false, true);
  const response = await heldParentResult(h.get, async () => {
    const removed = await h.app.request(`/api/tasks/${h.task}/watch`, { method: 'DELETE', headers: { Authorization: `Bearer ${h.readerWeb.accessToken}` } });
    assert.equal(removed.status, 200);
  }, true);
  assert.equal(response.status, 200); const body = await response.text();
  assert.equal(JSON.parse(body).state, 'unavailable'); assert.equal(body.includes(h.label), false);
});

test('Native File metadata rejects verified JWT expiry after the held parent result', { skip: !safe }, async () => {
  const h = await fixture(); const { default: jwt } = await import('jsonwebtoken');
  const claims = jwt.decode(h.readerWeb.accessToken) as Record<string, unknown>;
  const expires = Math.floor(Date.now() / 1000) + 2;
  const token = jwt.sign({ ...claims, exp: expires }, process.env.JWT_SECRET!, { algorithm: 'HS256' });
  const response = await heldParentResult(() => h.get(token), async () => {
    while (Date.now() < expires * 1000 + 1) await new Promise(r => setTimeout(r, 20));
  });
  assert.equal(response.status, 403); assert.equal((await response.text()).includes(h.label), false);
});

test('Native File metadata preserves staged uploader access and denies foreign SID, blocked and malformed parent metadata', { skip: !safe }, async () => {
  const h = await fixture(true);
  const own = await h.get(h.ownerWeb.accessToken); assert.equal(own.status, 200);
  assert.equal((await own.json() as { state: string }).state, 'available');
  assert.equal((await (await h.get()).json() as { state: string }).state, 'unavailable');
  const { NativeResourceService } = await import('../src/lib/native-resource-service.js');
  const ownerSid = JSON.parse(Buffer.from(h.ownerWeb.accessToken.split('.')[1]!, 'base64url').toString()).sid;
  await assert.rejects(new NativeResourceService().resolve({ org_id: h.org, user_id: h.owner, sid: ownerSid }, h.ref, `Bearer ${h.readerWeb.accessToken}`), { code: 'RESOURCE_ACCESS_DENIED' });
  await db.update(s.files).set({ processing_status: 'blocked' }).where(eq(s.files.id, h.file));
  assert.equal((await (await h.get(h.ownerWeb.accessToken)).json() as { state: string }).state, 'unavailable');
  await db.update(s.files).set({ processing_status: 'ready' }).where(eq(s.files.id, h.file));
  const foreign = randomUUID(), foreignSpace = randomUUID();
  await db.insert(s.orgs).values({ id: foreign, slug: foreign, name: 'Foreign parent' });
  await db.insert(s.spaces).values({ id: foreignSpace, org_id: foreign, name: 'Foreign parent', type: 'private', created_by: h.owner });
  await db.insert(s.spaceMembers).values({ space_id: foreignSpace, user_id: h.owner });
  await db.update(s.messages).set({ space_id: foreignSpace }).where(eq(s.messages.id, h.message));
  await db.insert(s.messageAttachments).values({ org_id: h.org, message_id: h.message, file_id: h.file });
  const unavailable = await h.get(h.ownerWeb.accessToken); assert.equal((await unavailable.json() as { state: string }).state, 'unavailable');
});

test('Native File metadata retains the real parent grant lock through its terminal SID wait', { skip: !safe }, async () => {
  const h = await fixture(); const { default: pg } = await import('pg');
  const blocker = new pg.Client({ connectionString: target }), observer = new pg.Client({ connectionString: target });
  await blocker.connect(); await observer.connect();
  let reading: Promise<Response> | undefined, removing: Promise<Response> | undefined;
  try {
    const sid = JSON.parse(Buffer.from(h.readerWeb.accessToken.split('.')[1]!, 'base64url').toString()).sid;
    await blocker.query('BEGIN'); await blocker.query('SELECT id FROM web_sessions WHERE id=$1 FOR UPDATE', [sid]);
    const { rows: [backend] } = await blocker.query('SELECT pg_backend_pid() AS id');
    reading = h.get(); let guardPid: number | undefined;
    for (let i = 0; i < 100; i++) {
      const { rows: [row] } = await observer.query('SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [backend.id]);
      if (row) { guardPid = row.pid; break; } await new Promise(r => setTimeout(r, 1));
    }
    assert.ok(guardPid, 'the current File metadata guard reaches the real locked SID');
    removing = h.remove(); let parentWaited = false;
    for (let i = 0; i < 100; i++) {
      const { rows: [row] } = await observer.query('SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [guardPid]);
      if (row) { parentWaited = true; break; } await new Promise(r => setTimeout(r, 1));
    }
    assert.ok(parentWaited, 'supported parent withdrawal cannot cross the pending final authority decision');
    await blocker.query('COMMIT');
    const allowed = await reading; assert.equal(allowed.status, 200); assert.equal((await allowed.json() as { state: string }).state, 'available');
    assert.equal((await removing).status, 200);
    assert.equal((await (await h.get()).json() as { state: string }).state, 'unavailable');
  } finally { await blocker.query('ROLLBACK'); await reading?.catch(() => {}); await removing?.catch(() => {}); await blocker.end(); await observer.end(); }
});
