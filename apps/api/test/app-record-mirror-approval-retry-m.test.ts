import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mock } from 'node:test';
import { canonicalAppDataJson } from '@deft/app-kit/core';
import { AppError } from '../src/lib/app-errors.js';

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
      && /^\/(deft_test|fix424_m_test)$/u.test(url.pathname) && !url.search && !url.hash;
  } catch { return false; }
})();

test('M retry: transient failure then retry succeeds with one receipt',
  { skip: !safe, timeout: 120000 }, async (t) => {
    const pg = await import('pg');
    const client = new pg.Client({ connectionString: target! });
    await client.connect();

    const orgId = uuid(), ownerId = uuid();
    const actionId = uuid();
    const params = { connection_session_id: uuid(), store_key: 'drafts', mirror_key: 'saved_drafts', record_id: uuid(), request_id: uuid(), expected_revision: 0, expires_at: new Date(Date.now() + 3600_000).toISOString(), max_attempts_per_day: 1, account_ref: 'account_1', installation_id: uuid(), policy_digest: digest(policy()) };

    let approvals = 0;
    const receipt = { receipt_id: 'receipt-1', schema_version: 'deft.app_record_mirror_status.v1' };
    mock.module(new URL('../src/lib/app-record-mirror-service.ts', import.meta.url).href, {
      namedExports: {
        approveRecordMirrorNomination: async () => {
          approvals += 1;
          if (approvals === 1) { const e = new Error('transient boom'); (e as { phase?: string }).phase = 'review'; throw e; }
          return receipt;
        },
      },
    });

    t.after(async () => {
      await client.query('DELETE FROM agent_actions WHERE org_id = $1', [orgId]).catch(() => {});
      await client.query('DELETE FROM web_sessions WHERE org_id = $1', [orgId]).catch(() => {});
      await client.query('DELETE FROM org_members WHERE org_id = $1', [orgId]).catch(() => {});
      await client.query('DELETE FROM users WHERE id = $1', [ownerId]).catch(() => {});
      await client.query('DELETE FROM orgs WHERE id = $1', [orgId]).catch(() => {});
      await client.end();
      mock.restoreAll();
    });

    await client.query(`INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)`, [orgId, 'Mirror Retry Org', 'mirror-retry-' + orgId]);
    await client.query(`INSERT INTO users (id, email, name, is_agent) VALUES ($1, $2, $3, false)`, [ownerId, 'owner-' + ownerId + '@test.local', 'Owner']);
    await client.query(`INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES ($1, $2, $3, 'owner', true)`, [uuid(), orgId, ownerId]);
    const ownerSid = uuid();
    await client.query(`INSERT INTO web_sessions (id, user_id, org_id, refresh_token_hash, expires_at) VALUES ($1, $2, $3, $4, now() + interval '1 day')`, [ownerSid, ownerId, orgId, 'a'.repeat(64)]);
    await client.query(`INSERT INTO agent_actions (id, org_id, user_id, source, action, params, approval_tier, approval_status) VALUES ($1, $2, $3, 'app_record_mirror', 'app_record_mirror_nominate', $4::jsonb, 'full', 'pending')`, [actionId, orgId, ownerId, JSON.stringify(params)]);

    const { approveAction } = await import('../src/lib/agent-approval-resolver.js');

    const first = await approveAction(actionId, ownerId, { humanWebSessionId: ownerSid });
    assert.equal(first.status, 'error');
    const row1 = await client.query('SELECT approval_status, error, approved_at, approved_by_user_id FROM agent_actions WHERE id = $1', [actionId]);
    assert.equal(row1.rows[0].approval_status, 'pending');
    assert.ok(row1.rows[0].error);
    assert.equal(row1.rows[0].approved_at, null);
    assert.equal(row1.rows[0].approved_by_user_id, null);

    const second = await approveAction(actionId, ownerId, { humanWebSessionId: ownerSid });
    assert.equal(second.status, 'approved');
    assert.equal(approvals, 2);
    const row2 = await client.query('SELECT approval_status, result FROM agent_actions WHERE id = $1', [actionId]);
    assert.equal(row2.rows[0].approval_status, 'approved');
    assert.deepEqual(row2.rows[0].result, receipt);
  });

