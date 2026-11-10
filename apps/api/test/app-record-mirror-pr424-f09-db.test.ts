import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mock } from 'node:test';
import { canonicalAppDataJson } from '@deft/app-kit/core';

// PR #424 review F09, end to end through the real approval resolver. Kept in
// its own file so no earlier module mock is cached into the service under test.
const uuid = () => randomUUID();
const digest = (value: unknown) => 'sha256:' + createHash('sha256').update(canonicalAppDataJson(value)).digest('hex');
const policy = () => ({ key: 'saved_drafts', action_key: 'mirror_drafts', max_authority_seconds: 3600, max_attempts_per_day: 3 });
function nominationRaw(installationId: string) {
  return {
    connection_session_id: uuid(), store_key: 'drafts', mirror_key: 'saved_drafts', record_id: uuid(),
    request_id: uuid(), expected_revision: 0, expires_at: new Date(Date.now() + 3600_000).toISOString(), max_attempts_per_day: 1,
    account_ref: 'account_1', installation_id: installationId, policy_digest: digest(policy()),
  };
}
function currentFor(installationId: string) {
  return {
    scope: { target_key: 'primary', installation_id: installationId },
    connection: { account_ref: 'account_1' },
    store: { key: 'drafts', record_mirrors: [policy()] },
    consent: { consent_id: uuid() },
  };
}
const dbTarget = process.env.DATABASE_URL;
const dbSafe = (() => {
  if (!dbTarget) return false;
  try {
    const url = new URL(dbTarget);
    return ['postgres:', 'postgresql:'].includes(url.protocol)
      && ['127.0.0.1', 'localhost'].includes(url.hostname)
      && /^\/deft_test/u.test(url.pathname) && !url.search && !url.hash;
  } catch { return false; }
})();

test('PR424-F09: inbox approval from a browser that never opened the app leaves the nomination pending',
  { skip: !dbSafe, timeout: 120000 }, async (t) => {
    const pg = await import('pg');
    const client = new pg.Client({ connectionString: dbTarget! });
    await client.connect();
    const orgId = uuid(), ownerId = uuid(), actionId = uuid(), installationId = uuid();
    const params = nominationRaw(installationId);
    // Only the owner's data authority and runtime keys are stubbed; the real
    // resolver, real approveRecordMirrorNomination and the real experience
    // session lookup against app_experience_sessions all run.
    const lib = (name: string) => new URL(`../src/lib/${name}.ts`, import.meta.url).href;
    const realRuntime = await import('../src/lib/app-run-runtime.js');
    const realData = await import('../src/lib/app-data-service.js');
    const realExposure = await import('../src/lib/app-experience-exposure.js');
    let reviews = 0;
    mock.module(lib('app-run-runtime'), { namedExports: { ...realRuntime, getAppRunRuntime: async () => ({ keys: {} }) } });
    mock.module(lib('app-data-service'), { namedExports: { ...realData, AppDataService: class { constructor(readonly caller: unknown) {} async current() { return currentFor(installationId); } } } });
    mock.module(lib('app-experience-exposure'), { namedExports: { ...realExposure, AppExperienceExposureService: class { withHumanAction() { reviews += 1; throw new Error('review must not run'); } } } });
    t.after(async () => {
      await client.query('DELETE FROM agent_actions WHERE org_id = $1', [orgId]).catch(() => {});
      await client.query('DELETE FROM web_sessions WHERE org_id = $1', [orgId]).catch(() => {});
      await client.query('DELETE FROM org_members WHERE org_id = $1', [orgId]).catch(() => {});
      await client.query('DELETE FROM users WHERE id = $1', [ownerId]).catch(() => {});
      await client.query('DELETE FROM orgs WHERE id = $1', [orgId]).catch(() => {});
      await client.end();
      mock.restoreAll();
    });
    await client.query(`INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)`, [orgId, 'Mirror F09 Org', 'mirror-f09-' + orgId]);
    await client.query(`INSERT INTO users (id, email, name, is_agent) VALUES ($1, $2, $3, false)`, [ownerId, 'owner-' + ownerId + '@test.local', 'Owner']);
    await client.query(`INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES ($1, $2, $3, 'owner', true)`, [uuid(), orgId, ownerId]);
    const ownerSid = uuid();
    await client.query(`INSERT INTO web_sessions (id, user_id, org_id, refresh_token_hash, expires_at) VALUES ($1, $2, $3, $4, now() + interval '1 day')`, [ownerSid, ownerId, orgId, 'a'.repeat(64)]);
    await client.query(`INSERT INTO agent_actions (id, org_id, user_id, source, action, params, approval_tier, approval_status) VALUES ($1, $2, $3, 'app_record_mirror', 'app_record_mirror_nominate', $4::jsonb, 'full', 'pending')`, [actionId, orgId, ownerId, JSON.stringify(params)]);

    const { approveAction } = await import('../src/lib/agent-approval-resolver.js');
    const result = await approveAction(actionId, ownerId, { humanWebSessionId: ownerSid });
    assert.equal(result.status, 'error');
    assert.equal(reviews, 0, 'no review runs without an open app experience');
    const row = await client.query('SELECT approval_status, error, approved_at, approved_by_user_id, executed_at, result FROM agent_actions WHERE id = $1', [actionId]);
    assert.equal(row.rows[0].approval_status, 'pending', 'a failed browser precondition must not expire the nomination');
    assert.match(String(row.rows[0].error), /Open this app/u, 'the owner is told how to proceed');
    assert.equal(row.rows[0].approved_at, null);
    assert.equal(row.rows[0].approved_by_user_id, null);
    assert.equal(row.rows[0].executed_at, null);
    assert.equal(row.rows[0].result, null);
  });
