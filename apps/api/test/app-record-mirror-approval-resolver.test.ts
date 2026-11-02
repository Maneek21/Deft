import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mock } from 'node:test';
import { canonicalAppDataJson } from '@deft/app-kit/core';

const uuid = () => randomUUID();
const digest = (value: unknown) => 'sha256:' + createHash('sha256').update(canonicalAppDataJson(value)).digest('hex');
const policy = () => ({ key: 'saved_drafts', action_key: 'mirror_drafts', max_authority_seconds: 3600, max_attempts_per_day: 3 });

const target = process.env.DATABASE_URL;
const safe = (() => {
  if (!target) return false;
  try {
    const url = new URL(target);
    return ['postgres:', 'postgresql:'].includes(url.protocol)
      && ['127.0.0.1', 'localhost'].includes(url.hostname)
      && /^\/deft_test/u.test(url.pathname) && !url.search && !url.hash;
  } catch { return false; }
})();

test('record-mirror nominations resolve owner-only, idempotently, and reject without a receipt',
  { skip: !safe, timeout: 120000 }, async (t) => {
    const pg = await import('pg');
    const client = new pg.Client({ connectionString: target! });
    await client.connect();

    const orgId = uuid(), ownerId = uuid(), memberId = uuid();
    const actionId = uuid();
    const params = { connection_session_id: uuid(), store_key: 'drafts', mirror_key: 'saved_drafts', record_id: uuid(), request_id: uuid(), expected_revision: 0, expires_at: new Date(Date.now() + 3600_000).toISOString(), max_attempts_per_day: 1, account_ref: 'account_1', installation_id: uuid(), policy_digest: digest(policy()) };

    let approvals = 0;
    const receipt = { receipt_id: 'receipt-1', schema_version: 'deft.app_record_mirror_status.v1' };
    mock.module(new URL('../src/lib/app-record-mirror-service.ts', import.meta.url).href, {
      namedExports: {
        approveRecordMirrorNomination: async () => { approvals += 1; return receipt; },
      },
    });

    t.after(async () => {
      await client.query('DELETE FROM action_receipts WHERE org_id = $1', [orgId]).catch(() => {});
      await client.query('DELETE FROM attention_items WHERE org_id = $1', [orgId]).catch(() => {});
      await client.query('DELETE FROM agent_actions WHERE org_id = $1', [orgId]).catch(() => {});
      await client.query('DELETE FROM web_sessions WHERE org_id = $1', [orgId]).catch(() => {});
      await client.query('DELETE FROM org_members WHERE org_id = $1', [orgId]).catch(() => {});
      await client.query('DELETE FROM users WHERE id = ANY($1)', [[ownerId, memberId]]).catch(() => {});
      await client.query('DELETE FROM orgs WHERE id = $1', [orgId]).catch(() => {});
      await client.end();
      mock.restoreAll();
    });

    await client.query(`INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)`, [orgId, 'Mirror Resolver Org', 'mirror-resolver-' + orgId]);
    await client.query(`INSERT INTO users (id, email, name, is_agent) VALUES ($1, $2, $3, false), ($4, $5, $6, false)`, [ownerId, 'owner-' + ownerId + '@test.local', 'Owner', memberId, 'member-' + memberId + '@test.local', 'Member']);
    await client.query(`INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES ($1, $2, $3, 'owner', true), ($4, $5, $6, 'member', true)`, [uuid(), orgId, ownerId, uuid(), orgId, memberId]);
    await client.query(`INSERT INTO web_sessions (id, user_id, org_id, refresh_token_hash, expires_at) VALUES ($1, $2, $3, $4, now() + interval '1 day')`, [uuid(), ownerId, orgId, 'a'.repeat(64)]);
    await client.query(`INSERT INTO agent_actions (id, org_id, user_id, source, action, params, approval_tier, approval_status) VALUES ($1, $2, $3, 'app_record_mirror', 'app_record_mirror_nominate', $4::jsonb, 'full', 'pending')`, [actionId, orgId, ownerId, JSON.stringify(params)]);

    const { approveAction, rejectAction } = await import('../src/lib/agent-approval-resolver.js');

    const denied = await approveAction(actionId, memberId);
    assert.equal(denied.status, 'error');
    assert.equal((denied as { code: string }).code, 'FORBIDDEN');

    const approved = await approveAction(actionId, ownerId);
    assert.equal(approved.status, 'approved', JSON.stringify(approved));
    assert.equal(approvals, 1, 'approveRecordMirrorNomination ran exactly once');
    const row = await client.query('SELECT approval_status, executed_at, result, error FROM agent_actions WHERE id = $1', [actionId]);
    assert.equal(row.rows[0].approval_status, 'approved');
    assert.equal(row.rows[0].error, null);
    assert.deepEqual(row.rows[0].result, receipt);

    const again = await approveAction(actionId, ownerId);
    assert.equal(again.status, 'approved');
    assert.equal(approvals, 1, 'a second approve does not re-issue a receipt');

    const secondId = uuid();
    await client.query(`INSERT INTO agent_actions (id, org_id, user_id, source, action, params, approval_tier, approval_status) VALUES ($1, $2, $3, 'app_record_mirror', 'app_record_mirror_nominate', $4::jsonb, 'full', 'pending')`, [secondId, orgId, ownerId, JSON.stringify(params)]);
    const rejected = await rejectAction(secondId, ownerId, 'not now');
    assert.equal(rejected.status, 'rejected');
    assert.equal(approvals, 1, 'reject never issues a mirror receipt');
    const rejectedRow = await client.query('SELECT approval_status, result FROM agent_actions WHERE id = $1', [secondId]);
    assert.equal(rejectedRow.rows[0].approval_status, 'rejected');
    assert.equal(rejectedRow.rows[0].result, null);
  });
