import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { createReviewedResourceSyncFixture } from './fixtures/resource-sync-v5.js';

const target = 'postgresql://gate_g_test@127.0.0.1:55435/gate_g_20260926_c09_operator_test';
const safe = process.env.DATABASE_URL === target && process.env.DEFT_TEST_DATABASE_URL === target;
Object.assign(process.env, { DEFT_APPS_ENABLED: 'true', DEFT_APP_RUNS_ENABLED: 'true',
  DEFT_APP_RUN_APP_ORIGIN_ENABLED: 'true', DEFT_APP_RUNTIME_CHANNEL_ENABLED: 'false',
  DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED: 'true' });
const ring = (purpose: string) => ({ current: purpose,
  keys: { [purpose]: createHash('sha256').update(`c09-operator:${purpose}`).digest('base64') } });
const keyring = JSON.stringify({ schema_version: 'deft.app_run_keyring.v1', run_encryption: ring('enc'),
  receipt_signing: ring('sig'), fingerprint: ring('fp') });
process.env.DEFT_APP_RUN_KEYRINGS = keyring;
after(async () => { if (safe) { await (await import('../src/lib/app-run-runtime.js')).shutdownAppRunRuntime();
  await (await import('../src/lib/db.js')).closeDb(); } });

async function harness() {
  const [{ db }, s, d, sessions, keyModule, routes, privateRead, { Hono }, { serve }] = await Promise.all([
    import('../src/lib/db.js'), import('@deft/db/schema'), import('drizzle-orm'),
    import('../src/lib/web-sessions.js'), import('../src/lib/app-run-keyrings.js'),
    import('../src/routes/app-resource-sync-management.js'), import('../src/routes/app-resource-private-read.js'),
    import('hono'), import('@hono/node-server'),
  ]);
  const keys = keyModule.parseEnvironmentAppRunKeyrings(keyring);
  const f = await createReviewedResourceSyncFixture({ keys, clock: () => new Date() });
  const app = new Hono();
  app.route('/manage', routes.createAppResourceSyncManagementRoutes({ management: async () => f.management }));
  app.route('/private', privateRead.appResourcePrivateReadRoutes);
  let server!: ReturnType<typeof serve>;
  const base = await new Promise<string>(resolve => { server = serve({ fetch: app.fetch,
    hostname: '127.0.0.1', port: 0 }, info => resolve(`http://127.0.0.1:${info.port}`)); });
  const token = async (id: string, orgId = f.org_id) => {
    const [user] = await db.select().from(s.users).where(d.eq(s.users.id, id));
    return sessions.createWebSession({ id, org_id: orgId, email: user!.email });
  };
  const owner = await token(f.owner_user_id); const operator = await token(f.operator_user_id);
  const call = async (path: string, method = 'GET', value?: unknown, auth = owner.accessToken) => {
    const result = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${auth}`,
      ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    assert.equal(result.headers.get('cache-control'), 'no-store');
    return { status: result.status, body: await result.json() as any };
  };
  return { ...f, db, s, ...d, sessions, keys, token, owner, operator, call,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); keys.destroy(); } };
}

test('eligible discovery is bounded current human-only and setup preserves v1 while v2 pins selected operator', { skip: !safe }, async () => {
  const h = await harness();
  try {
    const hidden = [{ id: randomUUID(), kind: 'agent' as const, active: true, role: 'member' as const },
      { id: randomUUID(), kind: 'human' as const, active: false, role: 'member' as const },
      { id: randomUUID(), kind: 'human' as const, active: true, role: 'guest' as const }];
    for (const row of hidden) {
      await h.db.insert(h.s.users).values({ id: row.id, name: 'Excluded', email: `${row.id}@example.test`, kind: row.kind });
      await h.db.insert(h.s.orgMembers).values({ org_id: h.org_id, user_id: row.id, role: row.role, is_active: row.active });
    }
    const first = await h.call('/manage/operators?limit=1');
    assert.equal(first.status, 200); assert.equal(first.body.operators.length, 1); assert.ok(first.body.next_after);
    const second = await h.call(`/manage/operators?limit=1&after=${first.body.next_after}`);
    assert.equal(second.body.next_after, null);
    assert.deepEqual([...first.body.operators, ...second.body.operators].map(x => x.user_id).sort(),
      [h.owner_user_id, h.operator_user_id].sort());
    for (const row of first.body.operators) assert.deepEqual(Object.keys(row).sort(), ['name', 'user_id']);
    assert.equal((await h.call('/manage/operators', 'GET', undefined, h.operator.accessToken)).status, 403);
    const path = `/manage/setup?installation_id=${h.installation_id}`;
    const legacy = (await h.call(path)).body.setup;
    assert.equal(legacy.schema_version, 'deft.app_resource_sync_setup.v1');
    assert.equal(legacy.operator_user_id, h.owner_user_id);
    assert.ok(!Object.hasOwn(legacy.descriptors[0].existing_binding, 'operator_user_id'));
    const nominated = (await h.call(`${path}&operator_user_id=${h.operator_user_id}`)).body.setup;
    assert.equal(nominated.schema_version, 'deft.app_resource_sync_setup.v2');
    assert.equal(nominated.operator_user_id, h.operator_user_id);
    assert.equal(nominated.descriptors[0].consent_request.operator_user_id, h.operator_user_id);
    assert.equal(nominated.descriptors[0].existing_binding.operator_user_id, h.operator_user_id);
    for (const row of hidden) assert.equal((await h.call(`${path}&operator_user_id=${row.id}`)).status, 403);
    for (const query of ['?limit=0', '?limit=51', '?limit=1&limit=2', '?after=bad', '?org_id=other'])
      assert.equal((await h.call(`/manage/operators${query}`)).status, 400);
  } finally { await h.close(); }
});

test('separate operator discovers own assignment and lost issuance metadata then revokes without owner read authority', { skip: !safe }, async () => {
  const h = await harness();
  try {
    assert.equal((await h.call(`/manage/bindings/${h.binding_id}/revoke`, 'POST')).status, 200);
    const context = await h.call(`/manage/setup?installation_id=${h.installation_id}&operator_user_id=${h.operator_user_id}`);
    const input = context.body.setup.descriptors[0].consent_request;
    const review = await h.call('/manage/reviews/prepare', 'POST', input);
    assert.equal(review.status, 200);
    const activated = await h.call('/manage/bindings/activate', 'POST', { ...input,
      expected_review_digest: review.body.review.review_digest, accept_host_policy: true });
    assert.equal(activated.status, 201);
    const binding = activated.body.binding.binding_id;
    assert.deepEqual((await h.call('/manage/operator/assignments')).body.assignments, []);
    const assignment = await h.call('/manage/operator/assignments', 'GET', undefined, h.operator.accessToken);
    assert.equal(assignment.status, 200); assert.equal(assignment.body.assignments[0].binding_id, binding);
    assert.equal(assignment.body.assignments[0].owner_user_id, h.owner_user_id);
    assert.equal((await h.call(`/manage/bindings/${binding}/sessions`, 'POST')).status, 403);
    const issued = await h.call(`/manage/bindings/${binding}/sessions`, 'POST', undefined, h.operator.accessToken);
    assert.equal(issued.status, 201);
    // The response may be lost: recovery uses only the independent GET projection.
    const recovered = await h.call(`/manage/bindings/${binding}/sessions`, 'GET', undefined, h.operator.accessToken);
    assert.equal(recovered.status, 200); assert.equal(recovered.body.sessions[0].session_id, issued.body.session.session_id);
    const exactPath = `/manage/bindings/${binding}/sessions?session_id=${issued.body.session.session_id}`;
    const exact = await h.call(exactPath, 'GET', undefined, h.operator.accessToken);
    assert.equal(exact.status, 200); assert.equal(exact.body.sessions.length, 1); assert.equal(exact.body.next_after, null);
    for (const suffix of ['&limit=1', `&after=${randomUUID()}`, `&session_id=${randomUUID()}`])
      assert.equal((await h.call(exactPath + suffix, 'GET', undefined, h.operator.accessToken)).status, 400);
    assert.equal((await h.call(`/manage/bindings/${binding}/sessions?session_id=bad`, 'GET', undefined, h.operator.accessToken)).status, 400);
    assert.deepEqual((await h.call(`/manage/bindings/${binding}/sessions?session_id=${randomUUID()}`, 'GET', undefined, h.operator.accessToken)).body.sessions, []);
    assert.equal((await h.call(exactPath)).status, 403);
    for (const secret of ['session_token', 'token_hash', 'reviewed_descriptor', 'provider_snapshot_id'])
      assert.ok(!JSON.stringify([assignment.body, recovered.body]).includes(secret));
    assert.equal((await h.call(`/manage/bindings/${binding}/sessions`)).status, 403);
    assert.equal((await h.call(`/private/bindings/${binding}/records`, 'GET', undefined, h.operator.accessToken)).status, 404);
    assert.equal((await h.call(`/private/bindings/${binding}/records`)).status, 200);
    assert.equal((await h.call(`/manage/sessions/${issued.body.session.session_id}/revoke`, 'POST')).status, 403);
    assert.equal((await h.call(`/manage/sessions/${issued.body.session.session_id}/revoke`, 'POST', undefined, h.operator.accessToken)).status, 200);
    assert.ok((await h.call(`/manage/bindings/${binding}/sessions`, 'GET', undefined, h.operator.accessToken)).body.sessions[0].revoked_at);
    assert.equal((await h.call(`/manage/bindings/${binding}/revoke`, 'POST')).status, 200);
    assert.deepEqual((await h.call('/manage/operator/assignments', 'GET', undefined, h.operator.accessToken)).body.assignments, []);
    assert.equal((await h.call(`/manage/bindings/${binding}/sessions`, 'POST', undefined, h.operator.accessToken)).status, 403);
    const replacement = (await h.call(`/manage/setup?installation_id=${h.installation_id}&operator_user_id=${h.owner_user_id}`)).body.setup.descriptors[0].consent_request;
    const next = await h.call('/manage/reviews/prepare', 'POST', replacement);
    const changed = await h.call('/manage/bindings/activate', 'POST', { ...replacement,
      expected_review_digest: next.body.review.review_digest, accept_host_policy: true });
    assert.equal(changed.status, 201); assert.notEqual(changed.body.binding.binding_id, binding);
    assert.deepEqual((await h.call('/manage/operator/assignments', 'GET', undefined, h.operator.accessToken)).body.assignments, []);
    assert.equal((await h.call(`/manage/bindings/${changed.body.binding.binding_id}/sessions`, 'POST', undefined, h.operator.accessToken)).status, 403);
  } finally { await h.close(); }
});

async function sidWait(h: Awaited<ReturnType<typeof harness>>) {
  for (let i = 0; i < 200; i++) {
    const result = await h.db.execute(h.sql`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
      AND wait_event_type='Lock' AND query ILIKE '%web_sessions%' AND query ILIKE '%for share%'`);
    if (result.rows.length) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('final SID wait did not occur');
}

test('new operator surfaces reject foreign/purpose/query injection and eligibility loss invalidates consent', { skip: !safe }, async () => {
  const h = await harness();
  try {
    const foreignOrg = randomUUID();
    await h.db.insert(h.s.orgs).values({ id: foreignOrg, name: 'Foreign', slug: foreignOrg });
    await h.db.insert(h.s.orgMembers).values({ org_id: foreignOrg, user_id: h.operator_user_id, role: 'owner', is_active: true });
    const foreign = await h.token(h.operator_user_id, foreignOrg);
    assert.deepEqual((await h.call('/manage/operator/assignments', 'GET', undefined, foreign.accessToken)).body.assignments, []);
    assert.equal((await h.call(`/manage/bindings/${h.binding_id}/sessions`, 'GET', undefined, foreign.accessToken)).status, 403);
    const jwt = (await import('jsonwebtoken')).default; const { env } = await import('../src/lib/env.js');
    const caller = await h.sessions.verifyWebAccess(h.operator.accessToken);
    const wrong = jwt.sign({ id: caller.id, org_id: caller.org_id, email: caller.email,
      sid: caller.sid, jti: randomUUID(), purpose: 'employee' }, env.JWT_SECRET, { expiresIn: 60 });
    for (const path of ['/manage/operators', '/manage/operator/assignments', `/manage/bindings/${h.binding_id}/sessions`]) {
      for (const auth of [wrong, h.operator.refreshToken]) assert.equal((await h.call(path, 'GET', undefined, auth)).status, 401);
      for (const query of ['?limit=51', '?limit=1&limit=1', '?owner_user_id=other', '?after=bad'])
        assert.equal((await h.call(path + query, 'GET', undefined, path === '/manage/operators' ? h.owner.accessToken : h.operator.accessToken)).status, 400);
    }
    const input = (await h.call(`/manage/setup?installation_id=${h.installation_id}&operator_user_id=${h.operator_user_id}`)).body.setup.descriptors[0].consent_request;
    const review = await h.call('/manage/reviews/prepare', 'POST', input);
    assert.equal(review.status, 200);
    await h.call(`/manage/bindings/${h.binding_id}/revoke`, 'POST');
    await h.db.update(h.s.orgMembers).set({ role: 'guest' }).where(h.and(h.eq(h.s.orgMembers.org_id, h.org_id), h.eq(h.s.orgMembers.user_id, h.operator_user_id)));
    assert.equal((await h.call('/manage/reviews/prepare', 'POST', input)).status, 403);
    assert.equal((await h.call('/manage/bindings/activate', 'POST', { ...input,
      expected_review_digest: review.body.review.review_digest, accept_host_policy: true })).status, 403);
    assert.equal((await h.call('/manage/operator/assignments', 'GET', undefined, h.operator.accessToken)).status, 403);
    process.env.DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED = 'false';
    for (const path of ['/manage/operators', '/manage/operator/assignments', `/manage/bindings/${h.binding_id}/sessions`])
      assert.equal((await h.call(path)).status, 503);
  } finally { process.env.DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED = 'true'; await h.close(); }
});

test('assignment and session pages stay bounded across Apps and exact filters never cross bindings', { skip: !safe }, async () => {
  const h = await harness();
  try {
    const [version] = await h.db.select().from(h.s.appVersions).where(h.eq(h.s.appVersions.id, h.app_version_id));
    const kit = await import('@deft/app-kit'); const apps = await import('../src/lib/app-service.js');
    const appReview = await import('../src/lib/app-runtime-review.js');
    const manifest = { ...(version!.manifest as any), id: `community.example.second.a${randomUUID().replaceAll('-', '')}` };
    const pkg = await kit.buildDeftAppPackage({ manifest, artifacts: [] });
    const staged = await apps.stageAppPackage(h.owner_actor, pkg.json);
    const appInput = (await appReview.getRuntimeAppReviewContext(h.owner_actor, staged.id, staged.version_id)).review_request!;
    const appPrepared = await appReview.prepareRuntimeAppReview(h.owner_actor, staged.id, appInput);
    await appReview.activateRuntimeApp(h.owner_actor, staged.id, { ...appInput,
      expected_review_digest: appPrepared.review_digest, accept_host_policy: true });
    const input = (await h.call(`/manage/setup?installation_id=${staged.id}&operator_user_id=${h.operator_user_id}`)).body.setup.descriptors[0].consent_request;
    const review = await h.call('/manage/reviews/prepare', 'POST', input);
    const activated = await h.call('/manage/bindings/activate', 'POST', { ...input,
      expected_review_digest: review.body.review.review_digest, accept_host_policy: true });
    assert.equal(activated.status, 201);
    const secondBinding = activated.body.binding.binding_id;
    const first = await h.call('/manage/operator/assignments?limit=1', 'GET', undefined, h.operator.accessToken);
    assert.equal(first.body.assignments.length, 1); assert.ok(first.body.next_after);
    const second = await h.call(`/manage/operator/assignments?limit=1&after=${first.body.next_after}`, 'GET', undefined, h.operator.accessToken);
    assert.equal(second.body.assignments.length, 1); assert.equal(second.body.next_after, null);
    assert.deepEqual([...first.body.assignments, ...second.body.assignments].map(x => x.binding_id).sort(), [h.binding_id, secondBinding].sort());
    assert.equal((await h.call('/manage/operator/assignments?limit=20', 'GET', undefined, h.operator.accessToken)).body.assignments.length, 2);
    const issued = [];
    for (let i = 0; i < 2; i++) issued.push((await h.call(`/manage/bindings/${h.binding_id}/sessions`, 'POST', undefined, h.operator.accessToken)).body.session);
    const sessionPage = await h.call(`/manage/bindings/${h.binding_id}/sessions?limit=1`, 'GET', undefined, h.operator.accessToken);
    assert.equal(sessionPage.body.sessions.length, 1); assert.ok(sessionPage.body.next_after);
    const last = await h.call(`/manage/bindings/${h.binding_id}/sessions?limit=1&after=${sessionPage.body.next_after}`, 'GET', undefined, h.operator.accessToken);
    assert.equal(last.body.next_after, null);
    assert.deepEqual([...sessionPage.body.sessions, ...last.body.sessions].map(x => x.session_id).sort(), issued.map(x => x.session_id).sort());
    const other = (await h.call(`/manage/bindings/${secondBinding}/sessions`, 'POST', undefined, h.operator.accessToken)).body.session;
    assert.deepEqual((await h.call(`/manage/bindings/${h.binding_id}/sessions?session_id=${other.session_id}`, 'GET', undefined, h.operator.accessToken)).body.sessions, []);
    const otherOperator = randomUUID();
    await h.db.insert(h.s.users).values({ id: otherOperator, name: 'Other operator', email: `${otherOperator}@example.test` });
    await h.db.insert(h.s.orgMembers).values({ org_id: h.org_id, user_id: otherOperator, role: 'member', is_active: true });
    const otherWeb = await h.token(otherOperator);
    assert.equal((await h.call(`/manage/bindings/${h.binding_id}/sessions?session_id=${issued[0].session_id}`, 'GET', undefined, otherWeb.accessToken)).status, 403);
  } finally { await h.close(); }
});

for (const operation of ['operators', 'assignments', 'sessions'] as const) {
  for (const race of ['revoke', 'expiry', 'flag'] as const) {
    test(`operator ${operation} denies ${race} after a real final SID wait`, { skip: !safe }, async () => {
      const h = await harness();
      let release!: () => void; let entered!: () => void;
      let pending: Promise<any> | undefined; let blocker: Promise<unknown> | undefined;
      const ready = new Promise<void>(resolve => { entered = resolve; });
      const released = new Promise<void>(resolve => { release = resolve; });
      try {
        const auth = operation === 'operators' ? h.owner.accessToken : h.operator.accessToken;
        const caller = await h.sessions.verifyWebAccess(auth);
        const expiresAt = new Date(Date.now() + 1500);
        if (race === 'expiry') await h.db.update(h.s.webSessions).set({ expires_at: expiresAt }).where(h.eq(h.s.webSessions.id, caller.sid));
        blocker = h.db.transaction(async tx => { await tx.execute(h.sql`SELECT id FROM web_sessions WHERE id=${caller.sid} FOR UPDATE`);
          entered(); await released;
          if (race === 'revoke') await tx.update(h.s.webSessions).set({ revoked_at: new Date() }).where(h.eq(h.s.webSessions.id, caller.sid)); });
        await ready;
        pending = h.call(operation === 'operators' ? '/manage/operators' : operation === 'assignments'
          ? '/manage/operator/assignments' : `/manage/bindings/${h.binding_id}/sessions`, 'GET', undefined, auth);
        await sidWait(h);
        if (race === 'flag') process.env.DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED = 'false';
        if (race === 'expiry') await new Promise(resolve => setTimeout(resolve, Math.max(0, expiresAt.getTime() - Date.now() + 20)));
        release(); await blocker;
        assert.equal((await pending).status, race === 'flag' ? 503 : 401);
      } finally { release?.(); await blocker; await pending; process.env.DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED = 'true'; await h.close(); }
    });
  }
}

for (const operation of ['setup', 'review', 'activate', 'assignments', 'sessions'] as const) {
  test(`operator ${operation} rejects participant kind change after actual final SID wait`, { skip: !safe }, async () => {
    const h = await harness();
    let release!: () => void; let entered!: () => void;
    let pending: Promise<any> | undefined;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    let blocker: Promise<unknown> | undefined;
    try {
      const path = `/manage/setup?installation_id=${h.installation_id}&operator_user_id=${h.operator_user_id}`;
      const input = (await h.call(path)).body.setup.descriptors[0].consent_request;
      const review = await h.call('/manage/reviews/prepare', 'POST', input);
      if (operation === 'activate') await h.call(`/manage/bindings/${h.binding_id}/revoke`, 'POST');
      const auth = operation === 'sessions' || operation === 'assignments' ? h.operator.accessToken : h.owner.accessToken;
      const caller = await h.sessions.verifyWebAccess(auth);
      blocker = h.db.transaction(async tx => { await tx.execute(h.sql`SELECT id FROM web_sessions WHERE id=${caller.sid} FOR UPDATE`);
        entered(); await released; });
      await ready;
      pending = operation === 'setup' ? h.call(path) : operation === 'review' ? h.call('/manage/reviews/prepare', 'POST', input)
        : operation === 'activate' ? h.call('/manage/bindings/activate', 'POST', { ...input, expected_review_digest: review.body.review.review_digest, accept_host_policy: true })
        : h.call(operation === 'assignments' ? '/manage/operator/assignments' : `/manage/bindings/${h.binding_id}/sessions`, 'GET', undefined, auth);
      await sidWait(h);
      // Change the other participant, so the caller's web guard alone is insufficient.
      const changed = operation === 'sessions' || operation === 'assignments' ? h.owner_user_id : h.operator_user_id;
      await h.db.update(h.s.users).set({ kind: 'agent' }).where(h.eq(h.s.users.id, changed));
      release(); await blocker;
      const result = await pending;
      if (operation === 'assignments') { assert.equal(result.status, 200); assert.deepEqual(result.body.assignments, []); }
      else assert.equal(result.status, 403, JSON.stringify(result.body));
      if (operation === 'activate') assert.equal((await h.db.select().from(h.s.appResourceBindings).where(h.and(
        h.eq(h.s.appResourceBindings.org_id, h.org_id), h.eq(h.s.appResourceBindings.state, 'active')))).length, 0);
    } finally { release?.(); await blocker; await pending; await h.close(); }
  });
}