test('M retry: permanent failure is terminal',
  { skip: !safe, timeout: 120000 }, async (t) => {
    const pg = await import('pg');
    const client = new pg.Client({ connectionString: target! });
    await client.connect();

    const orgId = uuid(), ownerId = uuid();
    const actionId = uuid();
    const params = { connection_session_id: uuid(), store_key: 'drafts', mirror_key: 'saved_drafts', record_id: uuid(), request_id: uuid(), expected_revision: 0, expires_at: new Date(Date.now() + 3600_000).toISOString(), max_attempts_per_day: 1, account_ref: 'account_1', installation_id: uuid(), policy_digest: digest(policy()) };

    mock.module(new URL('../src/lib/app-record-mirror-service.ts', import.meta.url).href, {
      namedExports: {
        approveRecordMirrorNomination: async () => { throw new AppError('App data access ended', 'APP_ACCESS_DENIED', 403); },
      },
    });

    t.after(async () => {
      await client.query('DELETE FROM agent_actions WHERE org_id = $1', [orgId]).catch(() => {});
      await client.query('DELETE FROM web_sessions WHERE org_id = $1', [orgId]).catch(() => {});
      await client.query('DELETE FROM org_members WHERE org_id = $1', [orgId]).catch(() => {});
      await client.query('DELETE FROM users WHERE id = $1', [ownerId]).catch(() => {});
      await client.query('DELETE FROM orgs WHERE id = $1', [orgId]).catch(() => {});
      await client.end();
      mock.restoreAll();
    });

    await client.query(`INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)`, [orgId, 'Mirror Perm Org', 'mirror-perm-' + orgId]);
    await client.query(`INSERT INTO users (id, email, name, is_agent) VALUES ($1, $2, $3, false)`, [ownerId, 'owner-' + ownerId + '@test.local', 'Owner']);
    await client.query(`INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES ($1, $2, $3, 'owner', true)`, [uuid(), orgId, ownerId]);
    const ownerSid = uuid();
    await client.query(`INSERT INTO web_sessions (id, user_id, org_id, refresh_token_hash, expires_at) VALUES ($1, $2, $3, $4, now() + interval '1 day')`, [ownerSid, ownerId, orgId, 'a'.repeat(64)]);
    await client.query(`INSERT INTO agent_actions (id, org_id, user_id, source, action, params, approval_tier, approval_status) VALUES ($1, $2, $3, 'app_record_mirror', 'app_record_mirror_nominate', $4::jsonb, 'full', 'pending')`, [actionId, orgId, ownerId, JSON.stringify(params)]);

    const { approveAction } = await import('../src/lib/agent-approval-resolver.js');

    const first = await approveAction(actionId, ownerId, { humanWebSessionId: ownerSid });
    assert.equal(first.status, 'error');
    const row1 = await client.query('SELECT approval_status, error FROM agent_actions WHERE id = $1', [actionId]);
    assert.equal(row1.rows[0].approval_status, 'expired');
    assert.ok(row1.rows[0].error);

    // retry returns error, no receipt
    const second = await approveAction(actionId, ownerId, { humanWebSessionId: ownerSid });
    assert.equal(second.status, 'error');
  });

test('M retry: double approve after success returns same receipt',
  { skip: !safe, timeout: 120000 }, async (t) => {
    const pg = await import('pg');
    const client = new pg.Client({ connectionString: target! });
    await client.connect();

    const orgId = uuid(), ownerId = uuid();
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
      await client.query('DELETE FROM agent_actions WHERE org_id = $1', [orgId]).catch(() => {});
      await client.query('DELETE FROM web_sessions WHERE org_id = $1', [orgId]).catch(() => {});
      await client.query('DELETE FROM org_members WHERE org_id = $1', [orgId]).catch(() => {});
      await client.query('DELETE FROM users WHERE id = $1', [ownerId]).catch(() => {});
      await client.query('DELETE FROM orgs WHERE id = $1', [orgId]).catch(() => {});
      await client.end();
      mock.restoreAll();
    });

    await client.query(`INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)`, [orgId, 'Mirror Double Org', 'mirror-double-' + orgId]);
    await client.query(`INSERT INTO users (id, email, name, is_agent) VALUES ($1, $2, $3, false)`, [ownerId, 'owner-' + ownerId + '@test.local', 'Owner']);
    await client.query(`INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES ($1, $2, $3, 'owner', true)`, [uuid(), orgId, ownerId]);
    const ownerSid = uuid();
    await client.query(`INSERT INTO web_sessions (id, user_id, org_id, refresh_token_hash, expires_at) VALUES ($1, $2, $3, $4, now() + interval '1 day')`, [ownerSid, ownerId, orgId, 'a'.repeat(64)]);
    await client.query(`INSERT INTO agent_actions (id, org_id, user_id, source, action, params, approval_tier, approval_status) VALUES ($1, $2, $3, 'app_record_mirror', 'app_record_mirror_nominate', $4::jsonb, 'full', 'pending')`, [actionId, orgId, ownerId, JSON.stringify(params)]);

    const { approveAction } = await import('../src/lib/agent-approval-resolver.js');

    const first = await approveAction(actionId, ownerId, { humanWebSessionId: ownerSid });
    assert.equal(first.status, 'approved');
    const second = await approveAction(actionId, ownerId, { humanWebSessionId: ownerSid });
    assert.equal(second.status, 'approved');
    assert.equal(approvals, 1, 'no re-issue');
    assert.deepEqual((second as { result: unknown }).result, receipt);
  });

