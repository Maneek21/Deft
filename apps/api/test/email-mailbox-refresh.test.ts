import assert from 'node:assert/strict';
import test from 'node:test';
import { drizzle } from 'drizzle-orm/node-postgres';
import { emailAccounts, jobQueue } from '@deft/db/schema';
import { PostgresEmailMailboxRefresh } from '../src/lib/email-mailbox-refresh.js';
import { EmailMailboxError } from '../src/lib/email-mailbox-service.js';
import type { EmailAuthorityDatabase } from '../src/lib/email-mailbox-authority.js';
import { emailMailboxSyncDedupeKey } from '../src/lib/email-mailbox-scheduler.js';

// Real Drizzle query construction and mapping with a scripted driver. PostgreSQL
// locking remains covered by email-mailbox-refresh-db.test.ts.
function fixture(error: string | null, status = 'failed') {
  const now = 1000, scope = { org_id: 'org-a', owner_user_id: 'owner-a', account_id: 'account-a' };
  const actor = { user_id: scope.owner_user_id, web_session_id: 'session-a', access_expires_at: 10000 };
  const payload = { ...scope, authority_revision: 1 };
  const account = { ...scope, state: 'active', resource_binding_id: 'binding-a', principal_digest: 'a'.repeat(64), authority_revision: 1 };
  const job = { id: 'job-a', data: payload, status, attempts: 5, error, lock_token: 'held-lease' };
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  let sqlChecks = 0, denyAt = Infinity;
  const client = { async query(query: string | { text: string; rowMode?: string }, values: unknown[] = []) {
    const sql = typeof query === 'string' ? query : query.text;
    statements.push({ sql, values });
    if (/^(begin|commit|rollback)/i.test(sql)) return { rows: [], rowCount: 0 };
    const expectedScope = sql.includes('from "email_accounts"') ? Object.values(scope)
      : [scope.org_id, 'scheduled-jobs', 'native-email-sync', emailMailboxSyncDedupeKey(payload)];
    for (const value of expectedScope) assert.ok(values.includes(value), `Missing scoped SQL parameter: ${value}`);
    if (/^update "job_queue"/i.test(sql)) return { rows: [], rowCount: 1 };
    const row = sql.includes('from "email_accounts"') ? account : job;
    assert.match(sql, /from "(email_accounts|job_queue)"/);
    const fields = [...sql.slice(0, sql.indexOf(' from ')).matchAll(/(?:"[^"]+"\.)?"([^"]+)"/g)].map(match => match[1]!);
    return { rows: typeof query !== 'string' && query.rowMode === 'array'
      ? [fields.map(field => row[field as keyof typeof row])] : [row], rowCount: 1 };
  } };
  const database = drizzle(client as never, { schema: { emailAccounts, jobQueue } });
  const capability = { scope, resource_binding_id: 'binding-a', authority_version: 'current', expires_at: 10000 };
  const authority = { inspect: async () => ({ capability, account: { principal_digest: account.principal_digest } }) };
  const sqlAuthority = { current: async () => {
    if (++sqlChecks === denyAt) throw new EmailMailboxError('EMAIL_ACCESS_DENIED');
    return capability;
  } };
  const service = new PostgresEmailMailboxRefresh(database as unknown as EmailAuthorityDatabase,
    async () => ({ authority, sqlAuthority }) as never, async () => {}, () => now);
  return { request: () => service.request(actor, scope.org_id, scope.account_id), statements,
    denyOnFinalCheck: () => { denyAt = 3; } };
}

test('Refresh immediately resumes canonical controlled worker shutdown under current authority', async () => {
  for (const duration of ['1', '10000', '999999999']) {
    const f = fixture(`Worker shutdown exceeded ${duration}ms`);
    assert.deepEqual(await f.request(), { account_id: 'account-a', state: 'queued' });
    const update = f.statements.find(statement => /^update /i.test(statement.sql));
    assert.ok(update, 'Refresh must advance the existing interrupted job');
    assert.ok(update.values.includes(0), 'Terminal failure attempts must reset');
    assert.match(update.sql, /"lock_token" =/);
    assert.equal(f.statements.at(-1)?.sql, 'commit');
  }
});

test('Refresh retains protected failures and rejects malformed shutdown reasons', async () => {
  for (const error of ['EMAIL_ACCESS_DENIED', 'EMAIL_PAGE_INVALID', 'EMAIL_CURSOR_EXPIRED', 'EMAIL_SYNC_REPLAY_CONFLICT',
    'Worker shutdown exceeded 0ms', 'Worker shutdown exceeded 010000ms', 'Worker shutdown exceeded 1000000000ms',
    'Worker shutdown exceeded 10000ms\n', 'Worker shutdown exceeded 10000ms extra', 'prefix Worker shutdown exceeded 10000ms']) {
    const f = fixture(error);
    assert.equal((await f.request()).state, 'needs_attention', JSON.stringify(error));
    assert.equal(f.statements.some(statement => /^update /i.test(statement.sql)), false);
  }
});

test('Refresh preserves an active worker lease and rolls back late authority denial', async () => {
  const running = fixture('Worker shutdown exceeded 10000ms', 'running');
  assert.equal((await running.request()).state, 'syncing');
  assert.equal(running.statements.some(statement => /^update /i.test(statement.sql)), false);
  const revoked = fixture('Worker shutdown exceeded 10000ms'); revoked.denyOnFinalCheck();
  await assert.rejects(revoked.request(), /EMAIL_ACCESS_DENIED/);
  assert.equal(revoked.statements.at(-1)?.sql, 'rollback');
});
