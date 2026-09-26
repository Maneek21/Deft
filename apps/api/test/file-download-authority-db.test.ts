import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import type { ServerType } from '@hono/node-server';

const target = process.env.DATABASE_URL ?? '';
const safe = /^postgresql:\/\/gate_g_test@127\.0\.0\.1:55435\/gate_g_20260926_c17_file_download_test(?:_v[0-9]+)?$/.test(target)
  && process.env.DEFT_TEST_DATABASE_URL === target;
Object.assign(process.env, { JWT_SECRET: 'synthetic-file-download-only', NODE_ENV: 'test' });
let server: ServerType | undefined, base: string;
after(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  if (safe) await (await import('../src/lib/db.js')).closeDb();
});

async function fixture(parent: 'message' | 'task' | 'staged' = 'message', grant: 'watcher' | 'assignee' = 'watcher') {
  const [{ db }, s, orm, web, { Hono }, { serve }, { authMiddleware }, upload, spaces, tasks, { localFileStore }] = await Promise.all([
    import('../src/lib/db.js'), import('@deft/db/schema'), import('drizzle-orm'), import('../src/lib/web-sessions.js'),
    import('hono'), import('@hono/node-server'), import('../src/middleware/auth.js'), import('../src/routes/upload.js'),
    import('../src/routes/spaces.js'), import('../src/routes/tasks.js'), import('../src/lib/file-store.js'),
  ]);
  if (!server) {
    const app = new Hono(); app.use('/api/*', authMiddleware); app.route('/api/files', upload.fileServingRoutes);
    app.route('/api/upload', upload.uploadRoutes); app.route('/api/spaces', spaces.spaceRoutes);
    app.route('/api/tasks', tasks.taskRoutes);
    base = await new Promise<string>(resolve => { server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, info => resolve(`http://127.0.0.1:${info.port}`)); });
  }
  const org = randomUUID(), owner = randomUUID(), reader = randomUUID(), space = randomUUID(), message = randomUUID();
  await db.insert(s.orgs).values({ id: org, name: 'File download proof', slug: `file-${org}` });
  await db.insert(s.users).values([owner, reader].map(id => ({ id, name: 'File proof human', email: `${id}@example.test` })));
  await db.insert(s.orgMembers).values([{ org_id: org, user_id: owner, role: 'owner' }, { org_id: org, user_id: reader, role: 'guest' }]);
  await db.insert(s.spaces).values({ id: space, org_id: org, name: 'Private parent', type: 'private', created_by: owner });
  await db.insert(s.spaceMembers).values([owner, reader].map(user_id => ({ space_id: space, user_id })));
  await db.insert(s.messages).values({ id: message, org_id: org, space_id: space, user_id: owner, content: 'Parent' });
  const project = randomUUID(), task = randomUUID();
  if (parent === 'task') {
    await db.insert(s.projects).values({ id: project, org_id: org, name: 'Restricted Task parent', prefix: 'FIL', lead_id: owner });
    await db.insert(s.tasks).values({ id: task, org_id: org, project_id: project, number: 1, title: 'Parent', created_by: owner, metadata: { visibility: 'restricted' } });
    await db.insert(grant === 'watcher' ? s.taskWatchers : s.taskAssignees).values({ task_id: task, user_id: reader });
  }
  const ownerWeb = await web.createWebSession({ id: owner, org_id: org, email: `${owner}@example.test` });
  const readerWeb = await web.createWebSession({ id: reader, org_id: org, email: `${reader}@example.test` });
  const bytes = 'private bounded attachment';
  const form = new FormData(); form.append('file', new File([bytes], 'safe.txt', { type: 'text/plain' }));
  const targetParent = parent === 'message' ? `?message_id=${message}` : parent === 'task' ? `?task_id=${task}` : '';
  const uploaded = await fetch(`${base}/api/upload${targetParent}`, { method: 'POST', headers: { Authorization: `Bearer ${ownerWeb.accessToken}` }, body: form });
  assert.equal(uploaded.status, 201); const uploadedFile = await uploaded.json() as any;
  const [file] = await db.select().from(s.files).where(orm.and(orm.eq(s.files.org_id, org), orm.eq(s.files.id, uploadedFile.id)));
  assert.ok(file);
  const get = (token = readerWeb.accessToken) => fetch(`${base}/api/files/${file.id}`, { headers: { Authorization: `Bearer ${token}` } });
  const cleanup = () => localFileStore.delete(file.storage_key);
  return { db, s, ...orm, org, owner, reader, space, message, project, task, ownerWeb, readerWeb, file, bytes, get, cleanup, localFileStore };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function heldRead(h: Fixture, change: () => Promise<void>, token = h.readerWeb.accessToken) {
  const original = h.localFileStore.get;
  let entered!: () => void, release!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; }), released = new Promise<void>(resolve => { release = resolve; });
  h.localFileStore.get = async function(key, options) {
    if (key === h.file.storage_key) { entered(); await released; }
    return original.call(this, key, options);
  };
  let pending: Promise<Response> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  try {
    pending = h.get(token);
    await Promise.race([reading, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('File read was not reached')), 3000); })]);
    clearTimeout(timer); await change(); release(); return await pending;
  } finally { clearTimeout(timer); release(); await pending?.catch(() => {}); h.localFileStore.get = original; }
}

