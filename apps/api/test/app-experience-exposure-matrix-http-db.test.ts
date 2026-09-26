import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import type { DeftExperienceArtifact } from '@deft/app-kit';
import { once } from 'node:events';
import { MessageChannel, Worker } from 'node:worker_threads';
import { createReviewedResourceSyncFixture } from './fixtures/resource-sync-v5.js';

const target = 'postgresql://gate_g_test@127.0.0.1:55435/gate_g_20260926_c10_exposure_matrix_test';
const safe = process.env.DATABASE_URL === target && process.env.DEFT_TEST_DATABASE_URL === target;
Object.assign(process.env, { DEFT_APPS_ENABLED: 'true', DEFT_APP_RUNS_ENABLED: 'true',
  DEFT_APP_RUN_APP_ORIGIN_ENABLED: 'true', DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED: 'true',
  DEFT_APP_RUNTIME_CHANNEL_ENABLED: 'false', DEFT_APP_EXPERIENCE_RESOURCE_EXPOSURE_ENABLED: 'true' });
const ring = (kind: string) => ({ current: kind, keys: { [kind]: createHash('sha256').update(`c10-exposure-matrix:${kind}`).digest('base64') } });
process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({ schema_version: 'deft.app_run_keyring.v1',
  run_encryption: ring('c10-enc'), receipt_signing: ring('c10-sign'), fingerprint: ring('c10-fp') });
const list = { schema_version: 'deft.experience_resource_request.v1', operation: 'list_summary' };
const sentinel = 'c10-PRIVATE-SENTINEL';
after(async () => { if (safe) { await (await import('../src/lib/app-run-runtime.js')).shutdownAppRunRuntime();
  await (await import('../src/lib/db.js')).closeDb(); } });

