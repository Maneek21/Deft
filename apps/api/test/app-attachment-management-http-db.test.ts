import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = (() => { try {
  if (!target || target !== process.env.DATABASE_URL) return false;
  const u = new URL(target);
  return u.hostname === '127.0.0.1' && u.port === '55435' && u.username === 'gate_g_test' && !u.password
    && /^\/gate_g_20260927_c22_email7_test(?:_v[0-9]+)?$/u.test(u.pathname) && !u.search && !u.hash;
} catch { return false; } })();

test('explicit channel3 metadata supports normal owner and operator management without delivery authority',
  { skip: !safe, timeout: 60_000 }, async t => {
  Object.assign(process.env, { DEFT_APPS_ENABLED: 'true', DEFT_APP_RUNS_ENABLED: 'true',
    DEFT_APP_RUN_APP_ORIGIN_ENABLED: 'true', DEFT_APP_ATTACHMENT_BROKER_ENABLED: 'true',
    DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED: 'true', DEFT_APP_RUNTIME_CHANNEL_ENABLED: 'true',
    DEFT_APP_V5_RUNTIME_ACTIONS_ENABLED: 'true' });
  const key = (purpose: string) => ({ current: purpose, keys: { [purpose]: createHash('sha256').update(`email7:${purpose}`).digest('base64') } });
  process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({ schema_version: 'deft.app_run_keyring.v1',
    run_encryption: key('email7-enc'), receipt_signing: key('email7-sign'), fingerprint: key('email7-fp') });
  const root = process.env.DEFT_EMAIL7_AUTHOR_DIR;
  assert.ok(root && resolve(root).startsWith('C:\\Users\\Osheen Pradhan\\Documents\\Codex\\'));
  const [{ app }, { serve }, { db, closeDb }, s, orm, web, runs, attachments] = await Promise.all([
    import('../src/index.js'), import('@hono/node-server'), import('../src/lib/db.js'), import('@deft/db/schema'),
    import('drizzle-orm'), import('../src/lib/web-sessions.js'), import('../src/lib/app-run-runtime.js'),
    import('../src/lib/app-attachment-runtime.js')]);
  let server!: ReturnType<typeof serve>;
  const base = await new Promise<string>(done => { server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 },
    info => done(`http://127.0.0.1:${info.port}`)); });
  try {
    const org = randomUUID(), foreignOrg = randomUUID(), owner = randomUUID(), operator = randomUUID(), other = randomUUID(), foreign = randomUUID();
    await db.insert(s.orgs).values([{ id: org, name: 'Email metadata test', slug: `email-meta-${org}` },
      { id: foreignOrg, name: 'Other tenant', slug: `email-meta-${foreignOrg}` }]);
    await db.insert(s.users).values([owner, operator, other, foreign].map(id => ({ id, name: 'Metadata human', email: `${id}@example.test` })));
    await db.insert(s.orgMembers).values([{ id: randomUUID(), org_id: org, user_id: owner, role: 'owner', is_active: true },
      { id: randomUUID(), org_id: org, user_id: operator, role: 'member', is_active: true },
      { id: randomUUID(), org_id: org, user_id: other, role: 'admin', is_active: true },
      { id: randomUUID(), org_id: foreignOrg, user_id: foreign, role: 'owner', is_active: true }]);
    const ownerSession = await web.createWebSession({ id: owner, org_id: org, email: `${owner}@example.test` });
    const operatorSession = await web.createWebSession({ id: operator, org_id: org, email: `${operator}@example.test` });
    const otherSession = await web.createWebSession({ id: other, org_id: org, email: `${other}@example.test` });
    const foreignSession = await web.createWebSession({ id: foreign, org_id: foreignOrg, email: `${foreign}@example.test` });
    const ownerSid = (await web.verifyWebAccess(ownerSession.accessToken)).sid;
    const request = async (path: string, method = 'GET', input?: unknown, token = ownerSession.accessToken) => {
      const r = await fetch(base + path, { method, signal: AbortSignal.timeout(10_000), headers: {
        authorization: `Bearer ${token}`, ...(input === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(input === undefined ? {} : { body: typeof input === 'string' ? input : JSON.stringify(input) }) });
      return { status: r.status, headers: r.headers, value: await r.json() as any };
    };
    const call = async (path: string, method = 'GET', input?: unknown, token?: string) => {
      const r = await request(path, method, input, token); assert.ok(r.status < 400, `${path}: HTTP ${r.status} ${r.value.code}`);
      assert.equal(r.headers.get('cache-control'), 'no-store'); return r.value;
    };
    const prefix = '/api/apps/blob/sync';
    // This is the exact formerly missing HTTP surface, before any App exists.
    assert.deepEqual((await call(prefix + '/bindings')).bindings, []);
    const { app: staged } = await call('/api/apps/blob/composition/stage', 'POST', readFileSync(resolve(root!, 'app.deft.json'), 'utf8'));
    const context = await call(`/api/apps/blob/composition/${staged.id}/context?app_version_id=${staged.version_id}`);
    const { review } = await call(`/api/apps/blob/composition/${staged.id}/review`, 'POST', context.review_request);
    await call(`/api/apps/blob/composition/${staged.id}/activate`, 'POST', { ...context.review_request,
      expected_review_digest: review.review_digest, accept_host_policy: true });
    const { setup } = await call(`${prefix}/setup?installation_id=${staged.id}&operator_user_id=${operator}`);
    const consent = setup.descriptors[0].consent_request;
    const { review: consentReview } = await call(prefix + '/reviews/prepare', 'POST', consent);
    const { binding } = await call(prefix + '/bindings/activate', 'POST', { ...consent,
      expected_review_digest: consentReview.review_digest, accept_host_policy: true });
    const bindingPath = `${prefix}/bindings/${binding.binding_id}`;
    await t.test('channel3 owner status and operator assignment pages expose bounded metadata only', async () => {
      process.env.DEFT_APP_V5_RUNTIME_ACTIONS_ENABLED = 'false';
      try {
        const list = await call(prefix + '/bindings?limit=1'); assert.equal(list.bindings.length, 1); assert.equal(list.next_after, null);
        const inspected = await call(bindingPath); assert.equal(inspected.binding.binding_id, binding.binding_id); assert.ok(inspected.checkpoint);
        const assigned = await call(prefix + '/operator/assignments?limit=1', 'GET', undefined, operatorSession.accessToken);
        assert.equal(assigned.schema_version, 'deft.app_resource_sync_assignments.v1'); assert.equal(assigned.assignments[0].binding_id, binding.binding_id);
        const choices = await call(prefix + '/operators?limit=1'); assert.equal(choices.operators.length, 1); assert.ok(choices.next_after);
        const next = await call(`${prefix}/operators?limit=1&after=${choices.next_after}`); assert.notEqual(next.operators[0].user_id, choices.operators[0].user_id);
        for (const response of [list, inspected, assigned]) {
          const encoded = JSON.stringify(response);
          for (const forbidden of ['session_token', 'token_hash', 'metadata_envelope', 'body', 'attachment_policy']) assert.ok(!encoded.includes(`"${forbidden}"`));
        }
      } finally { process.env.DEFT_APP_V5_RUNTIME_ACTIONS_ENABLED = 'true'; }
    });
    await t.test('channel3 session recovery is operator-only paginated and supports exact confirmation', async () => {
      const a = (await call(bindingPath + '/sessions', 'POST', {}, operatorSession.accessToken)).session;
      const b = (await call(bindingPath + '/sessions', 'POST', {}, operatorSession.accessToken)).session;
      await call(`${prefix}/sessions/${a.session_id}/revoke`, 'POST', {}, operatorSession.accessToken);
      const page = await call(bindingPath + '/sessions?limit=1', 'GET', undefined, operatorSession.accessToken);
      assert.equal(page.sessions.length, 1); assert.ok(page.next_after);
      const next = await call(`${bindingPath}/sessions?limit=1&after=${page.next_after}`, 'GET', undefined, operatorSession.accessToken);
      assert.equal(next.sessions.length, 1); assert.equal(next.next_after, null);
      const exact = await call(`${bindingPath}/sessions?session_id=${b.session_id}`, 'GET', undefined, operatorSession.accessToken);
      assert.equal(exact.sessions[0].session_id, b.session_id); assert.equal(exact.next_after, null); assert.equal(exact.sessions[0].revoked_at, null);
      assert.ok((await call(`${bindingPath}/sessions?session_id=${a.session_id}`, 'GET', undefined, operatorSession.accessToken)).sessions[0].revoked_at);
      assert.deepEqual((await call(`${bindingPath}/sessions?session_id=${randomUUID()}`, 'GET', undefined, operatorSession.accessToken)).sessions, []);
      assert.ok(!JSON.stringify(exact).includes(b.session_token));
    });
    await t.test('channel3 metadata denies foreign owner operator tenant and malformed or duplicate authority queries', async () => {
      for (const token of [otherSession.accessToken, foreignSession.accessToken, operatorSession.accessToken]) assert.ok((await request(bindingPath, 'GET', undefined, token)).status >= 400);
      for (const token of [ownerSession.accessToken, otherSession.accessToken, foreignSession.accessToken]) assert.ok((await request(bindingPath + '/sessions', 'GET', undefined, token)).status >= 400);
      assert.deepEqual((await call(prefix + '/operator/assignments', 'GET', undefined, otherSession.accessToken)).assignments, []);
      assert.deepEqual((await call('/api/app-resource-sync-management/operator/assignments', 'GET', undefined,
        operatorSession.accessToken)).assignments, [], 'Existing channel2 assignment path does not promote channel3');
      for (const suffix of ['?limit=0', '?limit=51', '?limit=1&limit=2', '?unknown=1']) assert.equal((await request(prefix + '/bindings' + suffix)).status, 400);
      for (const suffix of ['?session_id=bad', `?session_id=${randomUUID()}&limit=1`, '?limit=1&limit=1']) assert.equal((await request(bindingPath + '/sessions' + suffix, 'GET', undefined, operatorSession.accessToken)).status, 400);
    });
    await t.test('revoked channel3 consent remains observable by its current manager owner without operator authority', async () => {
      await call(bindingPath + '/revoke', 'POST', {});
      assert.equal((await call(bindingPath)).binding.state, 'revoked');
      assert.equal((await call(prefix + '/bindings')).bindings[0].state, 'revoked');
      assert.deepEqual((await call(prefix + '/operator/assignments', 'GET', undefined, operatorSession.accessToken)).assignments, []);
      assert.ok((await request(bindingPath + '/sessions', 'GET', undefined, operatorSession.accessToken)).status >= 400);
    });
    await t.test('actual final SID waits deny channel3 metadata after broker withdrawal and stored session expiry', async () => {
      for (const mode of ['gate', 'expiry'] as const) {
        const held = new pg.Client({ connectionString: target }); await held.connect();
        try {
          await held.query('BEGIN'); await held.query('SELECT id FROM web_sessions WHERE id=$1 FOR UPDATE', [ownerSid]);
          const pending = request(prefix + '/bindings'); const pid = (await held.query('SELECT pg_backend_pid() AS id')).rows[0].id;
          let observed = false; const until = performance.now() + 5000;
          while (performance.now() < until) {
            if ((await held.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [pid])).rows[0].n > 0) { observed = true; break; }
            await new Promise(done => setTimeout(done, 20));
          }
          assert.ok(observed, `Actual ${mode} SID lock wait`);
          if (mode === 'gate') process.env.DEFT_APP_ATTACHMENT_BROKER_ENABLED = 'false';
          else await held.query("UPDATE web_sessions SET expires_at=timezone('UTC',now())-interval '1 second' WHERE id=$1", [ownerSid]);
          await held.query('COMMIT'); const denied = await pending; assert.ok(denied.status >= 400); assert.ok(!JSON.stringify(denied.value).includes(binding.binding_id));
        } finally { process.env.DEFT_APP_ATTACHMENT_BROKER_ENABLED = 'true'; await held.query('ROLLBACK').catch(() => {}); await held.end(); }
      }
    });
  } finally {
    await new Promise<void>(done => server.close(() => done())); await attachments.shutdownAppAttachmentRuntime();
    await runs.shutdownAppRunRuntime(); await closeDb();
  }
});
