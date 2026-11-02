import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';

const uuid = () => randomUUID();
const sha = (value: string) => 'sha256:' + value.repeat(64).slice(0, 64);
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

const target = process.env.DATABASE_URL;
const safe = (() => {
  if (!target || target !== process.env.DEFT_TEST_DATABASE_URL) return false;
  try {
    const url = new URL(target);
    return ['postgres:', 'postgresql:'].includes(url.protocol)
      && ['127.0.0.1', 'localhost'].includes(url.hostname)
      && /^\/deft_test/u.test(url.pathname) && !url.search && !url.hash;
  } catch { return false; }
})();

const mirrorTool = {
  key: 'draft_mirror', description: 'Nominate a saved record for a provider mirror.',
  operation: 'draft', mode: 'review', store_key: 'drafts', resource_key: 'inbox', runtime_requirement_key: 'sync_provider',
  input_schema: { type: 'object', additionalProperties: false, properties: { account: { type: 'string' }, record_id: { type: 'string' } } },
  account_input_key: 'account', data_operations: ['record_read', 'prepare_record_mirror'],
  input_pins: [{ operation: 'prepare_record_mirror', outer_key: 'record_id', inner_field: 'record_id', required: true }],
  action_key: 'mirror_drafts', visibility: 'delegated_tools',
};

test('the review digest changes when the two default kinds are added', () => {
  const base = {
    installation_id: uuid(), target_key: 'primary', current_session_id: uuid(),
    current_account_ref: 'acct_1', prior_account_ref: 'acct_1', grants: [] as unknown[],
  };
  const actor = { org_id: uuid(), user_id: uuid(), sid: uuid(), access_expires_at: Date.now() + 60_000 };
  const expires = at(10 * 60_000);
  const recordGrant = { grant_id: uuid(), kind: 'record_consent', store_key: 'alpha', state: 'active', lifetime: { kind: 'duration', seconds: 7776000 }, restorable: true, preselected: true };
  const without = { ...base, grants: [recordGrant] };
  const withDefaults = {
    ...base, grants: [
      recordGrant,
      { grant_id: uuid(), kind: 'defty_read_grant', store_key: 'drafts', state: 'active', lifetime: { kind: 'duration', seconds: 7776000 }, restorable: true, preselected: false },
      { grant_id: uuid(), kind: 'agent_policy_default', action_key: 'mirror_drafts', state: 'active', lifetime: { kind: 'duration', seconds: 7776000 }, restorable: true, preselected: false },
    ],
  };
  return import('../src/lib/app-restore-access-authority.js').then(({ restoreAccessReviewDigest }) => {
    const a = restoreAccessReviewDigest(without as never, actor as never, expires);
    const b = restoreAccessReviewDigest(withDefaults as never, actor as never, expires);
    assert.notEqual(a, b, 'adding the default kinds changes the digest');
    assert.match(a, /^sha256:[a-f0-9]{64}$/u);
    assert.match(b, /^sha256:[a-f0-9]{64}$/u);
  });
});