test('M retry: approve by another member is FORBIDDEN',
  { skip: !safe, timeout: 120000 }, async (t) => {
    const pg = await import('pg');
    const client = new pg.Client({ connectionString: target! });
    await client.connect();

    const orgId = uuid(), ownerId = uuid(), memberId = uuid();
    const actionId = uuid();
    const params = { connection_session_id: uuid(), store_key: 'drafts', mirror_key: 'saved_drafts', record_id: uuid(), request_id: uuid(), expected_revision: 0, expires_at: new Date(Date.now() + 3600_000).toISOString(), max_attempts_per_day: 1, account_ref: 'account_1', installation_id: uuid(), policy_digest: digest(policy()) };

    mock.module(new URL('../src/lib/app-record-mirror-service.ts', import.meta.url).href, {
      namedExports: {
        approveRecordMirrorNomination: async () => ({ receipt_id: 'r' }),
      },
    });

    t.after(async () => {
      await client.query('DELETE FROM agent_actions WHERE org_id = $1', [orgId]).catch(() => {});
      await client.query('DELETE FROM web_sessions WHERE org_id = $1', [orgId]).catch(() => {});
      await client.query('DELETE FROM org_members WHERE org_id = $1', [orgId]).catch(() => {});
      await client.query('DELETE FROM users WHERE id = ANY($1)', [[ownerId, memberId]]).catch(() => {});
      await client.query('DELETE FROM orgs WHERE id = $1', [orgId]).catch(() => {});
      await client.end();
      mock.restoreAll();
    });

    await client.query(`INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)`, [orgId, 'Mirror Perm2 Org', 'mirror-perm2-' + orgId]);
    await client.query(`INSERT INTO users (id, email, name, is_agent) VALUES ($1, $2, $3, false), ($4, $5, $6, false)`, [ownerId, 'owner-' + ownerId + '@test.local', 'Owner', memberId, 'member-' + memberId + '@test.local', 'Member']);
    await client.query(`INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES ($1, $2, $3, 'owner', true), ($4, $5, $6, 'member', true)`, [uuid(), orgId, ownerId, uuid(), orgId, memberId]);
    const ownerSid = uuid();
    await client.query(`INSERT INTO web_sessions (id, user_id, org_id, refresh_token_hash, expires_at) VALUES ($1, $2, $3, $4, now() + interval '1 day')`, [ownerSid, ownerId, orgId, 'a'.repeat(64)]);
    await client.query(`INSERT INTO agent_actions (id, org_id, user_id, source, action, params, approval_tier, approval_status) VALUES ($1, $2, $3, 'app_record_mirror', 'app_record_mirror_nominate', $4::jsonb, 'full', 'pending')`, [actionId, orgId, ownerId, JSON.stringify(params)]);

    const { approveAction } = await import('../src/lib/agent-approval-resolver.js');

    const denied = await approveAction(actionId, memberId, { humanWebSessionId: ownerSid });
    assert.equal(denied.status, 'error');
    assert.equal((denied as { code: string }).code, 'FORBIDDEN');
  });

