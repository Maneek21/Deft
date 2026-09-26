import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { createReviewedResourceSyncFixture } from './fixtures/resource-sync-v5.js';
import type { ServerType } from '@hono/node-server';

const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = target === process.env.DATABASE_URL && target !== undefined
  && new URL(target).hostname === '127.0.0.1' && new URL(target).port === '55435'
  && /^\/gate_g_20260926_c09_exposure_test(?:_v[0-9]+)?$/.test(new URL(target).pathname);
Object.assign(process.env, { DEFT_APPS_ENABLED: 'true', DEFT_APP_RUNS_ENABLED: 'true',
  DEFT_APP_RUN_APP_ORIGIN_ENABLED: 'true', DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED: 'true',
  DEFT_APP_RUNTIME_CHANNEL_ENABLED: 'false', DEFT_APP_EXPERIENCE_RESOURCE_EXPOSURE_ENABLED: 'true' });
const ring = (purpose: string) => ({ current: purpose, keys: { [purpose]: createHash('sha256').update(`c09-exposure:${purpose}`).digest('base64') } });
process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({ schema_version: 'deft.app_run_keyring.v1',
  run_encryption: ring('c09-enc'), receipt_signing: ring('c09-sign'), fingerprint: ring('c09-fp') });
after(async () => {
  await (await import('../src/lib/app-run-runtime.js')).shutdownAppRunRuntime();
  await (await import('../src/lib/db.js')).closeDb();
});