test('File download rechecks Message parent after held real storage read without delivering withdrawn bytes', { skip: !safe }, async () => {
  const h = await fixture();
  const get = h.localFileStore.get;
  let entered!: () => void, release!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; }), released = new Promise<void>(resolve => { release = resolve; });
  h.localFileStore.get = async function(key, ...options) {
    if (key === h.file.storage_key) { entered(); await released; }
    return get.call(this, key, ...options);
  };
  let pending: Promise<Response> | undefined;
  try {
    pending = h.get(); await reading;
    const removed = await fetch(`${base}/api/spaces/${h.space}/members/${h.reader}`, { method: 'DELETE', headers: { Authorization: `Bearer ${h.ownerWeb.accessToken}` } });
    assert.equal(removed.status, 200); release();
    const response = await pending; assert.equal(response.status, 404);
    assert.ok(!(await response.text()).includes(h.bytes));
  } finally { release(); await pending?.catch(() => {}); h.localFileStore.get = get; await h.cleanup(); }
});

test('File download honors current Task watcher and assignee grants after storage waits', { skip: !safe }, async () => {
  for (const grant of ['watcher', 'assignee'] as const) {
    const h = await fixture('task', grant);
    try {
      const allowed = await h.get(); assert.equal(allowed.status, 200); assert.equal(await allowed.text(), h.bytes);
      const response = await heldRead(h, async () => {
        const path = grant === 'watcher' ? `/api/tasks/${h.task}/watch` : `/api/tasks/${h.task}/assignees/${h.reader}`;
        const token = grant === 'watcher' ? h.readerWeb.accessToken : h.ownerWeb.accessToken;
        assert.equal((await fetch(`${base}${path}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })).status, 200);
      });
      assert.equal(response.status, 404); assert.ok(!(await response.text()).includes(h.bytes));
    } finally { await h.cleanup(); }
  }
});

test('File download denies org membership withdrawal and stored SID expiry after storage waits', { skip: !safe }, async () => {
  for (const mutation of ['membership', 'sid'] as const) {
    const h = await fixture();
    try {
      const response = await heldRead(h, async () => {
        if (mutation === 'membership') await h.db.update(h.s.orgMembers).set({ is_active: false }).where(h.and(h.eq(h.s.orgMembers.org_id, h.org), h.eq(h.s.orgMembers.user_id, h.reader)));
        else await h.db.update(h.s.webSessions).set({ expires_at: new Date(Date.now() - 1) }).where(h.eq(h.s.webSessions.user_id, h.reader));
      });
      assert.equal(response.status, 401); assert.ok(!(await response.text()).includes(h.bytes));
    } finally { await h.cleanup(); }
  }
});

test('File download preserves staged uploader access and denies a newly linked inaccessible parent after storage waits', { skip: !safe }, async () => {
  const h = await fixture('staged');
  try {
    const own = await h.get(h.ownerWeb.accessToken); assert.equal(own.status, 200); assert.equal(await own.text(), h.bytes);
    assert.equal((await h.get()).status, 404);
    const response = await heldRead(h, async () => {
      // Direct typed-link fixture is intentional: it isolates the real FK-backed
      // custody change, not an unauthorized public attachment claim.
      await h.db.insert(h.s.messageAttachments).values({ org_id: h.org, message_id: h.message, file_id: h.file.id });
      await h.db.delete(h.s.spaceMembers).where(h.and(h.eq(h.s.spaceMembers.space_id, h.space), h.eq(h.s.spaceMembers.user_id, h.owner)));
    }, h.ownerWeb.accessToken);
    assert.equal(response.status, 404); assert.ok(!(await response.text()).includes(h.bytes));
  } finally { await h.cleanup(); }
});

test('File download bounds bytes, rejects changed retained storage and preserves default FileStore reads', { skip: !safe }, async () => {
  const h = await fixture();
  try {
    assert.equal((await h.localFileStore.get(h.file.storage_key)).toString(), h.bytes);
    await assert.rejects(h.localFileStore.get(h.file.storage_key, { maxBytes: 1 }), /read limit/);
    const abort = new AbortController();
    const reading = h.localFileStore.get(h.file.storage_key, { maxBytes: 1024, signal: abort.signal }); abort.abort();
    await assert.rejects(reading, error => error instanceof Error && error.name === 'AbortError');
    await h.localFileStore.put(h.file.storage_key, Buffer.from('different length'));
    const changed = await h.get(); assert.equal(changed.status, 404); assert.ok(!(await changed.text()).includes('different length'));
  } finally { await h.cleanup(); }
});

test('File download samples the verified JWT deadline after held storage delivery without changing a shared clock', { skip: !safe }, async () => {
  const h = await fixture();
  try {
    const { default: jwt } = await import('jsonwebtoken');
    const claims = jwt.decode(h.readerWeb.accessToken) as Record<string, unknown>;
    const expires = Math.floor(Date.now() / 1000) + 2;
    const token = jwt.sign({ ...claims, exp: expires }, process.env.JWT_SECRET!, { algorithm: 'HS256' });
    const response = await heldRead(h, async () => {
      while (Date.now() < expires * 1000 + 1) await new Promise(resolve => setTimeout(resolve, 25));
    }, token);
    assert.equal(response.status, 401); assert.ok(!(await response.text()).includes(h.bytes));
  } finally { await h.cleanup(); }
});

test('File download validates the entire typed Message and Task tenant parent chain', { skip: !safe }, async () => {
  for (const parent of ['message', 'task'] as const) {
    const h = await fixture(parent);
    try {
      const foreign = randomUUID(); await h.db.insert(h.s.orgs).values({ id: foreign, slug: `foreign-${foreign}`, name: 'Foreign parent fixture' });
      if (parent === 'message') {
        const space = randomUUID(); await h.db.insert(h.s.spaces).values({ id: space, org_id: foreign, name: 'Foreign private parent', type: 'private', created_by: h.owner });
        await h.db.insert(h.s.spaceMembers).values({ space_id: space, user_id: h.reader });
        await h.db.update(h.s.messages).set({ space_id: space }).where(h.eq(h.s.messages.id, h.message));
      } else {
        const project = randomUUID(); await h.db.insert(h.s.projects).values({ id: project, org_id: foreign, name: 'Foreign parent', prefix: 'FRN', lead_id: h.reader });
        await h.db.update(h.s.tasks).set({ project_id: project }).where(h.eq(h.s.tasks.id, h.task));
      }
      const response = await h.get(); assert.equal(response.status, 404); assert.ok(!(await response.text()).includes(h.bytes));
    } finally { await h.cleanup(); }
  }
});

test('File final staged custody fence blocks actual typed-link FK insertion through the last SID wait', { skip: !safe }, async () => {
  const h = await fixture('staged');
  const { default: pg } = await import('pg');
  const blocker = new pg.Client({ connectionString: target }), observer = new pg.Client({ connectionString: target });
  await blocker.connect(); await observer.connect();
  let pending: Promise<Response> | undefined, linking: Promise<unknown> | undefined;
  try {
    const [session] = await h.db.select().from(h.s.webSessions).where(h.eq(h.s.webSessions.user_id, h.owner)); assert.ok(session);
    await blocker.query('BEGIN'); await blocker.query('SELECT id FROM web_sessions WHERE id=$1 FOR UPDATE', [session.id]);
    const { rows: [pid] } = await blocker.query('SELECT pg_backend_pid() AS id');
    pending = h.get(h.ownerWeb.accessToken);
    let guardPid: number | undefined;
    for (let i = 0; i < 100; i++) {
      const { rows: [row] } = await observer.query('SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [pid.id]);
      if (row) { guardPid = row.pid; break; } await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.ok(guardPid, 'final File guard waits on the actual exact SID row');
    linking = h.db.insert(h.s.messageAttachments).values({ org_id: h.org, message_id: h.message, file_id: h.file.id }).execute();
    let linkWaited = false;
    for (let i = 0; i < 100; i++) {
      const { rows: [row] } = await observer.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [guardPid]);
      if (row.n) { linkWaited = true; break; } await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.ok(linkWaited, 'actual FK insert cannot reparent the staged upload while its final authority is locked');
    await blocker.query('COMMIT');
    const delivered = await pending; assert.equal(delivered.status, 200); assert.equal(await delivered.text(), h.bytes); await linking;
  } finally { await blocker.query('ROLLBACK'); await pending?.catch(() => {}); await linking?.catch(() => {}); await blocker.end(); await observer.end(); await h.cleanup(); }
});