test('M retry: approved-without-result returns error',
  { skip: !safe, timeout: 120000 }, async (t) => {
    const pg = await import('pg');
    const client = new pg.Client({ connectionString: target! });
    await client.connect();

    const orgId = uuid(), ownerId = uuid();
    const actionId = uuid();
    const params = { connection_session_id: uuid(), store_key: 'drafts', mirror_key: 'saved_drafts', record_id: uuid(), request_id: uuid(), expected_revision: 0, expires_at: new Date(Date.now() + 3600_000).toISOString(), max_attempts_per_day: 1, account_ref: 'account_1', installation_id: uuid(), policy_digest: digest(policy()) };

    mock.module(new URL('../src/lib/app-record-mirror-service.ts', import.meta.url).href, {
      namedExports: {
        approveRecordMirrorNomination: async () => ({ receipt_id: 'r' }),
      },
    });

    t.after(async () => {
      await client.query('DELETE FROM agent_actions WHERE org_id = $1', [orgId]).catch(() => {});
      await client.query('DELETE FROM web_sessions WHERE org_id = $1', [orgId]).catch(() => {});
      await client.query('DELETE FROM org_members WHERE org_id = $1', [orgId]).catch(() => {});
      await client.query('DELETE FROM users WHERE id = $1', [ownerId]).catch(() => {});
      await client.query('DELETE FROM orgs WHERE id = $1', [orgId]).catch(() => {});
      await client.end();
      mock.restoreAll();
    });

    await client.query(`INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)`, [orgId, 'Mirror AWOR Org', 'mirror-awor-' + orgId]);
    await client.query(`INSERT INTO users (id, email, name, is_agent) VALUES ($1, $2, $3, false)`, [ownerId, 'owner-' + ownerId + '@test.local', 'Owner']);
    await client.query(`INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES ($1, $2, $3, 'owner', true)`, [uuid(), orgId, ownerId]);
    const ownerSid = uuid();
    await client.query(`INSERT INTO web_sessions (id, user_id, org_id, refresh_token_hash, expires_at) VALUES ($1, $2, $3, $4, now() + interval '1 day')`, [ownerSid, ownerId, orgId, 'a'.repeat(64)]);
    // approved without result
    await client.query(`INSERT INTO agent_actions (id, org_id, user_id, source, action, params, approval_tier, approval_status, approved_at, approved_by_user_id) VALUES ($1, $2, $3, 'app_record_mirror', 'app_record_mirror_nominate', $4::jsonb, 'full', 'approved', now(), $3)`, [actionId, orgId, ownerId, JSON.stringify(params)]);

    const { approveAction } = await import('../src/lib/agent-approval-resolver.js');

    const res = await approveAction(actionId, ownerId, { humanWebSessionId: ownerSid });
    assert.equal(res.status, 'error');
    assert.match((res as { message: string }).message, /earlier approval attempt failed/i);
  });

test('M retry: unexpected error during review never leaks raw message',
  { skip: !safe, timeout: 120000 }, async (t) => {
    const pg = await import('pg');
    const client = new pg.Client({ connectionString: target! });
    await client.connect();

    const orgId = uuid(), ownerId = uuid();
    const actionId = uuid();
    const params = { connection_session_id: uuid(), store_key: 'drafts', mirror_key: 'saved_drafts', record_id: uuid(), request_id: uuid(), expected_revision: 0, expires_at: new Date(Date.now() + 3600_000).toISOString(), max_attempts_per_day: 1, account_ref: 'account_1', installation_id: uuid(), policy_digest: digest(policy()) };

    mock.module(new URL('../src/lib/app-record-mirror-service.ts', import.meta.url).href, {
      namedExports: {
        approveRecordMirrorNomination: async () => {
          const e = new Error('SELECT … secret');
          (e as { phase?: string }).phase = 'review';
          throw e;
        },
      },
    });

    t.after(async () => {
      await client.query('DELETE FROM agent_actions WHERE org_id = $1', [orgId]).catch(() => {});
      await client.query('DELETE FROM web_sessions WHERE org_id = $1', [orgId]).catch(() => {});
      await client.query('DELETE FROM org_members WHERE org_id = $1', [orgId]).catch(() => {});
      await client.query('DELETE FROM users WHERE id = $1', [ownerId]).catch(() => {});
      await client.query('DELETE FROM orgs WHERE id = $1', [orgId]).catch(() => {});
      await client.end();
      mock.restoreAll();
    });

    await client.query(`INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)`, [orgId, 'Mirror Leak Org', 'mirror-leak-' + orgId]);
    await client.query(`INSERT INTO users (id, email, name, is_agent) VALUES ($1, $2, $3, false)`, [ownerId, 'owner-' + ownerId + '@test.local', 'Owner']);
    await client.query(`INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES ($1, $2, $3, 'owner', true)`, [uuid(), orgId, ownerId]);
    const ownerSid = uuid();
    await client.query(`INSERT INTO web_sessions (id, user_id, org_id, refresh_token_hash, expires_at) VALUES ($1, $2, $3, $4, now() + interval '1 day')`, [ownerSid, ownerId, orgId, 'a'.repeat(64)]);
    await client.query(`INSERT INTO agent_actions (id, org_id, user_id, source, action, params, approval_tier, approval_status) VALUES ($1, $2, $3, 'app_record_mirror', 'app_record_mirror_nominate', $4::jsonb, 'full', 'pending')`, [actionId, orgId, ownerId, JSON.stringify(params)]);

    const { approveAction } = await import('../src/lib/agent-approval-resolver.js');

    const fixed = 'The approval could not be completed. Try again.';
    const res = await approveAction(actionId, ownerId, { humanWebSessionId: ownerSid });
    assert.equal(res.status, 'error');
    assert.equal((res as { message: string }).message, fixed);

    const row = await client.query('SELECT error FROM agent_actions WHERE id = $1', [actionId]);
    assert.equal(row.rows[0].error, fixed);
    assert.ok(!String(row.rows[0].error).includes('SELECT'));
  });

