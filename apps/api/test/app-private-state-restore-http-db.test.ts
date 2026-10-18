import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

const target = 'postgresql://gate_g_test@127.0.0.1:55435/gate_g_20260927_email_flagship_restore53_test_v1';
const safe = process.env.DATABASE_URL === target && process.env.DEFT_TEST_DATABASE_URL === target;

test('restored encrypted state opens through fresh owner review and retains original expiry', { skip: !safe, timeout: 60000 }, async () => {
  Object.assign(process.env, { DEFT_APPS_ENABLED: 'true', DEFT_APP_RUNS_ENABLED: 'true', DEFT_APP_RUN_APP_ORIGIN_ENABLED: 'true',
    DEFT_APP_ATTACHMENT_BROKER_ENABLED: 'true', DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED: 'true', DEFT_APP_RUNTIME_CHANNEL_ENABLED: 'true',
    DEFT_APP_EXPERIENCE_RESOURCE_EXPOSURE_ENABLED: 'true', DEFT_APP_PRIVATE_STATE_ENABLED: 'true' });
  const ring = (id: string) => ({ current: id, keys: { [id]: createHash('sha256').update(`private-state-test:${id}`).digest('base64') } });
  process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({ schema_version: 'deft.app_run_keyring.v1', run_encryption: ring('private-enc'),
    receipt_signing: ring('private-sign'), fingerprint: ring('private-fp') });
  const [{ db, closeDb }, { sql }, web, { Hono }, routes, runtime, { AppPrivateStateSecrets }, inventory] = await Promise.all([
    import('../src/lib/db.js'), import('drizzle-orm'), import('../src/lib/web-sessions.js'), import('hono'),
    import('../src/routes/app-experiences.js'), import('../src/lib/app-run-runtime.js'), import('../src/lib/app-private-state-secrets.js'),
    import('../src/lib/app-private-state-key-references.js') ]);
  try {
    const rows = await db.execute(sql`SELECT r.*,u.email FROM app_private_state_records r
      JOIN app_installations i ON i.org_id=r.org_id AND i.id=r.installation_id
      JOIN app_versions v ON v.org_id=i.org_id AND v.id=i.active_version_id
      JOIN users u ON u.id=r.owner_user_id
      JOIN org_members m ON m.org_id=r.org_id AND m.user_id=r.owner_user_id AND m.is_active=true
      WHERE r.deleted_at IS NULL AND r.body IS NOT NULL AND r.expires_at>now()
        AND v.manifest->'experiences' @> jsonb_build_array(jsonb_build_object('artifact_digest',r.artifact_digest))
      ORDER BY r.created_at DESC LIMIT 1`);
    const row = rows.rows[0] as { org_id: string; owner_user_id: string; installation_id: string; state_key: string;
      record_id: string; artifact_digest: string; declaration_digest: string; revision: number; email: string; body: unknown; expires_at: Date };
    assert.ok(row, 'Restore fixture must contain current unexpired owner state');
    const current = await runtime.getAppRunRuntime();
    const context = { org_id: row.org_id, owner_user_id: row.owner_user_id, installation_id: row.installation_id,
      state_key: row.state_key, record_id: row.record_id, artifact_digest: row.artifact_digest,
      declaration_digest: row.declaration_digest, revision: row.revision };
    const secrets = new AppPrivateStateSecrets(current.keys), opened = secrets.open(context, row.body);
    assert.ok(opened && typeof opened === 'object');
    assert.equal(JSON.stringify(row.body).includes('PRIVATE-DRAFT'), false);
    assert.throws(() => secrets.open({ ...context, owner_user_id: randomUUID() }, row.body));
    assert.throws(() => secrets.open({ ...context, org_id: randomUUID() }, row.body));
    assert.ok((await inventory.listAppPrivateStateKeyReferences()).some(ref => ref.key_id === 'private-enc'));
    const human = await web.createWebSession({ id: row.owner_user_id, org_id: row.org_id, email: row.email });
    const app = new Hono(); app.route('/api/app-experiences', routes.appExperienceRoutes);
    const call = async (path: string, body: unknown) => {
      const response = await app.request('http://localhost/api/app-experiences' + path, { method: 'POST',
        headers: { authorization: `Bearer ${human.accessToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(response.headers.get('cache-control'), 'no-store');
      return { status: response.status, body: await response.json() as any };
    };
    const created = await call(`/${row.installation_id}/main/sessions`, {}); assert.equal(created.status, 200);
    const path = `/sessions/${created.body.pin.session_id}`, state = `${path}/state/${row.state_key}`;
    assert.ok((await call(state, { operation: 'read', record_id: row.record_id })).status >= 400);
    const review = await call(path + '/exposure/review', {}); assert.equal(review.status, 200);
    assert.equal((await call(path + '/exposure/accept', { review_token: review.body.review_token,
      review_digest: review.body.review_digest, accept_exposure: true })).status, 200);
    const result = await call(state, { operation: 'read', record_id: row.record_id }); assert.equal(result.status, 200);
    assert.deepEqual(result.body.output.item.value, opened);
    assert.equal(result.body.output.item.revision, row.revision);
    assert.equal(result.body.output.item.expires_at, new Date(row.expires_at).toISOString());
  } finally { await runtime.shutdownAppRunRuntime(); await closeDb(); }
});
