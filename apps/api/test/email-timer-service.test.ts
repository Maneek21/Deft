import test from 'node:test';
import assert from 'node:assert/strict';
import { EmailTimerService } from '../src/lib/email-timer-service.js';
import { EmailTimerError } from '../src/lib/email-timer-types.js';

const actor = { user_id: 'owner', web_session_id: 'session', access_expires_at: Date.now() + 60_000 };
const scope = { org_id: 'org', owner_user_id: 'owner', account_id: 'account' };
const timerId = '00000000-0000-4000-8000-000000000001';
function capability() { return { scope, resource_binding_id: 'binding', authority_version: 'rev:1', expires_at: Date.now() + 60_000 }; }

test('timer service uses owner read/draft authority, rechecks connected state, and server-resolves wall time', async () => {
  const operations: string[] = [], checked: Array<unknown> = [];
  const authority = { async current(_actor: unknown, _scope: unknown, operation: string, transaction?: unknown) {
    operations.push(`${operation}:${transaction ? 'tx' : 'fresh'}`); return capability();
  } };
  const store = { async create(_scope: unknown, id: string, content: any, at: Date, zone: string, guard: any) {
    await guard({}); checked.push(content, at, zone); return { timer_id: id, account_id: 'account', logical_message_id: content.logical_message_id,
      kind: content.kind, scheduled_at: at.toISOString(), display_timezone: zone, revision: 1, state: 'scheduled', updated_at: at.toISOString() };
  }, async reschedule() { throw new Error('unused'); }, async cancel() { throw new Error('unused'); }, async read() { return null; }, async list() { return { items: [], next_cursor: null, has_more: false }; }, async hiddenInboxMessageIds() { return new Set(); } };
  const scheduled: any[] = [];
  const service = new EmailTimerService(authority, authority, store as any, () => Date.parse('2026-10-04T00:00:00.000Z'), async (scheduledScope, timer) => {
    assert.equal(operations.at(-1), 'human_draft:fresh', 'enqueue follows the final fresh authority check');
    scheduled.push({ scope: scheduledScope, timer });
  });
  const result = await service.save(actor, scope, timerId, { expected_revision: 0, logical_message_id: `mail_${'a'.repeat(64)}`, kind: 'follow_up',
    schedule: { wall_time: '2026-10-05T09:00', zone: 'Asia/Kolkata', ambiguity: 'reject' }, reminder_text: 'Check with the client' });
  assert.equal(result.scheduled_at, '2026-10-05T03:30:00.000Z');
  assert.equal(result.display_timezone, 'Asia/Calcutta');
  assert.equal(checked[0] && (checked[0] as any).reminder_text, 'Check with the client');
  assert.ok(operations.includes('human_draft:fresh'));
  assert.ok(operations.length >= 4);
  assert.ok(operations.includes('human_draft:tx'));
  assert.equal(scheduled.length, 1); assert.equal(scheduled[0].scope.account_id, scope.account_id);
  assert.equal(scheduled[0].timer.timer_id, result.timer_id); assert.equal(scheduled[0].timer.revision, result.revision);
});

test('queue failure after timer persistence does not turn a saved timer into a false failed write', async () => {
  let persisted: any = null;
  const authority = { async current() { return capability(); } };
  const store = { async create(_scope: unknown, id: string, content: any, at: Date, zone: string) {
    persisted = { timer_id:id,account_id:scope.account_id,logical_message_id:content.logical_message_id,kind:content.kind,
      scheduled_at:at.toISOString(),display_timezone:zone,revision:2,state:'scheduled' as const,updated_at:at.toISOString() };
    return persisted;
  } };
  const service = new EmailTimerService(authority as any, authority as any, store as any,
    () => Date.parse('2026-10-04T00:00:00.000Z'), async () => { throw new Error('queue unavailable'); });
  const result = await service.save(actor, scope, timerId, { expected_revision:0,logical_message_id:`mail_${'a'.repeat(64)}`,kind:'snooze',
    schedule:{wall_time:'2026-10-05T09:00',zone:'UTC',ambiguity:'reject'} });
  assert.equal(result, persisted); assert.equal(result.state, 'scheduled');
});

test('timer service rejects invalid schedule and cross-owner request before store mutation', async () => {
  let writes = 0;
  const authority = { current: async () => capability() };
  const store = { create: async () => { writes++; throw new Error('must not write'); } };
  const service = new EmailTimerService(authority, authority, store as any, () => Date.parse('2026-10-04T00:00:00.000Z'));
  await assert.rejects(service.save(actor, scope, timerId, { expected_revision: 0, logical_message_id: `mail_${'a'.repeat(64)}`, kind: 'snooze',
    schedule: { wall_time: '2026-03-08T02:30', zone: 'America/New_York', ambiguity: 'reject' } }),
  error => error instanceof EmailTimerError && error.code === 'EMAIL_TIMER_INVALID');
  await assert.rejects(service.save(actor, { ...scope, owner_user_id: 'other' }, timerId, { expected_revision: 0,
    logical_message_id: `mail_${'a'.repeat(64)}`, kind: 'snooze', schedule: { wall_time: '2026-10-05T09:00', zone: 'UTC', ambiguity: 'reject' } }),
  error => error instanceof EmailTimerError && error.code === 'EMAIL_TIMER_ACCESS_DENIED');
  assert.equal(writes, 0);
});

test('future Inbox projection keeps both SQL guards and rejects connected revocation after reading', async () => {
  const transactions: unknown[] = [];
  let connectedChecks = 0, revoke = false;
  const connected = { async current() {
    if (revoke && ++connectedChecks === 2) return { ...capability(), authority_version: 'rev:2' };
    return capability();
  } };
  const sql = { async current(_actor: unknown, _scope: unknown, operation: string, tx?: unknown) {
    assert.equal(operation, 'human_read'); if (tx) transactions.push(tx); return capability();
  } };
  const tx = {};
  const store = { async futureInboxMessageIds(_scope: unknown, guard: (tx: unknown) => Promise<void>) {
    await guard(tx); await guard(tx); return new Set([`mail_${'a'.repeat(64)}`]);
  } };
  const service = new EmailTimerService(connected, sql, store as any);
  assert.equal((await service.futureInboxMessageIds(actor, scope)).size, 1);
  assert.deepEqual(transactions, [tx, tx]);
  revoke = true; connectedChecks = 0;
  await assert.rejects(service.futureInboxMessageIds(actor, scope), error => error instanceof EmailTimerError && error.code === 'EMAIL_TIMER_ACCESS_DENIED');
});
