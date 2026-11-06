import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

// The live-grant case relies on "no AI provider configured" pausing the job.
// CI sets a dummy ANTHROPIC_API_KEY, so clear every provider before the app
// modules (imported dynamically below) read env.
for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'OLLAMA_URL']) delete process.env[key];

/** §3.2 — retire a capture policy whose account grant has ended, instead of
 * retrying forever, and surface a visible owner notice. Real PostgreSQL proof
 * against the disposable deft_test database (the brief's 127.0.0.1:55520, or
 * 5432 when that is down). */
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
});
after(async () => { await pool.end(); });

const keys = { current: () => ({ key_id: 'test', key: Buffer.alloc(32, 7) }), read: () => ({ key_id: 'test', key: Buffer.alloc(32, 7) }), keyIds: () => ['test'] };

/** The full schema enforces org, owner and (org, installation) foreign keys. */
async function seedTenant(client: pg.Pool, org: string, owner: string, installation: string) {
  await client.query('INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING', [org, 'Org ' + org, 'org-' + org]);
  await client.query('INSERT INTO users (id, name, kind) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING', [owner, 'Owner ' + owner, 'human']);
  await client.query(`INSERT INTO app_installations (id, org_id, app_id, lineage_key, lineage_authority_type, lineage_authority_id,
    source, state, installed_by_actor_type, installed_by_actor_id, updated_by_actor_type, updated_by_actor_id)
    VALUES ($1, $2, $3, $4, 'local_user', $5, 'local', 'staged', 'human', $5, 'human', $5) ON CONFLICT DO NOTHING`,
    [installation, org, 'community.deft.capture-' + installation, 'local:' + installation, owner]);
}

async function seedPolicy(client: pg.Pool) {
  const org = randomUUID(), owner = randomUUID(), installation = randomUUID();
  const policyId = randomUUID();
  const account_ref = 'acct_' + randomUUID().replaceAll('-', '');
  await seedTenant(client, org, owner, installation);
  await client.query(`INSERT INTO app_integration_capture_policies
    (id, org_id, owner_user_id, installation_id, account_ref, store_key, revision, enabled, input, history_since)
    VALUES ($1,$2,$3,$4,$5,$6,1,true,$7::jsonb,$8) ON CONFLICT (id) DO NOTHING`,
    [policyId, org, owner, installation, account_ref, 'compose',
      JSON.stringify({ destination: { scope: 'user', space_id: null }, history_days: 30, include_bulk: false, excluded_senders: [], excluded_folders: [] }),
      new Date().toISOString()]);
  return { org, owner, installation, policyId, account_ref };
}

async function seedJob(client: pg.Pool, org: string, policyId: string, revision: number, lockToken: string) {
  // A unique job per test: other test files share this database concurrently.
  const jobId = randomUUID();
  await client.query(`INSERT INTO job_queue (id, org_id, queue, name, data, status, lock_token, lock_expires_at)
    VALUES ($1, $2, 'scheduled-jobs', 'app-integration-knowledge', $3::jsonb, 'running', $4, now() + interval '10 minutes')
`,
    [jobId, org, JSON.stringify({ policy_id: policyId, policy_revision: revision }), lockToken]);
  return jobId;
}

test('an ended account grant retires the policy and emits exactly one owner notice', { skip: !safe, timeout: 120000 }, async () => {
  const { AppError } = await import('../src/lib/app-errors.js');
  const { createAppIntegrationCaptureRuntime } = await import('../src/lib/app-integration-capture-runtime.js');
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const { default: schema } = await import('@deft/db/schema');

  const database = drizzle(pool, { schema });
  const transaction = <T>(fn: (tx: Parameters<Parameters<typeof database.transaction>[0]>[0]) => Promise<T>) => database.transaction(fn as any);

  const seeded = await seedPolicy(pool);
  const lockToken = 'owned-lock';
  const jobId = await seedJob(pool, seeded.org, seeded.policyId, 1, lockToken);

  const gateway = {
    currentAccount: async () => { throw new AppError('App data access ended', 'APP_ACCESS_DENIED', 403); },
    mint: async () => { throw new Error('not used'); },
    dispatch: async () => { throw new Error('not used'); },
  };
  const runtime = createAppIntegrationCaptureRuntime({ transaction, keys, gateway });

  const job = { id: jobId, name: 'app-integration-knowledge', attempts: 1, lockToken, data: { policy_id: seeded.policyId, policy_revision: 1 }, signal: new AbortController().signal };
  // A terminal grant failure must resolve (not throw RetryLaterJobError).
  await runtime.run(job as any);

  const [row] = (await pool.query('SELECT enabled, retired_reason, retired_at, last_error FROM app_integration_capture_policies WHERE id = $1', [seeded.policyId])).rows;
  assert.equal(row.enabled, false);
  assert.equal(row.retired_reason, 'grant_ended');
  assert.ok(row.retired_at);
  assert.equal(row.last_error, 'App data access ended');

  // The delivery loop must not re-arm a retired policy: no pending re-enqueue.
  const pending = (await pool.query("SELECT count(*)::int AS n FROM job_queue WHERE name = 'app-integration-knowledge' AND status = 'pending' AND org_id = $1", [seeded.org])).rows[0].n;
  assert.equal(pending, 0);

  const notices = (await pool.query('SELECT type, title, metadata FROM notifications WHERE org_id = $1', [seeded.org])).rows;
  assert.equal(notices.length, 1);
  assert.equal(notices[0].type, 'system');
  assert.equal(notices[0].metadata.kind, 'app_integration_capture_retired');
  assert.equal(notices[0].metadata.capture_policy_id, seeded.policyId);
});

test('a live account grant is never retired', { skip: !safe, timeout: 120000 }, async () => {
  const { createAppIntegrationCaptureRuntime } = await import('../src/lib/app-integration-capture-runtime.js');
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const { default: schema } = await import('@deft/db/schema');
  const { RetryLaterJobError } = await import('../src/lib/queues.js');

  const database = drizzle(pool, { schema });
  const transaction = <T>(fn: (tx: Parameters<Parameters<typeof database.transaction>[0]>[0]) => Promise<T>) => database.transaction(fn as any);

  const seeded = await seedPolicy(pool);
  const lockToken = 'live-lock';
  const jobId = await seedJob(pool, seeded.org, seeded.policyId, 1, lockToken);

  const gateway = {
    currentAccount: async () => ({ identity: 'live', expires_at: Date.now() + 60_000, resource_binding_id: id(6), resource_key: 'mail' }),
    mint: async () => { throw new Error('not used'); },
    dispatch: async () => { throw new Error('not used'); },
  };
  const runtime = createAppIntegrationCaptureRuntime({ transaction, keys, gateway });
  const job = { id: jobId, name: 'app-integration-knowledge', attempts: 1, lockToken, data: { policy_id: seeded.policyId, policy_revision: 1 }, signal: new AbortController().signal };

  // No AI provider configured: the healthy steady-state pauses via RetryLaterJobError.
  await assert.rejects(runtime.run(job as any), (error: unknown) => error instanceof RetryLaterJobError);

  const [row] = (await pool.query('SELECT enabled, retired_reason FROM app_integration_capture_policies WHERE id = $1', [seeded.policyId])).rows;
  assert.equal(row.enabled, true);
  assert.equal(row.retired_reason, null);
});
