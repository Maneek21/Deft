import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { emailAccounts, emailTimers, notifications } from '@deft/db/schema';
import { EmailMailboxCrypto } from '../src/lib/email-mailbox-crypto.js';
import { EmailTimerStore } from '../src/lib/email-timer-store.js';
import { EmailTimerError, type EmailTimerContent } from '../src/lib/email-timer-types.js';

const timerDbUrl = 'postgresql://gate_g_test@127.0.0.1:55435/email_stage34_timers_80';
const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = target === timerDbUrl && process.env.DATABASE_URL === timerDbUrl;
const schema = { emailAccounts, emailTimers, notifications };
const logical = (n: number) => 'mail_' + n.toString(16).padStart(64, '0');

test('isolated PostgreSQL migration80 timer CAS, encryption, Inbox eligibility, paging and due lease', { skip: !safe, timeout: 120000 }, async t => {
  const pool = new pg.Pool({ connectionString: target, max: 8 });
  const db = drizzle(pool, { schema });
  const identity = await pool.query('SELECT org_id,owner_user_id,resource_binding_id FROM email_accounts ORDER BY account_id LIMIT 1');
  assert.equal(identity.rows.length, 1, 'fresh-schema template must contain an isolated synthetic owner/binding fixture');
  const org = identity.rows[0]!.org_id as string, owner = identity.rows[0]!.owner_user_id as string;
  const binding = identity.rows[0]!.resource_binding_id as string;
  const scope = { org_id: org, owner_user_id: owner, account_id: 'timer-test-' + randomUUID() };
  const now = { value: new Date('2026-10-04T00:00:00.000Z') };
  const guard = async (tx: unknown) => {
    const [account] = await (tx as typeof db).select({ account_id: emailAccounts.account_id }).from(emailAccounts).where(and(
      eq(emailAccounts.org_id, scope.org_id), eq(emailAccounts.owner_user_id, scope.owner_user_id), eq(emailAccounts.account_id, scope.account_id))).limit(1).for('share');
    if (!account) throw new Error('fixture authority revoked');
  };
  const keys = { current: () => ({ key_id: 'timer-test-key', key: Buffer.alloc(32, 19) }),
    read: (_purpose: unknown, key: string) => key === 'timer-test-key' ? { key_id: key, key: Buffer.alloc(32, 19) } : null,
    keyIds: () => ['timer-test-key'] };
  const crypto = new EmailMailboxCrypto(keys), store = new EmailTimerStore(db, crypto, () => now.value);
  const ids = Array.from({ length: 5 }, () => randomUUID());
  const timerIds = { future: ids[0]!, follow: ids[1]!, due: ids[2]!, raced: ids[3]!, other: ids[4]! };
  const content = (logical_message_id: string, kind: 'snooze' | 'follow_up', reminder_text?: string): EmailTimerContent => ({
    logical_message_id, kind, ...(reminder_text === undefined ? {} : { reminder_text }),
  });
  const schedule = (seconds: number) => new Date(now.value.getTime() + seconds * 1000);
  const acquire = (id: string, revision: number) => store.claimDue(scope, id, revision, 'fixture-job-' + id, 'fixture-lock-' + id,
    new Date(now.value.getTime() + 60_000), guard);
  const verifyTarget = async () => {
    const [row] = await pool.query('SELECT logical_message_digest,timer_envelope FROM email_timers WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3', Object.values(scope)).then(r => r.rows);
    assert.ok(row); assert.notEqual(row.logical_message_digest, logical(1));
    const dump = JSON.stringify(row); assert.equal(dump.includes(logical(1)), false); assert.equal(dump.includes('Synthetic reminder'), false);
  };

  await pool.query('SELECT current_database() AS db, current_user AS role, inet_server_port() AS port, host(inet_server_addr()) AS host').then(result => {
    const row = result.rows[0]; assert.deepEqual(row, { db: 'email_stage34_timers_80', role: 'gate_g_test', port: 55435, host: '127.0.0.1' });
  });
  await db.insert(emailAccounts).values({ ...scope, provider: 'gmail', resource_binding_id: binding,
    principal_digest: 'a'.repeat(64), state: 'active', authority_revision: 1, consented_at: now.value });
  t.after(async () => {
    await pool.query("DELETE FROM notifications WHERE org_id=$1 AND user_id=$2 AND metadata->>'reminder_id' LIKE 'native-email-timer:%'", [org, owner]);
    await pool.query('DELETE FROM email_timers WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3', Object.values(scope));
    await db.delete(emailAccounts).where(and(eq(emailAccounts.org_id, org), eq(emailAccounts.owner_user_id, owner), eq(emailAccounts.account_id, scope.account_id)));
    await pool.end();
  });

  await t.test('encrypted scoped CRUD and stable page cursor', async () => {
    const created = await store.create(scope, timerIds.future, content(logical(1), 'snooze', 'Synthetic reminder'), schedule(3600), 'Asia/Kolkata', guard);
    assert.equal(created.revision, 1); assert.equal(created.state, 'scheduled');
    const replay = await store.create(scope, timerIds.future, content(logical(1), 'snooze', 'Synthetic reminder'), schedule(3600), 'Asia/Kolkata', guard);
    assert.equal(replay.timer_id, created.timer_id);
    await store.create(scope, timerIds.follow, content(logical(2), 'follow_up'), schedule(7200), 'UTC', guard);
    await assert.rejects(store.create(scope, timerIds.other, content(logical(1), 'snooze'), schedule(4000), 'UTC', guard),
      error => error instanceof EmailTimerError && error.code === 'EMAIL_TIMER_CONFLICT');
    const page1 = await store.list(scope, null, null, null, 1, guard);
    assert.equal(page1.items.length, 1); assert.equal(page1.has_more, true); assert.ok(page1.next_cursor);
    now.value = new Date('2026-10-04T00:00:05.000Z');
    const page2 = await store.list(scope, null, null, page1.next_cursor, 1, guard);
    assert.equal(page2.items.length, 1); assert.equal(page2.has_more, false); assert.notEqual(page1.items[0]!.timer_id, page2.items[0]!.timer_id);
    assert.deepEqual([...await store.hiddenInboxMessageIds(scope, [logical(1), logical(2), logical(3)], guard)].sort(), [logical(1)]);
    await verifyTarget();
    assert.equal(await store.read({ ...scope, account_id: 'foreign-account' }, timerIds.future, guard), null);
  });

  await t.test('one competing update wins; firing cannot be cancelled and completion is fenced by lease', async () => {
    const due = await store.create(scope, timerIds.due, content(logical(3), 'follow_up'), new Date(now.value.getTime() - 1), 'UTC', guard);
    const claimed = await acquire(timerIds.due, due.revision); assert.equal(claimed.state, 'firing');
    await assert.rejects(store.cancel(scope, timerIds.due, claimed.revision, guard), error => error instanceof EmailTimerError && error.code === 'EMAIL_TIMER_CONFLICT');
    const notice = { org_id: org, user_id: owner, title: 'Email follow-up', body: 'Synthetic reminder',
      delivery_policy: { reason: 'allowed', channel: 'calendar', evaluated_at: now.value.toISOString() } };
    const done = await store.completeFiring(scope, timerIds.due, claimed.revision, 'fixture-job-' + timerIds.due,
      'fixture-lock-' + timerIds.due, guard, undefined, notice);
    assert.equal(done.timer.state, 'completed');
    assert.ok(done.notification);
    assert.equal(done.notification.link, `/email?account=${encodeURIComponent(scope.account_id)}&message=${encodeURIComponent(logical(3))}`);
    const duplicate = await store.completeFiring(scope, timerIds.due, done.timer.revision, 'fixture-job-' + timerIds.due,
      'fixture-lock-' + timerIds.due, guard, undefined, notice);
    assert.equal(duplicate.notification, null);
    const count = await pool.query("SELECT count(*)::int AS count FROM notifications WHERE org_id=$1 AND user_id=$2 AND metadata->>'reminder_id'=$3",
      [org, owner, `native-email-timer:${timerIds.due}`]);
    assert.equal(count.rows[0]?.count, 1);

    await store.create(scope, timerIds.raced, content(logical(4), 'follow_up'), schedule(9000), 'UTC', guard);
    const attempts = await Promise.allSettled([
      store.reschedule(scope, timerIds.raced, 1, schedule(10000), 'UTC', undefined, false, guard),
      store.cancel(scope, timerIds.raced, 1, guard),
    ]);
    assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(attempts.filter(result => result.status === 'rejected' && result.reason instanceof EmailTimerError && result.reason.code === 'EMAIL_TIMER_CONFLICT').length, 1);
  });
});