async function harness(descriptor?: any, records?: Record<string, unknown>[], consentClock?: () => Date, scoped?: { parent: Harness; secondOwner: boolean }) {
  const [{ db }, s, d, kit, runtimeModule, web, routes, { Hono }, { serve }, { default: pg }] = await Promise.all([
    import('../src/lib/db.js'), import('@deft/db/schema'), import('drizzle-orm'), import('@deft/app-kit'),
    import('../src/lib/app-run-runtime.js'), import('../src/lib/web-sessions.js'), import('../src/routes/app-experiences.js'),
    import('hono'), import('@hono/node-server'), import('pg')]);
  const runtime = await runtimeModule.getAppRunRuntime();
  const artifact = await kit.prepareDeftExperienceArtifact('experiences/main.json', { schema_version: 'deft.experience_bundle.v1',
    worker_source: 'self.onmessage=()=>{};', entry_view: 'main', resource_keys: ['inbox'], action_keys: [] });
  const f = scoped ? await scopedFixture(scoped.parent, artifact, scoped.secondOwner) : await createReviewedResourceSyncFixture({ keys: runtime.keys, clock: consentClock ?? (() => new Date()), experience_artifact: artifact,
    descriptor: descriptor ?? { schema_version: 'deft.app_sync_descriptor.v1', key: 'inbox', runtime_requirement_key: 'provider',
      resource_type: 'email_message', requested_visibility: 'user_private', label_field: 'subject', record_schema: { type: 'object',
        properties: { subject: { type: 'string', maxLength: 200 }, body: { type: 'string', maxLength: 10000 } }, required: ['subject'], additionalProperties: false } } });
  const [owner] = await db.select().from(s.users).where(d.eq(s.users.id, f.owner_user_id));
  const pair = await web.createWebSession({ id: owner!.id, email: owner!.email, org_id: f.org_id });
  const sid = JSON.parse(Buffer.from(pair.accessToken.split('.')[1]!, 'base64url').toString()).sid as string;
  const members = await db.select().from(s.orgMembers).where(d.eq(s.orgMembers.org_id, f.org_id));
  const app = new Hono(); app.route('/api/app-experiences', routes.appExperienceRoutes);
  app.route('/api/auth', (await import('../src/routes/auth.js')).authRoutes);
  let server!: ReturnType<typeof serve>;
  const base = await new Promise<string>(resolve => { server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, info => resolve(`http://127.0.0.1:${info.port}/api/app-experiences`)); });
  const call = async (path: string, method = 'GET', body?: unknown, token = pair.accessToken) => {
    const response = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return { status: response.status, body: await response.json() as any };
  };
  const open = async (accept = true) => {
    const created = await call(`/${f.installation_id}/main/sessions`, 'POST'); assert.equal(created.status, 200);
    const id = created.body.pin.session_id as string;
    const prepared = await call(`/sessions/${id}/exposure/review`, 'POST', {}); assert.equal(prepared.status, 200);
    const input = { review_token: prepared.body.review_token, review_digest: prepared.body.review_digest, accept_exposure: true };
    let exposure: any;
    if (accept) { const accepted = await call(`/sessions/${id}/exposure/accept`, 'POST', input); assert.equal(accepted.status, 200); exposure = accepted.body; }
    return { id, input, exposure };
  };
  const admission = await runtime.resourceSyncAdmission.admitDue({ org_id: f.org_id, resource_binding_id: f.binding_id }); assert.equal(admission.state, 'created');
  const management = new (await import('../src/lib/app-resource-sync-management.js')).AppResourceSyncManagement(runtime.keys);
  const credential = await management.issueOperatorSession(f.operator_actor, f.binding_id);
  const identity = { schema_version: 'deft.app_runtime_channel.v2' as const, audience: 'app_resource_sync' as const,
    session_id: credential.session_id, session_token: credential.session_token };
  const claim = await runtime.resourceSyncChannel.claim({ ...identity, max_claims: 1 }); assert.ok(claim);
  const attempt = { ...identity, run_id: claim.run_id, attempt_id: claim.attempt_id, claim_token: claim.claim_token, sequence: claim.sequence };
  assert.ok(await runtime.resourceSyncChannel.start(attempt));
  assert.ok(await runtime.resourceSyncChannel.complete({ ...attempt, status: 'returned', provider_succeeded: true, page: {
    schema_version: 'deft.app_sync_page.v1', upserts: (records ?? [{ subject: sentinel, body: sentinel }, { subject: 'Second saved record', body: sentinel }])
      .map((data, i) => ({ id: `provider-private-${i}`, revision: 'provider-private-revision', data })), tombstones: [], next_cursor: 'provider-private-cursor', has_more: false } }));
  return { f, db, s, d, kit, runtime, web, owner: owner!, pair, sid, members, call, open, pg, base,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
type Harness = Awaited<ReturnType<typeof harness>>;
async function scopedFixture(h: Harness, artifact: DeftExperienceArtifact, secondOwner: boolean): Promise<Awaited<ReturnType<typeof createReviewedResourceSyncFixture>>> {
  const modules = await import('../src/lib/module-service.js');
  const apps = await import('../src/lib/app-service.js');
  const reviews = await import('../src/lib/app-runtime-review.js');
  let ownerId = h.f.owner_user_id;
  if (secondOwner) {
    ownerId = randomUUID();
    await h.db.insert(h.s.users).values({ id: ownerId, name: 'Second synthetic owner', email: `matrix-${ownerId}@example.test` });
    await h.db.insert(h.s.orgMembers).values({ id: randomUUID(), org_id: h.f.org_id, user_id: ownerId, role: 'admin', is_active: true });
  }
  const actor = modules.humanModuleActor({ orgId: h.f.org_id, userId: ownerId, role: secondOwner ? 'admin' : 'owner', source: 'rest' });
  let installationId = h.f.installation_id;
  let versionId = h.f.app_version_id;
  let grantId = h.f.grant_snapshot_id;
  let consentRequest = { ...h.f.consent_request, consent_expires_at: new Date(Date.now() + 60 * 60_000).toISOString() };
  if (!secondOwner) {
    const [old] = await h.db.select().from(h.s.appVersions).where(h.d.eq(h.s.appVersions.id, versionId));
    const manifest = old!.manifest as any;
    const pkg = await h.kit.buildDeftAppPackage({ manifest: { ...manifest, id: `community.example.matrix.a${randomUUID().replaceAll('-', '')}` }, artifacts: [artifact] });
    const staged = await apps.stageAppPackage(actor, pkg.json);
    const [version] = await h.db.select().from(h.s.appVersions).where(h.d.eq(h.s.appVersions.id, staged.version_id));
    const [requested] = await h.db.select().from(h.s.appGrantSnapshots).where(h.d.eq(h.s.appGrantSnapshots.id, version!.requested_grant_snapshot_id!));
    const request = { app_version_id: version!.id, expected_package_digest: version!.package_digest, expected_requested_snapshot_digest: requested!.snapshot_digest,
      expected_lifecycle_epoch: staged.lifecycle_epoch, expected_grant_epoch: staged.grant_epoch };
    const review = await reviews.prepareRuntimeAppReview(actor, staged.id, request);
    const activated = await reviews.activateRuntimeApp(actor, staged.id, { ...request, expected_review_digest: review.review_digest, accept_host_policy: true });
    const [grant] = await h.db.select().from(h.s.appGrantSnapshots).where(h.d.eq(h.s.appGrantSnapshots.id, activated.grant_snapshot_id));
    installationId = staged.id; versionId = version!.id; grantId = grant!.id;
    consentRequest = { ...consentRequest, installation_id: installationId, expected_app_version_id: versionId,
      expected_package_digest: version!.package_digest, expected_grant_snapshot_digest: grant!.snapshot_digest,
      expected_lifecycle_epoch: activated.installation.lifecycle_epoch, expected_grant_epoch: activated.installation.grant_epoch };
  }
  const management = new (await import('../src/lib/app-resource-sync-management.js')).AppResourceSyncManagement(h.runtime.keys);
  const consentReview = await management.prepareConsent(actor, consentRequest);
  const consent = await management.activateConsent(actor, { ...consentRequest, expected_review_digest: consentReview.review_digest, accept_host_policy: true });
  return { ...h.f, owner_user_id: ownerId, owner_actor: actor, installation_id: installationId, app_version_id: versionId, grant_snapshot_id: grantId,
    registration_id: consent.registration_id, binding_id: consent.binding_id, checkpoint_id: consent.checkpoint_id, management, consent_request: consentRequest, consent_review: consentReview };
}
function noDisclosure(result: { status: number; body: any }) {
  assert.ok([403, 404, 409].includes(result.status), `expected structured authorization denial, got ${result.status}`);
  assert.equal(result.body.output, undefined); assert.equal(JSON.stringify(result.body).includes(sentinel), false);
}
async function actualWait(blocker: any, pid: number, count = 1) {
  for (let i = 0; i < 35; i++) {
    const observed = await blocker.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=$1 AND $2=ANY(pg_blocking_pids(pid))', ['deft-experience-exposure', pid]);
    if (observed.rows[0].n >= count) return;
    await new Promise(resolve => setTimeout(resolve, 4));
  }
  assert.fail('required real exposure row-lock wait not observed');
}
type Mutation = { name: string; table: string; id(h: Harness): string; set: string; user?: boolean; session?: boolean; exposureOnly?: boolean };
const mutations: Mutation[] = [
  ...(['owner', 'operator'] as const).flatMap(person => [
    { name: `${person} membership inactive`, table: 'org_members', id: (h: Harness) => h.members.find(m => m.user_id === (person === 'owner' ? h.f.owner_user_id : h.f.operator_user_id))!.id, set: 'is_active=false' },
    { name: `${person} membership guest`, table: 'org_members', id: (h: Harness) => h.members.find(m => m.user_id === (person === 'owner' ? h.f.owner_user_id : h.f.operator_user_id))!.id, set: "role='guest'" },
    { name: `${person} kind becomes agent after final SID wait`, table: 'web_sessions', id: (h: Harness) => h.sid, set: "kind='agent'", user: true, person },
  ]),
  { name: 'App disable transition clears grant and advances epochs', table: 'app_installations', id: h => h.f.installation_id,
    set: "state='disabled',disabled_at=now(),lifecycle_epoch=lifecycle_epoch+1,grant_epoch=grant_epoch+1,active_grant_snapshot_id=NULL,active_grant_snapshot_kind=NULL" },
  { name: 'registration revoked with a new runtime epoch', table: 'app_runtime_registrations', id: h => h.f.registration_id, set: "state='revoked',runtime_epoch=runtime_epoch+1" },
  { name: 'binding revoked', table: 'app_resource_bindings', id: h => h.f.binding_id, set: "state='revoked'" },
  { name: 'checkpoint paused', table: 'app_sync_checkpoints', id: h => h.f.checkpoint_id, set: "state='paused'" },
  { name: 'Experience revoked', table: 'app_experience_sessions', id: () => '', set: 'revoked_at=now()', session: true },
  { name: 'Experience expires', table: 'app_experience_sessions', id: () => '', set: "expires_at=created_at+interval '1 millisecond'", session: true },
  { name: 'Experience artifact pin substituted', table: 'app_experience_sessions', id: () => '', set: `artifact_digest='sha256:${'4'.repeat(64)}'`, session: true },
  { name: 'exposure revoked under its row lock', table: 'app_experience_resource_exposures', id: () => '', set: 'revoked_at=now(),exposure_epoch=exposure_epoch+1', exposureOnly: true },
];
for (const mutation of mutations) test(`B04/B05/S02 held ${mutation.name}: deny current read and stale acceptance`, { skip: !safe }, async () => {
  const h = await harness(); const accepted = await h.open(); const pending = mutation.exposureOnly ? null : await h.open(false);
  assert.equal((await h.call(`/sessions/${accepted.id}/resources/inbox`, 'POST', list)).status, 200);
  // Initialize both bounded exposure slots before measuring a 250ms SQL wait;
  // connection startup is not the authority mutation under test.
  if (pending) await Promise.all([h.call(`/sessions/${accepted.id}/resources/inbox`, 'POST', list),
    h.call(`/sessions/${pending.id}/exposure`)]);
  const blocker = new h.pg.Client({ connectionString: target }); await blocker.connect();
  try {
    await blocker.query('BEGIN'); const { rows: [process] } = await blocker.query('SELECT pg_backend_pid() AS id');
    const ids = mutation.session ? [accepted.id, pending!.id] : [mutation.exposureOnly ? accepted.exposure.exposure_id : mutation.id(h)];
    await blocker.query(`SELECT id FROM ${mutation.table} WHERE org_id=$1 AND id=ANY($2::text[]) FOR UPDATE`, [h.f.org_id, ids]);
    const reading = h.call(`/sessions/${accepted.id}/resources/inbox`, 'POST', list);
    const accepting = pending ? h.call(`/sessions/${pending.id}/exposure/accept`, 'POST', pending.input) : null;
    await actualWait(blocker, process.id, pending ? 2 : 1);
    if (mutation.user) {
      const id = mutation.name.startsWith('owner') ? h.f.owner_user_id : h.f.operator_user_id;
      await blocker.query(`UPDATE users SET ${mutation.set} WHERE id=$1`, [id]);
    } else {
      await blocker.query(`UPDATE ${mutation.table} SET ${mutation.set} WHERE org_id=$1 AND id=ANY($2::text[])`,
        mutation.set.includes('$3') ? [h.f.org_id, ids, h.f.owner_user_id] : [h.f.org_id, ids]);
    }
    await blocker.query('COMMIT'); noDisclosure(await reading); if (accepting) noDisclosure(await accepting);
    const exposures = await h.db.select().from(h.s.appExperienceResourceExposures).where(h.d.eq(h.s.appExperienceResourceExposures.org_id, h.f.org_id));
    assert.equal(exposures.length, 1, 'failed acceptance creates no exposure');
    const audit = await h.db.select().from(h.s.appExperienceResourceExposureAudit).where(h.d.eq(h.s.appExperienceResourceExposureAudit.org_id, h.f.org_id));
    assert.equal(audit.length, 1, 'failed acceptance creates no audit');
  } finally { await blocker.query('ROLLBACK'); await blocker.end(); await h.close(); }
});

test('B03/B04 immutable version grant registration and binding pins reject DB tamper', { skip: !safe }, async () => {
  const h = await harness(); const opened = await h.open();
  const client = new h.pg.Client({ connectionString: target }); await client.connect();
  try {
    const attempts = [
      { table: 'app_versions', id: h.f.app_version_id, set: "state='superseded',superseded_at=now()", code: '23514' },
      { table: 'app_versions', id: h.f.app_version_id, set: `package_digest='sha256:${'1'.repeat(64)}'` },
      { table: 'app_grant_snapshots', id: h.f.grant_snapshot_id, set: `snapshot_digest='sha256:${'2'.repeat(64)}'` },
      { table: 'app_runtime_registrations', id: h.f.registration_id, set: 'operator_user_id=$3' },
      { table: 'app_resource_bindings', id: h.f.binding_id, set: `descriptor_digest='sha256:${'3'.repeat(64)}'` },
      { table: 'app_resource_bindings', id: h.f.binding_id, set: "consent_expires_at=reviewed_at+interval '1 millisecond'" },
    ];
    for (const attempt of attempts) {
      await client.query('BEGIN'); const { rows: [process] } = await client.query('SELECT pg_backend_pid() AS id');
      await client.query(`SELECT id FROM ${attempt.table} WHERE org_id=$1 AND id=$2 FOR UPDATE`, [h.f.org_id, attempt.id]);
      const reading = h.call(`/sessions/${opened.id}/resources/inbox`, 'POST', list);
      await actualWait(client, process.id);
      const updating = client.query(`UPDATE ${attempt.table} SET ${attempt.set} WHERE org_id=$1 AND id=$2`,
        attempt.set.includes('$3') ? [h.f.org_id, attempt.id, h.f.owner_user_id] : [h.f.org_id, attempt.id]);
      if (attempt.code) {
        await updating;
        await assert.rejects(client.query('SET CONSTRAINTS ALL IMMEDIATE'), { code: attempt.code });
      } else await assert.rejects(updating, { code: '55000' });
      await client.query('ROLLBACK'); assert.equal((await reading).status, 200);
    }
    assert.equal((await h.call(`/sessions/${opened.id}/resources/inbox`, 'POST', list)).status, 200,
      'DB-rejected substitutions leave the valid original authority unchanged');
  } finally { await client.query('ROLLBACK'); await client.end(); await h.close(); }
});

for (const mode of ['binding consent expiry', 'exposure expiry'] as const) test(`B05/S02 held ${mode} uses a private service clock and delivers no body`, { skip: !safe }, async () => {
  // Only this fixture's consent clock is shortened. Host and PostgreSQL clocks
  // remain untouched; the real exposure repository and SQL lock limits remain.
  const h = await harness(undefined, undefined, mode === 'binding consent expiry'
    ? () => new Date(Date.now() - 59 * 60_000) : undefined);
  const { AppExperienceExposureService } = await import('../src/lib/app-experience-exposure.js');
  const verified = await h.web.verifyWebAccess(h.pair.accessToken);
  let now = new Date();
  const service = new AppExperienceExposureService(h.runtime.keys, undefined, () => now);
  const caller = { org_id: verified.org_id, user_id: verified.id, sid: verified.sid, access_expires_at: verified.exp * 1000 };
  const created = await h.call(`/${h.f.installation_id}/main/sessions`, 'POST'); assert.equal(created.status, 200);
  const id = created.body.pin.session_id;
  const prepared = await service.prepare(mode === 'exposure expiry' ? { ...caller, access_expires_at: now.getTime() + 5000 } : caller, id);
  const accepted = await service.accept(caller, id, { review_token: prepared.review_token, review_digest: prepared.review_digest, accept_exposure: true });
  const blocker = new h.pg.Client({ connectionString: target }); await blocker.connect();
  try {
    await blocker.query('BEGIN'); const { rows: [process] } = await blocker.query('SELECT pg_backend_pid() AS id');
    const table = mode === 'binding consent expiry' ? 'app_resource_bindings' : 'app_experience_resource_exposures';
    const rowId = mode === 'binding consent expiry' ? h.f.binding_id : accepted.exposure_id;
    await blocker.query(`SELECT id FROM ${table} WHERE org_id=$1 AND id=$2 FOR UPDATE`, [h.f.org_id, rowId]);
    const reading = service.read(caller, id, 'inbox', list);
    const rejected = assert.rejects(reading);
    await actualWait(blocker, process.id); now = new Date(Date.parse(prepared.snapshot.expires_at) + 1);
    await blocker.query('COMMIT'); await rejected;
  } finally { await blocker.query('ROLLBACK'); await blocker.end(); await h.close(); }
});

test('B04/S02 cross-owner/org/App record and prepared review substitutions never deliver', { skip: !safe }, async () => {
  const a = await harness(); const b = await harness();
  try {
    const first = await a.open(); const other = await b.open();
    const foreignList = await b.call(`/sessions/${other.id}/resources/inbox`, 'POST', list); assert.equal(foreignList.status, 200);
    const record = foreignList.body.output.items[0].record_id;
    noDisclosure(await a.call(`/sessions/${first.id}/resources/inbox`, 'POST', { schema_version: list.schema_version, operation: 'read_one', record_id: record }));
    noDisclosure(await a.call(`/sessions/${first.id}/resources/inbox`, 'POST', list, b.pair.accessToken));
    const unaccepted = await a.open(false);
    noDisclosure(await a.call(`/sessions/${unaccepted.id}/exposure/accept`, 'POST', other.input));
    const page = await a.call(`/sessions/${first.id}/resources/inbox`, 'POST', { ...list, limit: 1 }); assert.equal(page.status, 200);
    const fresh = await a.open(); noDisclosure(await a.call(`/sessions/${fresh.id}/resources/inbox`, 'POST', { ...list, cursor: page.body.output.next_cursor }));
    const operator = await a.db.select().from(a.s.users).where(a.d.eq(a.s.users.id, a.f.operator_user_id));
    const token = await a.web.createWebSession({ id: operator[0]!.id, email: operator[0]!.email, org_id: a.f.org_id });
    noDisclosure(await a.call(`/sessions/${first.id}/resources/inbox`, 'POST', list, token.accessToken));
  } finally { await a.close(); await b.close(); }
});

for (const secondOwner of [false, true]) test(`B04/S02 same-org ${secondOwner ? 'distinct private owner, same App' : 'same owner, distinct App'} record cursor and review substitutions deny`, { skip: !safe }, async () => {
  const a = await harness(); const b = await harness(undefined, undefined, undefined, { parent: a, secondOwner });
  try {
    assert.equal(a.f.org_id, b.f.org_id);
    assert.equal(a.f.owner_user_id === b.f.owner_user_id, !secondOwner);
    assert.equal(a.f.installation_id === b.f.installation_id, secondOwner);
    const first = await a.open(); const other = await b.open();
    const page = await b.call(`/sessions/${other.id}/resources/inbox`, 'POST', { ...list, limit: 1 }); assert.equal(page.status, 200);
    noDisclosure(await a.call(`/sessions/${first.id}/resources/inbox`, 'POST', { schema_version: list.schema_version, operation: 'read_one', record_id: page.body.output.items[0].record_id }));
    noDisclosure(await a.call(`/sessions/${first.id}/resources/inbox`, 'POST', { ...list, cursor: page.body.output.next_cursor }));
    const pending = await a.open(false);
    noDisclosure(await a.call(`/sessions/${pending.id}/exposure/accept`, 'POST', other.input));
    if (secondOwner) noDisclosure(await a.call(`/sessions/${first.id}/resources/inbox`, 'POST', list, b.pair.accessToken));
    assert.equal((await a.call(`/sessions/${first.id}/resources/inbox`, 'POST', list)).status, 200);
    assert.equal((await b.call(`/sessions/${other.id}/resources/inbox`, 'POST', list)).status, 200);
  } finally { await a.close(); await b.close(); }
});

test('S04/S05 immutable checkpoint generation refuses an unsupported reset', { skip: !safe }, async () => {
  const h = await harness(); const opened = await h.open(); const page = await h.call(`/sessions/${opened.id}/resources/inbox`, 'POST', { ...list, limit: 1 }); assert.equal(page.status, 200);
  const blocker = new h.pg.Client({ connectionString: target }); await blocker.connect();
  try {
    await blocker.query('BEGIN'); const { rows: [process] } = await blocker.query('SELECT pg_backend_pid() AS id');
    await blocker.query('SELECT id FROM app_sync_checkpoints WHERE org_id=$1 AND id=$2 FOR UPDATE', [h.f.org_id, h.f.checkpoint_id]);
    const reading = h.call(`/sessions/${opened.id}/resources/inbox`, 'POST', { ...list, cursor: page.body.output.next_cursor });
    await actualWait(blocker, process.id);
    await assert.rejects(blocker.query('UPDATE app_sync_checkpoints SET generation=generation+1 WHERE org_id=$1 AND id=$2', [h.f.org_id, h.f.checkpoint_id]), { code: '55000' });
    await blocker.query('ROLLBACK'); assert.equal((await reading).status, 200, 'rejected tamper leaves valid authority unchanged');
  } finally { await blocker.query('ROLLBACK'); await blocker.end(); await h.close(); }
});

test('B05 supported password reset revokes accepted exposure and cannot move it to a new SID', { skip: !safe }, async () => {
  const h = await harness(); const opened = await h.open();
  try {
    const jwt = (await import('jsonwebtoken')).default;
    const { env } = await import('../src/lib/env.js');
    const reset = jwt.sign({ id: h.owner.id, org_id: h.f.org_id, purpose: 'password-reset', password_version: h.owner.password_version }, env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m', jwtid: randomUUID() });
    const response = await fetch(`${h.base.replace('/api/app-experiences', '/api/auth')}/reset-password`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: reset, password: `Synthetic-${randomUUID()}` }) });
    assert.equal(response.status, 200);
    noDisclosure(await h.call(`/sessions/${opened.id}/resources/inbox`, 'POST', list));
    const pair = await h.web.createWebSession({ id: h.owner.id, email: h.owner.email, org_id: h.f.org_id });
    noDisclosure(await h.call(`/sessions/${opened.id}/resources/inbox`, 'POST', list, pair.accessToken));
  } finally { await h.close(); }
});