test('M retry: confirm-phase failure is terminal and not retried',
  { skip: !safe, timeout: 120000 }, async (t) => {
    const pg = await import('pg');
    const client = new pg.Client({ connectionString: target! });
    await client.connect();

    const orgId = uuid(), ownerId = uuid();
    const actionId = uuid();
    const params = { connection_session_id: uuid(), store_key: 'drafts', mirror_key: 'saved_drafts', record_id: uuid(), request_id: uuid(), expected_revision: 0, expires_at: new Date(Date.now() + 3600_000).toISOString(), max_attempts_per_day: 1, account_ref: 'account_1', installation_id: uuid(), policy_digest: digest(policy()) };

    let calls = 0;
    mock.module(new URL('../src/lib/app-record-mirror-service.ts', import.meta.url).href, {
      namedExports: {
        approveRecordMirrorNomination: async () => {
          calls += 1;
          const e = new Error('confirm boom');
          (e as { phase?: string }).phase = 'confirm';
          throw e;
        },
      },
    });

    t.after(async () => {
      await client.query('DELETE FROM agent_actions WHERE org_id = $1', [orgId]).catch(() => {});
      await client.query('DELETE FROM web_sessions WHERE org_id = $1', [orgId]).catch(() => {});
      await client.query('DELETE FROM org_members WHERE org_id = $1', [orgId]).catch(() => {});
      await client.query('DELETE FROM users WHERE id = $1', [ownerId]).catch(() => {});
      await client.query('DELETE FROM orgs WHERE id = $1', [orgId]).catch(() => {});
      await client.end();
      mock.restoreAll();
    });

    await client.query(`INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)`, [orgId, 'Mirror Confirm Org', 'mirror-confirm-' + orgId]);
    await client.query(`INSERT INTO users (id, email, name, is_agent) VALUES ($1, $2, $3, false)`, [ownerId, 'owner-' + ownerId + '@test.local', 'Owner']);
    await client.query(`INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES ($1, $2, $3, 'owner', true)`, [uuid(), orgId, ownerId]);
    const ownerSid = uuid();
    await client.query(`INSERT INTO web_sessions (id, user_id, org_id, refresh_token_hash, expires_at) VALUES ($1, $2, $3, $4, now() + interval '1 day')`, [ownerSid, ownerId, orgId, 'a'.repeat(64)]);
    await client.query(`INSERT INTO agent_actions (id, org_id, user_id, source, action, params, approval_tier, approval_status) VALUES ($1, $2, $3, 'app_record_mirror', 'app_record_mirror_nominate', $4::jsonb, 'full', 'pending')`, [actionId, orgId, ownerId, JSON.stringify(params)]);

    const { approveAction } = await import('../src/lib/agent-approval-resolver.js');

    const fixed = 'The approval could not be completed. Try again.';
    const first = await approveAction(actionId, ownerId, { humanWebSessionId: ownerSid });
    assert.equal(first.status, 'error');
    const row1 = await client.query('SELECT approval_status, error FROM agent_actions WHERE id = $1', [actionId]);
    assert.equal(row1.rows[0].approval_status, 'expired');
    assert.equal(row1.rows[0].error, fixed);

    const second = await approveAction(actionId, ownerId, { humanWebSessionId: ownerSid });
    assert.equal(second.status, 'error');
    assert.equal(calls, 1, 'confirm is not called again');
  });