test('restore defaults: unselected enumeration, selective activation seeds read + require_approval',
  { skip: !safe, timeout: 120000 }, async (t) => {
    const client = new pg.Client({ connectionString: target });
    await client.connect();
    await client.query(`CREATE TABLE IF NOT EXISTS app_integration_principal_grants (
      id text PRIMARY KEY, org_id text NOT NULL, owner_user_id text NOT NULL,
      installation_id text NOT NULL, resource_binding_id text NOT NULL, account_ref text NOT NULL,
      store_key text NOT NULL, principal_kind text NOT NULL, principal_id text NOT NULL,
      operations text[] NOT NULL, revision integer NOT NULL, expires_at timestamptz NOT NULL,
      revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS app_integration_principal_grants_active_unique
      ON app_integration_principal_grants (org_id, owner_user_id, installation_id, account_ref, resource_binding_id, store_key, principal_kind, principal_id) WHERE revoked_at IS NULL`);
    await client.query(`CREATE TABLE IF NOT EXISTS app_runtime_bindings (
      id text PRIMARY KEY, org_id text NOT NULL, app_installation_id text NOT NULL,
      owner_resource_binding_id text, action_key text NOT NULL, state text NOT NULL)`);
    await client.query(`CREATE TABLE IF NOT EXISTS app_runtime_agent_policies (
      org_id text NOT NULL, owner_user_id text NOT NULL, runtime_binding_id text NOT NULL,
      mode text NOT NULL, revision integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (org_id, owner_user_id, runtime_binding_id))`);

    const { db, closeDb } = await import('../src/lib/db.js');
    const schema = await import('@deft/db/schema');
    const { and, eq } = await import('drizzle-orm');

    const orgId = uuid(), ownerId = uuid();
    const installationId = uuid(), binding = uuid(), versionId = uuid();
    const targetKey = 'primary';
    const accountRef = 'acct_' + randomUUID().replaceAll('-', '');
    t.after(async () => {
      for (const table of ['app_runtime_agent_policies', 'app_runtime_bindings', 'app_integration_principal_grants', 'app_connection_sessions', 'app_versions', 'app_installations']) {
        await client.query(`DELETE FROM ${table} WHERE org_id = $1`, [orgId]).catch(() => {});
      }
      await client.query('DELETE FROM org_members WHERE org_id = $1', [orgId]).catch(() => {});
      await client.query('DELETE FROM users WHERE id = $1', [ownerId]).catch(() => {});
      await client.query('DELETE FROM orgs WHERE id = $1', [orgId]).catch(() => {});
      await client.end();
      await closeDb();
    });

    await db.insert(schema.orgs).values({ id: orgId, name: 'Defaults Org', slug: 'defaults-' + orgId });
    await db.insert(schema.users).values({ id: ownerId, name: 'Owner', email: 'defaults-' + ownerId + '@example.test', kind: 'human' });
    await db.insert(schema.orgMembers).values({ id: uuid(), org_id: orgId, user_id: ownerId, role: 'owner', is_active: true });
    await db.insert(schema.appInstallations).values({
      id: installationId, org_id: orgId, app_id: 'app-' + orgId, lineage_key: 'lineage-' + orgId,
      lineage_authority_type: 'local_user', lineage_authority_id: ownerId, source: 'local', state: 'staged',
      installed_by_actor_type: 'user', installed_by_actor_id: ownerId, updated_by_actor_type: 'user', updated_by_actor_id: ownerId,
    });
    await db.insert(schema.appVersions).values({
      id: versionId, org_id: orgId, installation_id: installationId, version: '1.0.0', protocol_version: '0',
      manifest: { integration_tools: [mirrorTool] }, manifest_digest: sha('a'), package_digest: sha('b'), package: {},
      created_by_actor_type: 'user', created_by_actor_id: ownerId,
    });

    const profile = {
      schema_version: 'deft.app_connection_profile.v1', key: 'primary', provider_id: 'synthetic_provider',
      operator_user_id: ownerId, runtime_requirement_key: 'sync_provider', resource_key: 'inbox',
      action_keys: ['mirror_drafts'], authorization_origin: 'https://provider.example.test',
      credential_custody: 'runtime', executable: false,
    };
    const scope = {
      org_id: orgId, owner_user_id: ownerId, installation_id: installationId,
      app_version_id: versionId, grant_snapshot_id: uuid(), package_digest: sha('a'), grant_snapshot_digest: sha('b'),
      lifecycle_epoch: 1, grant_epoch: 1, target_key: targetKey, resource_key: 'inbox', resource_binding_id: binding,
      runtime_registration_id: uuid(), operator_user_id: ownerId, runtime_epoch: 1, profile_digest: sha('c'),
      consent_expires_at: at(180 * 86400_000),
    };
    const sessionId = uuid();
    const record = {
      session_id: sessionId, revision: 1, scope, profile, state: 'connected',
      callback_state_hash: 'a'.repeat(64), callback_consumed: true, callback_expires_at: at(60_000),
      runtime_session_ref: 'runtime_' + sessionId.replaceAll('-', ''), account: { account_ref: accountRef, label: 'Synthetic account' },
      created_at: at(-60_000), updated_at: at(-60_000),
    };
    await db.insert(schema.appConnectionSessions).values({
      org_id: orgId, owner_user_id: ownerId, session_id: sessionId, web_session_id: uuid(),
      access_expires_at: new Date(Date.now() + 3600_000), revision: 1, record, created_at: new Date(record.created_at), updated_at: new Date(record.updated_at),
    });

    const actor = { org_id: orgId, user_id: ownerId, sid: uuid(), access_expires_at: Date.now() + 60_000 };
    const { enumerateRestoreAccess, RESTORE_GRANT_KINDS } = await import('../src/lib/app-restore-access-context.js');
    const { RESTORE_GRANT_HANDLERS } = await import('../src/lib/app-restore-access-service.js');

    assert.deepEqual(RESTORE_GRANT_KINDS, ['record_consent', 'observation_consent', 'action_consent', 'capture_policy', 'agent_policy_default', 'defty_read_grant']);

    const enumeration = await enumerateRestoreAccess(db, actor as never, { installation_id: installationId, target_key: targetKey });
    const kinds = enumeration.grants.map((grant) => grant.kind);
    assert.ok(kinds.includes('agent_policy_default'), 'agent_policy_default is listed');
    assert.ok(kinds.includes('defty_read_grant'), 'defty_read_grant is listed');
    const defty = enumeration.grants.find((grant) => grant.kind === 'defty_read_grant')!;
    const policyDefault = enumeration.grants.find((grant) => grant.kind === 'agent_policy_default')!;
    assert.equal(defty.store_key, 'drafts');
    assert.equal(defty.preselected, false, 'no prior read grant → unselected');
    assert.equal(policyDefault.action_key, 'mirror_drafts');
    assert.equal(policyDefault.preselected, false, 'no prior policy → unselected');

    // Activate only the two defaults → seeds a read-only grant + require_approval.
    const grantRecord = { ...record, account: { account_ref: accountRef, label: 'Synthetic account' } } as never;
    const deftyGrant = { grant_id: defty.grant_id, kind: 'defty_read_grant', store_key: 'drafts', state: 'active', lifetime: defty.lifetime, restorable: true, preselected: false };
    const policyGrant = { grant_id: policyDefault.grant_id, kind: 'agent_policy_default', action_key: 'mirror_drafts', state: 'active', lifetime: policyDefault.lifetime, restorable: true, preselected: false };

    await db.transaction(async (tx) => {
      await RESTORE_GRANT_HANDLERS.get('defty_read_grant')!({ transaction: tx as never, actor: actor as never, record: grantRecord, grant: deftyGrant as never, now: Date.now(), reservedActionKeys: new Set() });
    });
    const grants = await client.query('SELECT operations, principal_kind FROM app_integration_principal_grants WHERE org_id = $1', [orgId]);
    assert.equal(grants.rows.length, 1);
    assert.deepEqual(grants.rows[0].operations, ['read'], 'read-only, never draft/send');
    assert.equal(grants.rows[0].principal_kind, 'defty');

    // require_approval needs a current runtime binding for the action key.
    const bindingId = uuid();
    await client.query(`INSERT INTO app_runtime_bindings (id, org_id, app_installation_id, owner_resource_binding_id, action_key, state) VALUES ($1, $2, $3, $4, 'mirror_drafts', 'active')`, [bindingId, orgId, installationId, binding]);
    await db.transaction(async (tx) => {
      await RESTORE_GRANT_HANDLERS.get('agent_policy_default')!({ transaction: tx as never, actor: actor as never, record: grantRecord, grant: policyGrant as never, now: Date.now(), reservedActionKeys: new Set() });
    });
    const policies = await client.query('SELECT mode FROM app_runtime_agent_policies WHERE org_id = $1', [orgId]);
    assert.equal(policies.rows.length, 1);
    assert.equal(policies.rows[0].mode, 'require_approval', 'require_approval, never auto-allow');
  });