test('G09 supported App disable invalidates accepted v5 exposure and preserves saved records', { skip: !safe }, async () => {
  const h = await harness(); const opened = await h.open();
  try {
    const [app] = await h.db.select().from(h.s.appInstallations).where(h.d.eq(h.s.appInstallations.id, h.f.installation_id));
    await (await import('../src/lib/app-service.js')).disableAppInstallation(h.f.owner_actor, h.f.installation_id, app!.lifecycle_epoch);
    noDisclosure(await h.call(`/sessions/${opened.id}/resources/inbox`, 'POST', list));
    const records = await h.db.select({ id: h.s.appResourceProjections.id }).from(h.s.appResourceProjections).where(h.d.eq(h.s.appResourceProjections.resource_binding_id, h.f.binding_id)); assert.equal(records.length, 2);
  } finally { await h.close(); }
});

test('B04/B06/S01 maximal32-field Unicode payload is bounded as a whole envelope without partial data', { skip: !safe }, async () => {
  const fields = Object.fromEntries(['subject', ...Array.from({ length: 31 }, (_, i) => `field_${i}`)].map(key => [key, { type: 'string', maxLength: key === 'subject' ? 200 : 4096 }]));
  const descriptor = { schema_version: 'deft.app_sync_descriptor.v1', key: 'inbox', runtime_requirement_key: 'provider', resource_type: 'email_message', requested_visibility: 'user_private', label_field: 'subject', record_schema: { type: 'object', properties: fields, required: ['subject'], additionalProperties: false } };
  const values = (value: string) => Object.fromEntries(Object.keys(fields).map(key => [key, key === 'subject' ? sentinel : value]));
  const h = await harness(descriptor, [values('😀'.repeat(100)), values('😀'.repeat(2048)), values('"'.repeat(4096))]);
  try {
    const opened = await h.open(); const rows = await h.db.select().from(h.s.appResourceProjections).where(h.d.eq(h.s.appResourceProjections.resource_binding_id, h.f.binding_id));
    let accepted = 0, denied = 0;
    for (const row of rows) {
      const result = await h.call(`/sessions/${opened.id}/resources/inbox`, 'POST', { schema_version: list.schema_version, operation: 'read_one', record_id: row.id });
      if (result.status === 200) {
        accepted++; assert.equal(Object.keys(result.body.output.item.data).length, 32);
        const envelope = { version: 'deft.experience_bridge.v1', kind: 'response', session_id: opened.id, request_id: `request_${'9'.repeat(56)}`, ok: true, output: result.body.output };
        assert.ok(Buffer.byteLength(JSON.stringify(envelope), 'utf8') <= 60 * 1024);
      } else { denied++; assert.equal(result.status, 413); assert.equal(result.body.code, 'RESOURCE_PAYLOAD_TOO_LARGE'); assert.equal(result.body.output, undefined); assert.equal(JSON.stringify(result.body).includes(sentinel), false); }
    }
    assert.equal(accepted, 1); assert.equal(denied, 2);
  } finally { await h.close(); }
});

