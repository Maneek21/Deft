import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  assertEmailMailboxTestDatabaseTarget,
  openPreparedEmailMailboxTestDatabase,
} from './fixtures/email-mailbox-database.js';
import {
  repairNativeEmailSyncBatch,
  resetNativeEmailSyncRepairCursor,
  scheduleNativeEmailAccount,
} from '../src/lib/email-mailbox-scheduler-runtime.js';
import { closeDb } from '../src/lib/db.js';

test('production scheduler uses scoped durable dedupe and re-arms only repairable current active work', async (t) => {
  assertEmailMailboxTestDatabaseTarget();
  const client = await openPreparedEmailMailboxTestDatabase();

  const orgId = `email-scheduler-${randomUUID()}`;
  const ownerId = `owner-${randomUUID()}`;
  const bindingId = `binding-${randomUUID()}`;
  const activeA = `account-a-${randomUUID()}`;
  const activeB = `account-b-${randomUUID()}`;
  const revoked = `account-revoked-${randomUUID()}`;
  const shutdown = `account-shutdown-${randomUUID()}`;
  const oldAuthority = `account-old-authority-${randomUUID()}`;
  const freshTransient = `account-fresh-transient-${randomUUID()}`;
  const malformed = `account-malformed-${randomUUID()}`;
  const unrelated = `account-unrelated-${randomUUID()}`;
  const accounts = [activeA, activeB, revoked, shutdown, oldAuthority, freshTransient, malformed, unrelated];
  t.after(async () => {
    await client.query('DELETE FROM job_queue WHERE org_id = $1', [orgId]);
    await client.query('DELETE FROM email_accounts WHERE org_id = $1 AND owner_user_id = $2', [orgId, ownerId]);
    await client.query('DELETE FROM app_resource_bindings WHERE org_id = $1 AND owner_user_id = $2', [orgId, ownerId]);
    await client.query('DELETE FROM org_members WHERE org_id = $1 AND user_id = $2', [orgId, ownerId]);
    await client.end();
    await closeDb();
  });

  await client.query('INSERT INTO org_members(org_id,user_id) VALUES($1,$2)', [orgId, ownerId]);
  await client.query('INSERT INTO app_resource_bindings(id,org_id,owner_user_id) VALUES($1,$2,$3)', [bindingId, orgId, ownerId]);
  for (const [index, accountId] of accounts.entries()) {
    await client.query(`INSERT INTO email_accounts(
      org_id,owner_user_id,account_id,provider,resource_binding_id,principal_digest,state,authority_revision,consented_at,revoked_at
    ) VALUES($1,$2,$3,'gmail',$4,$5,$6,1,$7,$8)`, [
      orgId, ownerId, accountId, bindingId, 'a'.repeat(64), index === 2 ? 'revoked' : 'active',
      index === 2 ? null : new Date(), index === 2 ? new Date() : null,
    ]);
  }

  const scopeA = { org_id: orgId, owner_user_id: ownerId, account_id: activeA, authority_revision: 1 };
  const scopeB = { org_id: orgId, owner_user_id: ownerId, account_id: activeB, authority_revision: 1 };
  await scheduleNativeEmailAccount(scopeA);
  await scheduleNativeEmailAccount(scopeA);
  await scheduleNativeEmailAccount(scopeB);
  const queued = await client.query<{ data: Record<string, unknown>; dedupe_key: string; status: string }>(
    `SELECT data,dedupe_key,status FROM job_queue WHERE org_id=$1 ORDER BY data->>'account_id'`, [orgId],
  );
  assert.equal(queued.rowCount, 2);
  assert.deepEqual(queued.rows.map(row => row.data.account_id), [activeA, activeB].sort());
  assert.ok(queued.rows.every(row => row.status === 'pending' && /^[a-f0-9]{64}$/u.test(row.dedupe_key)));
  assert.ok(queued.rows.every(row => Object.keys(row.data).sort().join(',') === 'account_id,authority_revision,org_id,owner_user_id'));

  for (const accountId of [shutdown, oldAuthority, freshTransient, malformed, unrelated, revoked]) {
    await scheduleNativeEmailAccount({org_id:orgId,owner_user_id:ownerId,account_id:accountId,authority_revision:1});
  }
  await client.query(`UPDATE email_accounts SET authority_revision=2 WHERE org_id=$1 AND account_id=$2`, [orgId, oldAuthority]);
  for (const [accountId, error] of [
    [shutdown, 'Worker shutdown exceeded 10000ms'],
    [oldAuthority, 'Worker shutdown exceeded 10000ms'],
    [revoked, 'Worker shutdown exceeded 10000ms'],
    [freshTransient, 'EMAIL_SYNC_UNAVAILABLE'],
    [malformed, 'Worker shutdown exceeded 010000ms'],
    [unrelated, 'Provider shutdown exceeded 10000ms'],
  ]) {
    await client.query(`UPDATE job_queue SET status='failed',attempts=5,error=$3,completed_at=now()
      WHERE org_id=$1 AND data->>'account_id'=$2`, [orgId, accountId, error]);
  }

  await client.query(`UPDATE job_queue SET status='failed', error='EMAIL_ACCESS_DENIED', completed_at=now()-interval '6 minutes'
    WHERE org_id=$1 AND data->>'account_id'=$2`, [orgId, activeA]);
  await client.query(`UPDATE job_queue SET status='failed', error='EMAIL_SYNC_UNAVAILABLE', completed_at=now()-interval '6 minutes'
    WHERE org_id=$1 AND data->>'account_id'=$2`, [orgId, activeB]);

  resetNativeEmailSyncRepairCursor();
  const repair = await repairNativeEmailSyncBatch(100);
  assert.ok(repair.scanned >= 2);
  const finalRows = await client.query<{ account_id: string; status: string; error: string | null; authority_revision: number; attempts: number }>(
    `SELECT data->>'account_id' AS account_id,status,error,(data->>'authority_revision')::integer AS authority_revision,attempts FROM job_queue WHERE org_id=$1 ORDER BY account_id`, [orgId],
  );
  const rowA = finalRows.rows.find(row => row.account_id === activeA)!;
  const rowB = finalRows.rows.find(row => row.account_id === activeB)!;
  assert.equal(rowA.status, 'failed');
  assert.equal(rowA.error, 'EMAIL_ACCESS_DENIED');
  assert.equal(rowB.status, 'pending');
  assert.equal(rowB.error, null);
  const rowShutdown = finalRows.rows.find(row => row.account_id === shutdown)!;
  assert.equal(rowShutdown.status, 'pending', 'fresh canonical worker-shutdown failure must rearm immediately');
  assert.equal(rowShutdown.error, null);
  assert.equal(rowShutdown.attempts, 0);
  const oldRows = finalRows.rows.filter(row => row.account_id === oldAuthority);
  assert.equal(oldRows.find(row => row.authority_revision === 1)?.status, 'failed', 'old authority failure must never be resurrected');
  assert.equal(oldRows.find(row => row.authority_revision === 2)?.status, 'pending');
  for (const accountId of [revoked, freshTransient, malformed, unrelated]) {
    const row = finalRows.rows.find(row => row.account_id === accountId)!;
    assert.equal(row.status, 'failed', `ineligible failure remains failed: ${accountId}`);
    assert.equal(row.attempts, 5);
  }

  // Exercise the production PostgreSQL matcher, including trailing newline
  // and duration bounds, rather than a separate JavaScript approximation.
  for (const error of [
    'Worker shutdown exceeded 0ms',
    'Worker shutdown exceeded 010000ms',
    'Worker shutdown exceeded 1000000000ms',
    'Worker shutdown exceeded 10000ms\n',
    'Worker shutdown exceeded 10000ms extra',
    'prefix Worker shutdown exceeded 10000ms',
  ]) {
    await client.query(`UPDATE job_queue SET status='failed',attempts=5,error=$3,completed_at=now()-interval '6 minutes'
      WHERE org_id=$1 AND data->>'account_id'=$2`, [orgId, malformed, error]);
    await repairNativeEmailSyncBatch(null, 100);
    const result = await client.query(`SELECT status,error FROM job_queue WHERE org_id=$1 AND data->>'account_id'=$2`, [orgId, malformed]);
    assert.equal(result.rows[0].status, 'failed', `noncanonical worker reason is not repairable: ${JSON.stringify(error)}`);
    assert.equal(result.rows[0].error, error);
  }
  for (const milliseconds of ['1', '999999999']) {
    await client.query(`UPDATE job_queue SET status='failed',attempts=5,error=$3,completed_at=now()
      WHERE org_id=$1 AND data->>'account_id'=$2`, [orgId, shutdown, `Worker shutdown exceeded ${milliseconds}ms`]);
    await repairNativeEmailSyncBatch(null, 100);
    const result = await client.query(`SELECT status,attempts,error FROM job_queue WHERE org_id=$1 AND data->>'account_id'=$2`, [orgId, shutdown]);
    assert.deepEqual(result.rows[0], {status:'pending',attempts:0,error:null});
  }
  for (const [queue, name] of [['unrelated-queue','native-email-sync'],['scheduled-jobs','unrelated-job']]) {
    await client.query(`UPDATE job_queue SET queue=$3,name=$4,status='failed',attempts=5,error='Worker shutdown exceeded 10000ms',completed_at=now()
      WHERE org_id=$1 AND data->>'account_id'=$2`, [orgId, unrelated, queue, name]);
    await repairNativeEmailSyncBatch(null, 100);
    const result = await client.query(`SELECT status FROM job_queue WHERE org_id=$1 AND data->>'account_id'=$2`, [orgId, unrelated]);
    assert.equal(result.rows[0].status, 'failed', 'shutdown repair is native sync queue/name only');
  }
});