test('explicit immutable Experience exposure over HTTP is separate from sync authority', { skip: !safe }, async t => {
  const [{ db }, s, { eq, and, sql }, kit, runtimeModule, routes, web, { Hono }, { serve }] = await Promise.all([
    import('../src/lib/db.js'), import('@deft/db/schema'), import('drizzle-orm'), import('@deft/app-kit'),
    import('../src/lib/app-run-runtime.js'), import('../src/routes/app-experiences.js'), import('../src/lib/web-sessions.js'),
    import('hono'), import('@hono/node-server'),
  ]);
  const runtime = await runtimeModule.getAppRunRuntime();
  const artifact = await kit.prepareDeftExperienceArtifact('experiences/main.json', {
    schema_version: 'deft.experience_bundle.v1', worker_source: 'self.onmessage=()=>{};', entry_view: 'main', resource_keys: ['inbox'], action_keys: [],
  });
  const owned = await createReviewedResourceSyncFixture({ keys: runtime.keys, clock: () => new Date(), experience_artifact: artifact,
    descriptor: { schema_version: 'deft.app_sync_descriptor.v1', key: 'inbox', runtime_requirement_key: 'provider',
      resource_type: 'email_message', requested_visibility: 'user_private', label_field: 'subject', record_schema: {
        type: 'object', properties: { subject: { type: 'string', maxLength: 200 }, body: { type: 'string', maxLength: 10000 },
          read: { type: 'boolean' }, count: { type: 'number', minimum: 0, maximum: 100 } }, required: ['subject'], additionalProperties: false } } });
  const [owner] = await db.select().from(s.users).where(eq(s.users.id, owned.owner_user_id));
  const human = await web.createWebSession({ id: owned.owner_user_id, email: owner!.email, org_id: owned.org_id });
  const next = await web.createWebSession({ id: owned.owner_user_id, email: owner!.email, org_id: owned.org_id });
  const admitted = await runtime.resourceSyncAdmission.admitDue({ org_id: owned.org_id, resource_binding_id: owned.binding_id });
  assert.equal(admitted.state, 'created');
  const credential = await owned.management.issueOperatorSession(owned.operator_actor, owned.binding_id);
  const identity = { schema_version: 'deft.app_runtime_channel.v2' as const, audience: 'app_resource_sync' as const,
    session_id: credential.session_id, session_token: credential.session_token };
  const claim = await runtime.resourceSyncChannel.claim({ ...identity, max_claims: 1 }); assert.ok(claim);
  const attempt = { ...identity, run_id: claim.run_id, attempt_id: claim.attempt_id, claim_token: claim.claim_token, sequence: claim.sequence };
  assert.ok(await runtime.resourceSyncChannel.start(attempt));
  assert.ok(await runtime.resourceSyncChannel.complete({ ...attempt, status: 'returned', provider_succeeded: true, page: {
    schema_version: 'deft.app_sync_page.v1', upserts: Array.from({ length: 12 }, (_, i) => ({ id: `provider-only-${i}`, revision: 'provider-private-revision',
      data: { subject: i === 0 ? '<script>hostile text</script>' : `Saved record ${i}`, body: i === 1 ? 'x'.repeat(4097) : 'x'.repeat(4096), read: true, count: i } })),
    tombstones: [], next_cursor: 'provider-private-cursor', has_more: false } }));
  const app = new Hono(); app.route('/api/app-experiences', routes.appExperienceRoutes);
  let server!: ServerType;
  const base = await new Promise<string>(resolve => { server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, info => resolve(`http://127.0.0.1:${info.port}/api/app-experiences`)); });
  const call = async (path: string, method = 'GET', body?: unknown, token = human.accessToken) => {
    const response = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return { status: response.status, body: await response.json() as any };
  };
  try {
    const created = await call(`/${owned.installation_id}/main/sessions`, 'POST'); assert.equal(created.status, 200);
    const id = created.body.pin.session_id; const path = `/sessions/${id}`;
    const list = { schema_version: 'deft.experience_resource_request.v1', operation: 'list_summary' };
    await t.test('default-off and sync consent alone disclose no data', async () => {
      assert.equal((await call(`${path}/resources/inbox`, 'POST', list)).status, 404);
      process.env.DEFT_APP_EXPERIENCE_RESOURCE_EXPOSURE_ENABLED = 'false';
      assert.equal((await call(`${path}/resources/inbox`, 'POST', list)).status, 503);
      assert.equal((await call(`/${owned.installation_id}/main/sessions`, 'POST')).status, 409);
      process.env.DEFT_APP_EXPERIENCE_RESOURCE_EXPOSURE_ENABLED = 'true';
    });
    const review = await call(`${path}/exposure/review`, 'POST', {}); assert.equal(review.status, 200);
    const accept = { review_token: review.body.review_token, review_digest: review.body.review_digest, accept_exposure: true };
    await t.test('readonly exact review, explicit acceptance and safe idempotency', async () => {
      assert.equal((await db.select().from(s.appExperienceResourceExposures).where(eq(s.appExperienceResourceExposures.org_id, owned.org_id))).length, 0);
      assert.equal(review.body.snapshot.destination, 'verified_installed_experience_worker');
      assert.deepEqual(review.body.snapshot.resources[0].allowed_fields, ['body', 'count', 'read', 'subject']);
      assert.deepEqual(review.body.snapshot.resources[0].allowed_operations, ['list_summary', 'read_one']);
      assert.equal((await call(`${path}/exposure/accept`, 'POST', { ...accept, accept_exposure: false })).status, 400);
      assert.equal((await call(`${path}/exposure/accept`, 'POST', { ...accept, review_digest: `sha256:${'0'.repeat(64)}` })).status, 409);
      const accepted = await call(`${path}/exposure/accept`, 'POST', accept); assert.equal(accepted.status, 200);
      assert.equal(accepted.body.active, true);
      const repeated = await call(`${path}/exposure/accept`, 'POST', accept); assert.equal(repeated.status, 200);
      assert.deepEqual(repeated.body, accepted.body);
      assert.equal((await db.select().from(s.appExperienceResourceExposures).where(eq(s.appExperienceResourceExposures.org_id, owned.org_id))).length, 1);
      assert.equal((await call(`${path}/exposure/review`, 'POST', {})).status, 409);
    });
    let first: any;
    await t.test('bounded list and detail expose only approved fields with opaque cursor', async () => {
      first = await call(`${path}/resources/inbox`, 'POST', list); assert.equal(first.status, 200);
      assert.equal(first.body.output.items.length, 10);
      assert.ok(first.body.output.next_cursor);
      const decoded = JSON.stringify(JSON.parse(Buffer.from(first.body.output.next_cursor.split('.')[0], 'base64url').toString('utf8')));
      for (const forbidden of [owned.org_id, owned.owner_user_id, owned.binding_id, owned.registration_id, owned.checkpoint_id,
        id, 'provider-private', 'web_session_id', 'binding_id', 'checkpoint_id']) assert.equal(decoded.includes(forbidden), false);
      const second = await call(`${path}/resources/inbox`, 'POST', { ...list, cursor: first.body.output.next_cursor });
      assert.equal(second.status, 200); assert.equal(second.body.output.items.length, 2); assert.equal(second.body.output.next_cursor, null);
      const projections = await db.select().from(s.appResourceProjections).where(eq(s.appResourceProjections.resource_binding_id, owned.binding_id));
      let oversized = 0; let delivered = 0;
      for (const projection of projections) {
        const detail = await call(`${path}/resources/inbox`, 'POST', { schema_version: list.schema_version, operation: 'read_one', record_id: projection.id });
        if (detail.status === 413) { oversized++; assert.equal(detail.body.code, 'RESOURCE_PAYLOAD_TOO_LARGE'); assert.equal(detail.body.output, undefined); }
        else {
          assert.equal(detail.status, 200); delivered++;
          assert.equal(detail.body.output.item.data.body.length, 4096);
          assert.deepEqual(Object.keys(detail.body.output.item).sort(), ['data', 'freshness', 'label', 'record_id']);
          assert.equal(JSON.stringify(detail.body.output).includes('provider-private'), false);
        }
      }
      assert.equal(oversized, 1); assert.equal(delivered, 11);
    });
    await t.test('foreign SID, key, locator, input and cursor cannot nominate disclosure', async () => {
      assert.equal((await call(`${path}/resources/inbox`, 'POST', list, next.accessToken)).status, 404);
      assert.equal((await call(`${path}/resources/other`, 'POST', list)).status, 404);
      assert.equal((await call(`${path}/resources/inbox`, 'POST', { ...list, binding_id: owned.binding_id })).status, 400);
      assert.equal((await call(`${path}/resources/inbox`, 'POST', { ...list, schema_version: 'old' })).status, 400);
      assert.equal((await call(`${path}/resources/inbox?limit=1&limit=2`, 'POST', list)).status, 400);
      assert.equal((await call(`${path}/exposure/accept?x=1`, 'POST', accept)).status, 400);
      assert.equal((await call(`${path}/resources/inbox`, 'POST', { ...list, cursor: `${first.body.output.next_cursor}x` })).status, 404);
      assert.equal((await call(`${path}/resources/inbox`, 'POST', { schema_version: list.schema_version, operation: 'read_one', record_id: randomUUID() })).status, 404);
      assert.equal((await call(`${path}/resources/inbox`, 'POST', list, human.refreshToken)).status, 403);
    });
    await t.test('gate withdrawal during final SID lock wait prevents delivery', async () => {
      const { default: pg } = await import('pg');
      const blocker = new pg.Client({ connectionString: target });
      await blocker.connect();
      const sid = JSON.parse(Buffer.from(human.accessToken.split('.')[1]!, 'base64url').toString()).sid;
      try {
        await blocker.query('BEGIN');
        const { rows: [pid] } = await blocker.query('SELECT pg_backend_pid() AS id');
        await blocker.query('SELECT id FROM web_sessions WHERE id=$1 FOR UPDATE', [sid]);
        const reading = call(`${path}/resources/inbox`, 'POST', list);
        let waiting = false;
        for (let i = 0; i < 30; i++) {
          const observed = await blocker.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND $2=ANY(pg_blocking_pids(pid))) AS waiting', ['deft-experience-exposure', pid.id]);
          if (observed.rows[0].waiting) { waiting = true; break; }
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        assert.equal(waiting, true, 'real read must reach held final SID');
        process.env.DEFT_APP_EXPERIENCE_RESOURCE_EXPOSURE_ENABLED = 'false';
        await blocker.query('COMMIT');
        const denied = await reading;
        assert.equal(denied.status, 503); assert.equal(denied.body.output, undefined);
      } finally {
        process.env.DEFT_APP_EXPERIENCE_RESOURCE_EXPOSURE_ENABLED = 'true';
        await blocker.query('ROLLBACK'); await blocker.end();
      }
    });
    await t.test('caller expiry and abort after queued SID locks deny before decrypt', async () => {
      const [{ default: pg }, { AppExperienceExposureService }] = await Promise.all([
        import('pg'), import('../src/lib/app-experience-exposure.js')]);
      const sid = JSON.parse(Buffer.from(human.accessToken.split('.')[1]!, 'base64url').toString()).sid;
      for (const mode of ['expiry', 'abort'] as const) {
        const blocker = new pg.Client({ connectionString: target }); await blocker.connect();
        let now = new Date();
        const expiry = now.getTime() + 10_000;
        const service = new AppExperienceExposureService(runtime.keys, undefined, () => now);
        const abort = new AbortController();
        try {
          await blocker.query('BEGIN');
          const { rows: [pid] } = await blocker.query('SELECT pg_backend_pid() AS id');
          await blocker.query('SELECT id FROM web_sessions WHERE id=$1 FOR UPDATE', [sid]);
          const reading = service.read({ org_id: owned.org_id, user_id: owned.owner_user_id, sid,
            access_expires_at: expiry }, id, 'inbox', list, abort.signal);
          // Observe rejection immediately so cancellation never becomes an
          // unhandled promise while the server settles its bounded statement.
          const denied = assert.rejects(reading);
          let waiting = false;
          for (let i = 0; i < 30; i++) {
            const observed = await blocker.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND $2=ANY(pg_blocking_pids(pid))) AS waiting', ['deft-experience-exposure', pid.id]);
            if (observed.rows[0].waiting) { waiting = true; break; }
            await new Promise(resolve => setTimeout(resolve, 5));
          }
          assert.equal(waiting, true);
          if (mode === 'expiry') now = new Date(expiry + 1); else abort.abort();
          await blocker.query('COMMIT'); await denied;
          assert.equal((await call(`${path}/resources/inbox`, 'POST', list)).status, 200,
            'slot must settle and remain usable after denial');
        } finally { await blocker.query('ROLLBACK'); await blocker.end(); }
      }
    });
    await t.test('immutable snapshots, missing child and checkpoint changes fail closed', async () => {
      const [exposure] = await db.select().from(s.appExperienceResourceExposures).where(eq(s.appExperienceResourceExposures.experience_session_id, id));
      assert.ok(exposure);
      await assert.rejects(db.update(s.appExperienceResourceExposures).set({ review_digest: `sha256:${'1'.repeat(64)}` }).where(eq(s.appExperienceResourceExposures.id, exposure.id)));
      await assert.rejects(db.update(s.appExperienceResourceExposureResources).set({ allowed_fields: ['anything'] }).where(eq(s.appExperienceResourceExposureResources.exposure_id, exposure.id)));
      let nextAdmission = await runtime.resourceSyncAdmission.admitDue({ org_id: owned.org_id, resource_binding_id: owned.binding_id });
      if (nextAdmission.state === 'not_due') {
        await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(nextAdmission.due_at) - Date.now()) + 25));
        nextAdmission = await runtime.resourceSyncAdmission.admitDue({ org_id: owned.org_id, resource_binding_id: owned.binding_id });
      }
      assert.equal(nextAdmission.state, 'created');
      const nextClaim = await runtime.resourceSyncChannel.claim({ ...identity, max_claims: 1 }); assert.ok(nextClaim);
      const nextAttempt = { ...identity, run_id: nextClaim.run_id, attempt_id: nextClaim.attempt_id,
        claim_token: nextClaim.claim_token, sequence: nextClaim.sequence };
      assert.ok(await runtime.resourceSyncChannel.start(nextAttempt));
      assert.ok(await runtime.resourceSyncChannel.complete({ ...nextAttempt, status: 'returned', provider_succeeded: true,
        page: { schema_version: 'deft.app_sync_page.v1', upserts: [], tombstones: [],
          next_cursor: 'provider-private-next-cursor', has_more: false } }));
      const stale = await call(`${path}/resources/inbox`, 'POST', { ...list, cursor: first.body.output.next_cursor });
      assert.equal(stale.status, 409); assert.equal(stale.body.code, 'RESOURCE_CURSOR_STALE'); assert.equal(stale.body.output, undefined);
      await db.delete(s.appExperienceResourceExposureResources).where(eq(s.appExperienceResourceExposureResources.exposure_id, exposure.id));
      assert.equal((await call(`${path}/resources/inbox`, 'POST', list)).status, 404);
    });
    await t.test('explicit withdrawal retires session; pruning preserves safe audit', async () => {
      const revoked = await call(`${path}/exposure`, 'DELETE'); assert.equal(revoked.status, 200);
      assert.equal((await call(`${path}/resources/inbox`, 'POST', list)).status, 404);
      assert.equal((await call(`${path}/exposure/accept`, 'POST', accept)).status, 404);
      const reopened = await call(`/${owned.installation_id}/main/sessions`, 'POST'); assert.equal(reopened.status, 200);
      assert.notEqual(reopened.body.pin.session_id, id);
      assert.equal((await call(`/sessions/${reopened.body.pin.session_id}/resources/inbox`, 'POST', list)).status, 404);
      const audit = await db.select().from(s.appExperienceResourceExposureAudit).where(eq(s.appExperienceResourceExposureAudit.org_id, owned.org_id));
      assert.deepEqual(audit.map(a => a.event).sort(), ['accepted', 'revoked']);
      assert.equal(JSON.stringify(audit).includes('provider-private'), false);
      assert.equal((await db.select().from(s.appExperienceResourceExposures).where(eq(s.appExperienceResourceExposures.experience_session_id, id))).length, 0);
    });
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
