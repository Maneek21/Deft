import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

/** §3.3 — expose capture health (healthy / grant_ended / never_enabled) without
 * leaking the ended-grant state as a bare 403, and keep it tenant-scoped. */
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

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const pool = new pg.Pool({ connectionString: safe ? target : undefined, max: 8 });

before(async () => {
  if (!safe) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS app_integration_capture_policies (
    id text PRIMARY KEY, org_id text NOT NULL, owner_user_id text NOT NULL,
    installation_id text NOT NULL, account_ref text NOT NULL, store_key text NOT NULL,
    revision integer NOT NULL CHECK (revision > 0), enabled boolean NOT NULL DEFAULT false,
    input jsonb NOT NULL, history_since timestamptz NOT NULL,
    scan_checkpoint_id text, scan_after_projection_id text,
    retired_at timestamptz, retired_reason text, last_error text,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS app_integration_capture_claims (
    id text PRIMARY KEY, org_id text NOT NULL, owner_user_id text NOT NULL,
    installation_id text NOT NULL, account_ref text NOT NULL, store_key text NOT NULL,
    policy_id text NOT NULL, policy_revision integer NOT NULL,
    thread_key text NOT NULL, body_digest text NOT NULL, target jsonb NOT NULL,
    state text NOT NULL DEFAULT 'processing', page_id text, error_code text,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`);
});
after(async () => { await pool.end(); });

const keys = { current: () => ({ key_id: 'test', key: Buffer.alloc(32, 7) }), read: () => ({ key_id: 'test', key: Buffer.alloc(32, 7) }), keyIds: () => ['test'] };

function makeRuntime(throwDenied: boolean) {
  const gateway = {
    currentAccount: async () => { if (throwDenied) throw new (await import('../src/lib/app-errors.js')).AppError('App data access ended', 'APP_ACCESS_DENIED', 403); return { identity: 'live', expires_at: Date.now() + 60_000, resource_binding_id: id(6), resource_key: 'mail' }; },
    mint: async () => { throw new Error('not used'); },
    dispatch: async () => { throw new Error('not used'); },
  };
  return gateway;
}

/** The full schema enforces org, owner and (org, installation) foreign keys. */
async function seedTenant(client: pg.Pool, org: string, owner: string, installation: string) {
  await client.query('INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING', [org, 'Org ' + org, 'org-' + org]);
  await client.query('INSERT INTO users (id, name, kind) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING', [owner, 'Owner ' + owner, 'human']);
  await client.query(`INSERT INTO app_installations (id, org_id, app_id, lineage_key, lineage_authority_type, lineage_authority_id,
    source, state, installed_by_actor_type, installed_by_actor_id, updated_by_actor_type, updated_by_actor_id)
    VALUES ($1, $2, $3, $4, 'local_user', $5, 'local', 'staged', 'human', $5, 'human', $5) ON CONFLICT DO NOTHING`,
    [installation, org, 'community.deft.capture-' + installation, 'local:' + installation, owner]);
}

async function seedPolicy(client: pg.Pool, overrides: Record<string, unknown> = {}) {
  const org = randomUUID(), owner = randomUUID(), installation = randomUUID();
  const policyId = randomUUID();
  const account_ref = 'acct_' + randomUUID().replaceAll('-', '');
  const row = {
    id: policyId, org_id: org, owner_user_id: owner, installation_id: installation,
    account_ref, store_key: 'compose', revision: 1, enabled: true,
    retired_reason: null as string | null, retired_at: null as string | null, last_error: null as string | null,
    ...overrides,
  };
  await seedTenant(client, String(row.org_id), String(row.owner_user_id), String(row.installation_id));
  await client.query(`INSERT INTO app_integration_capture_policies
    (id, org_id, owner_user_id, installation_id, account_ref, store_key, revision, enabled, input, history_since, retired_at, retired_reason, last_error)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13) ON CONFLICT (id) DO NOTHING`,
    [row.id, row.org_id, row.owner_user_id, row.installation_id, row.account_ref, row.store_key, row.revision, row.enabled,
      JSON.stringify({ destination: { scope: 'user', space_id: null }, history_days: 30, include_bulk: false, excluded_senders: [], excluded_folders: [] }),
      new Date().toISOString(), row.retired_at, row.retired_reason, row.last_error]);
  return { org, owner, installation, policyId, account_ref };
}

test('capture health reports healthy, grant_ended and never_enabled with tenant scoping', { skip: !safe, timeout: 120000 }, async () => {
  const { createAppIntegrationCaptureRuntime } = await import('../src/lib/app-integration-capture-runtime.js');
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const { default: schema } = await import('@deft/db/schema');

  const database = drizzle(pool, { schema });
  const transaction = <T>(fn: (tx: Parameters<Parameters<typeof database.transaction>[0]>[0]) => Promise<T>) => database.transaction(fn as any);

  const live = await seedPolicy(pool);
  const retired = await seedPolicy(pool, { enabled: false, retired_reason: 'grant_ended' });

  const liveIdentity = { installation_id: live.installation, account_ref: live.account_ref, store_key: 'compose' };
  const retiredIdentity = { installation_id: retired.installation, account_ref: retired.account_ref, store_key: 'compose' };

  const healthyRuntime = createAppIntegrationCaptureRuntime({ transaction, keys, gateway: makeRuntime(false) as any });
  const healthy = await healthyRuntime.health({ org_id: live.org, user_id: live.owner, kind: 'human', principal_id: live.owner }, liveIdentity as any);
  assert.equal(healthy.account_grant_active, true);
  assert.equal(healthy.state, 'healthy');

  const endedRuntime = createAppIntegrationCaptureRuntime({ transaction, keys, gateway: makeRuntime(true) as any });
  const ended = await endedRuntime.health({ org_id: live.org, user_id: live.owner, kind: 'human', principal_id: live.owner }, liveIdentity as any);
  assert.equal(ended.account_grant_active, false);
  assert.equal(ended.state, 'grant_ended');

  // A retired policy stays grant_ended even when probed under a live grant.
  const retiredHealthy = await healthyRuntime.health({ org_id: retired.org, user_id: retired.owner, kind: 'human', principal_id: retired.owner }, retiredIdentity as any);
  assert.equal(retiredHealthy.state, 'grant_ended');

  // No policy at all → never_enabled.
  const emptyRuntime = createAppIntegrationCaptureRuntime({ transaction, keys, gateway: makeRuntime(false) as any });
  const empty = await emptyRuntime.health({ org_id: randomUUID(), user_id: randomUUID(), kind: 'human', principal_id: randomUUID() }, { installation_id: randomUUID(), account_ref: 'acct_none', store_key: 'compose' } as any);
  assert.equal(empty.state, 'never_enabled');

  // Cross-tenant: another org never observes this org's capture state.
  const foreign = await healthyRuntime.health({ org_id: randomUUID(), user_id: live.owner, kind: 'human', principal_id: live.owner }, liveIdentity as any);
  assert.equal(foreign.state, 'never_enabled');
});