for (const mode of ['replayed sequence', 'substituted session', 'undeclared resource', 'late response after port revoke'] as const)
test(`B04 real Node Worker transferred-port transport: ${mode}`, { skip: !safe, timeout: 15_000 }, async () => {
  // This is actual transport evidence, not browser-origin or Worker isolation
  // evidence. Resource/status callbacks use the normal authenticated HTTP API.
  const h = await harness(); const opened = await h.open();
  const { createExperienceBridge } = await import('../../web/src/lib/app-experience-bridge.js');
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(`const { parentPort } = require('node:worker_threads'); let port;
    parentPort.on('message', x => { if (x.port) { port=x.port; port.on('message', data=>parentPort.postMessage({response:data})); parentPort.postMessage({ready:true}); }
      else { port.postMessage(x.send); parentPort.postMessage({sent:true}); } });`, { eval: true });
  const received: unknown[] = []; worker.on('message', value => { if (value.response) received.push(value.response); });
  let calls = 0; let release!: () => void; let entered!: () => void; let finished!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const callbackEntered = new Promise<void>(resolve => { entered = resolve; });
  const callbackFinished = new Promise<void>(resolve => { finished = resolve; });
  const pin = { org_id: h.f.org_id, user_id: h.f.owner_user_id, app_installation_id: h.f.installation_id,
    app_version_id: h.f.app_version_id, grant_snapshot_id: h.f.grant_snapshot_id, lifecycle_epoch: 1, grant_epoch: 1,
    session_id: opened.id, session_epoch: 1 };
  const bridge = createExperienceBridge({ port: port1 as unknown as Parameters<typeof createExperienceBridge>[0]['port'], pin,
    resourceKeys: ['inbox'], actionKeys: [], onView() {}, broker: {
      async isLive() { const current = await h.call(`/sessions/${opened.id}/exposure`); return current.status === 200 && current.body.active === true; },
      async resource(_pin, key, input) { calls++; const read = await h.call(`/sessions/${opened.id}/resources/${key}`, 'POST', input); assert.equal(read.status, 200);
        if (mode === 'late response after port revoke') { entered(); await held; finished(); } return read.body.output; },
    } });
  const send = async (value: unknown) => { const ack = once(worker, 'message'); worker.postMessage({ send: value }); await ack; };
  const request = { version: 'deft.experience_bridge.v1', kind: 'request', session_id: opened.id,
    sequence: 1, request_id: 'request_1', operation: 'resource', key: 'inbox', input: list };
  try {
    const ready = once(worker, 'message'); worker.postMessage({ port: port2 }, [port2]); await ready;
    if (mode === 'late response after port revoke') {
      await send(request); await callbackEntered;
    } else if (mode !== 'undeclared resource') {
      const response = new Promise<void>(resolve => { const listener = (value: any) => { if (value.response) { worker.off('message', listener); resolve(); } }; worker.on('message', listener); });
      await send(request); await response; assert.equal(received.length, 1);
    }
    const closed = once(port1, 'close');
    await send(mode === 'replayed sequence' ? request : mode === 'undeclared resource' ? { ...request, key: 'private_other' }
      : { ...request, sequence: 2, request_id: 'request_2', session_id: randomUUID() });
    await closed; assert.equal(bridge.active, false);
    if (mode === 'late response after port revoke') { release(); await callbackFinished; assert.equal(received.length, 0); }
    assert.equal(calls, mode === 'undeclared resource' ? 0 : 1);
    // The same old transferred port cannot be made authoritative by sending a
    // fresh-looking request after the production bridge has closed it.
    await send({ ...request, sequence: 3, request_id: 'request_3' }); assert.equal(calls, mode === 'undeclared resource' ? 0 : 1);
  } finally { release(); bridge.revoke(); port1.close(); await worker.terminate(); await h.close(); }
});
