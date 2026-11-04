import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

/** §3.1 — carry the capture policy over to the reconnected account inside the
 * Phase 2 restore-access review: a retired policy is re-enabled in place and
 * scheduled; a denied review leaves it unchanged. Real PostgreSQL proof. */
const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = (() => {
  if (!target || target !== process.env.DATABASE_URL) return false;
  try {
    const url = new URL(target);
    return ['postgres:', 'postgresql:'].includes(url.protocol)
      && ['127.0.0.1', 'localhost'].includes(url.hostname)
      && /^\/deft_test/u.test(url.pathname) && !url.search && !url.hash;
  } catch { return false; }
})();

const sha = (value: string) => 'sha256:' + value.repeat(64).slice(0, 64);
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

test('restore access carries a retired capture policy over to the reconnected account', { skip: !safe, timeout: 120000 }, async (t) => {
  const client = new pg.Client({ connectionString: target });
  await client.connect();
  const { db, closeDb } = await import('../src/lib/db.js');
  const schema = await import('@deft/db/schema');
  const { and, eq } = await import('drizzle-orm');
  const { AppRestoreAccessService } = await import('../src/lib/app-restore-access-service.js');
  const { enumerateRestoreAccess } = await import('../src/lib/app-restore-access-context.js');

  const org = randomUUID(), owner = randomUUID();
  const installation = randomUUID(), binding = randomUUID();
  const targetKey = 'primary';
  const accountRef = 'acct_' + randomUUID().replaceAll('-', '');
  const policyId = randomUUID();

  t.after(async () => {
    await client.query('DELETE FROM app_restore_access_reviews WHERE org_id = $1', [org]).catch(() => {});
    await client.query('DELETE FROM app_integration_capture_policies WHERE org_id = $1', [org]).catch(() => {});
    await client.query('DELETE FROM job_queue WHERE name = $1 AND data->>\'policy_id\' = $2', ['app-integration-knowledge', policyId]).catch(() => {});
    await client.query('DELETE FROM app_connection_sessions WHERE org_id = $1', [org]).catch(() => {});
    await client.query('DELETE FROM web_sessions WHERE org_id = $1', [org]).catch(() => {});
    await client.query('DELETE FROM app_installations WHERE org_id = $1', [org]).catch(() => {});
    await client.query('DELETE FROM users WHERE id = $1', [owner]).catch(() => {});
    await client.query('DELETE FROM orgs WHERE id = $1', [org]).catch(() => {});
    await client.end();
    await closeDb();
  });

  await client.query(`CREATE TABLE IF NOT EXISTS app_integration_capture_policies (
    id text PRIMARY KEY, org_id text NOT NULL, owner_user_id text NOT NULL,
    installation_id text NOT NULL, account_ref text NOT NULL, store_key text NOT NULL,
    revision integer NOT NULL CHECK (revision > 0), enabled boolean NOT NULL DEFAULT false,
    input jsonb NOT NULL, history_since timestamptz NOT NULL,
    scan_checkpoint_id text, scan_after_projection_id text,
    retired_at timestamptz, retired_reason text, last_error text,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`);

  await db.insert(schema.orgs).values([{ id: org, name: 'Carry Org', slug: 'carry-' + org }]);
  await db.insert(schema.users).values([{ id: owner, name: 'Carry Owner', email: 'carry-' + owner + '@example.test', kind: 'human' }]);
  await db.insert(schema.orgMembers).values([{ org_id: org, user_id: owner, role: 'owner' }]);
  await db.insert(schema.appInstallations).values({
    id: installation, org_id: org, app_id: 'app_' + randomUUID().replaceAll('-', ''),
    lineage_key: 'lineage-' + installation, lineage_authority_type: 'local_user',
    lineage_authority_id: owner, installed_by_user_id: owner, installed_by_actor_type: 'user',
    installed_by_actor_id: owner, updated_by_actor_type: 'user', updated_by_actor_id: owner });

  const profile = {
    schema_version: 'deft.app_connection_profile.v1', key: 'primary', provider_id: 'synthetic_provider',
    operator_user_id: owner, runtime_requirement_key: 'sync_provider', resource_key: 'inbox',
    action_keys: ['send_item'], authorization_origin: 'https://provider.example.test',
    credential_custody: 'runtime', executable: false,
  };
  const scope = () => ({
    org_id: org, owner_user_id: owner, installation_id: installation,
    app_version_id: randomUUID(), grant_snapshot_id: randomUUID(),
    package_digest: sha('a'), grant_snapshot_digest: sha('b'), lifecycle_epoch: 1, grant_epoch: 1,
    target_key: targetKey, resource_key: 'inbox', resource_binding_id: binding,
    runtime_registration_id: randomUUID(), operator_user_id: owner, runtime_epoch: 1,
    profile_digest: sha('c'), consent_expires_at: at(180 * 86400_000),
  });
  const recordFor = (sessionId: string, state: string, createdAt: string) => ({
    session_id: sessionId, revision: 1, scope: scope(), profile, state,
    callback_state_hash: 'a'.repeat(64), callback_consumed: true, callback_expires_at: at(60_000),
    runtime_session_ref: 'runtime_' + sessionId.replaceAll('-', ''),
    account: { account_ref: accountRef, label: 'Synthetic account' },
    created_at: createdAt, updated_at: createdAt,
  });

  const priorSession = randomUUID();
  const currentSession = randomUUID();
  const priorCreated = at(-30 * 86400_000);
  // The .128 guard admits only `starting` revision 0 inserts; advance each
  // fixture session through the supported starting -> terminal transition.
  const insertSession = async (sessionId: string, state: string, createdAt: string) => {
    const record = recordFor(sessionId, state, createdAt);
    const webSessionId = randomUUID();
    // The guard requires the retained web identity to resolve to a live browser
    // session for the same org and owner, so provision one per fixture session.
    await db.insert(schema.webSessions).values({
      id: webSessionId, user_id: owner, org_id: org,
      refresh_token_hash: 'a'.repeat(64), expires_at: new Date(Date.now() + 3600_000) });
    await db.insert(schema.appConnectionSessions).values({
      org_id: org, owner_user_id: owner, session_id: sessionId, web_session_id: webSessionId,
      access_expires_at: new Date(Date.now() + 3600_000), revision: 0,
      record: { ...record, revision: 0, state: 'starting', callback_consumed: false },
      created_at: new Date(createdAt), updated_at: new Date(createdAt) });
    await db.update(schema.appConnectionSessions).set({ revision: 1, record })
      .where(and(eq(schema.appConnectionSessions.org_id, org),
        eq(schema.appConnectionSessions.session_id, sessionId)));
  };
  await insertSession(priorSession, 'disconnected', priorCreated);
  await insertSession(currentSession, 'connected', at(-60_000));

  await client.query(`INSERT INTO app_integration_capture_policies
    (id, org_id, owner_user_id, installation_id, account_ref, store_key, revision, enabled, input, history_since, retired_at, retired_reason)
    VALUES ($1,$2,$3,$4,$5,'compose',1,false,$6::jsonb,$7,now(),'grant_ended')`,
    [policyId, org, owner, installation, accountRef,
      JSON.stringify({ destination: { scope: 'user', space_id: null }, history_days: 30, include_bulk: false, excluded_senders: [], excluded_folders: [] }),
      new Date().toISOString()]);

  const actor = { org_id: org, user_id: owner, sid: 'web-session-' + randomUUID(), access_expires_at: Date.now() + 3600_000 };
  const service = new AppRestoreAccessService({ database: db, guard: async () => {}, now: () => Date.now() });

  const enumeration = await enumerateRestoreAccess(db, actor, { installation_id: installation, target_key: targetKey });
  const captureGrant = enumeration.grants.find((grant) => grant.kind === 'capture_policy');
  assert.ok(captureGrant, 'capture_policy grant is enumerated');
  assert.equal(captureGrant.store_key, 'compose');
  assert.equal(captureGrant.restorable, true);
  assert.equal(captureGrant.preselected, true);

  const review = await service.review(actor, { installation_id: installation, target_key: targetKey });

  // An empty activation re-issues nothing and consumes that review, so the
  // approved carry-over is a fresh, single-use review.
  await service.activate(actor, { review_id: review.review_id, review_digest: review.review_digest, review_expires_at: review.review_expires_at, installation_id: installation, target_key: targetKey, grant_ids: [] });
  let [row] = (await client.query('SELECT enabled, retired_reason, revision FROM app_integration_capture_policies WHERE id = $1', [policyId])).rows;
  assert.equal(row.enabled, false);
  assert.equal(row.retired_reason, 'grant_ended');
  assert.equal(row.revision, 1);

  // An approved review carries it over: re-enabled, fresh revision, scheduled.
  const approved = await service.review(actor, { installation_id: installation, target_key: targetKey });
  const activated = await service.activate(actor, { review_id: approved.review_id, review_digest: approved.review_digest, review_expires_at: approved.review_expires_at, installation_id: installation, target_key: targetKey, grant_ids: [captureGrant.grant_id] });
  assert.equal(activated.grants.length, 1);
  assert.equal(activated.grants[0].kind, 'capture_policy');

  [row] = (await client.query('SELECT enabled, retired_reason, revision FROM app_integration_capture_policies WHERE id = $1', [policyId])).rows;
  assert.equal(row.enabled, true);
  assert.equal(row.retired_reason, null);
  assert.equal(row.revision, 2);

  const jobs = (await client.query("SELECT count(*)::int AS n FROM job_queue WHERE name = 'app-integration-knowledge' AND data->>'policy_id' = $1 AND data->>'policy_revision' = '2'", [policyId])).rows[0].n;
  assert.equal(jobs, 1, 'one app-integration-knowledge job is scheduled for the carried-over policy');
});
