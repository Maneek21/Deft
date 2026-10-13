import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmailTimerRoutes } from '../src/routes/email-timers.js';
import { EmailTimerError } from '../src/lib/email-timer-types.js';
import type { EmailActor, EmailScope } from '../src/lib/email-mailbox-service.js';
import type { EmailTimerService } from '../src/lib/email-timer-service.js';

const session = { id: 'owner', org_id: 'org', sid: 'sid', exp: Date.now() / 1000 + 600 };
const timer = { timer_id: '00000000-0000-4000-8000-000000000001', account_id: 'account', logical_message_id: `mail_${'a'.repeat(64)}`,
  kind: 'snooze' as const, scheduled_at: '2026-10-05T09:00:00.000Z', display_timezone: 'Asia/Kolkata', revision: 1,
  state: 'scheduled' as const, updated_at: '2026-10-04T09:00:00.000Z' };
const auth = { authorization: 'Bearer fixture', 'content-type': 'application/json' };

test('timer routes bind owner scope, support lost-ack lookup, and keep responses private', async () => {
  const calls: string[] = [];
  const routes = createEmailTimerRoutes({ verify: async token => { assert.equal(token, 'fixture'); return session; }, timers: async actor => {
    assert.equal(actor.user_id, 'owner');
    const service: Pick<EmailTimerService, 'get' | 'list' | 'save' | 'cancel'> = {
      get: async (_actor: EmailActor, scope: EmailScope, id: string) => { calls.push(`get:${scope.org_id}:${scope.owner_user_id}:${scope.account_id}:${id}`); return timer; },
      list: async (_actor: EmailActor, scope: EmailScope, rawQuery: unknown) => { const query = rawQuery as { kind?: string };
        calls.push(`list:${scope.account_id}:${query.kind ?? ''}`); return { items: [timer], next_cursor: null, has_more: false }; },
      save: async (_actor: EmailActor, scope: EmailScope, id: string, input: unknown) => { calls.push(`save:${scope.account_id}:${id}`); assert.equal((input as { expected_revision: number }).expected_revision, 0); return timer; },
      cancel: async (_actor: EmailActor, scope: EmailScope, id: string, revision: number) => { calls.push(`cancel:${scope.account_id}:${id}:${revision}`); return { ...timer, state: 'cancelled' as const, revision: 2 }; },
    };
    return service;
  } });

  const read = await routes.request(`/accounts/account/timers/${timer.timer_id}`, { headers: auth });
  assert.equal(read.status, 200); assert.equal(read.headers.get('cache-control'), 'no-store');
  assert.equal((await read.json() as any).logical_message_id, timer.logical_message_id);
  const list = await routes.request('/accounts/account/timers?kind=snooze&limit=5', { headers: auth });
  assert.equal(list.status, 200); assert.equal((await list.json() as any).items.length, 1);
  const created = await routes.request(`/accounts/account/timers/${timer.timer_id}`, { method: 'PUT', headers: auth,
    body: JSON.stringify({ expected_revision: 0, logical_message_id: timer.logical_message_id, kind: 'snooze',
      schedule: { wall_time: '2026-10-05T14:30', zone: 'Asia/Kolkata', ambiguity: 'reject' } }) });
  assert.equal(created.status, 200);
  const cancelled = await routes.request(`/accounts/account/timers/${timer.timer_id}/cancel`, { method: 'POST', headers: auth,
    body: JSON.stringify({ expected_revision: 1 }) });
  assert.equal(cancelled.status, 200); assert.equal((await cancelled.json() as any).state, 'cancelled');
  assert.deepEqual(calls, [
    `get:org:owner:account:${timer.timer_id}`, 'list:account:snooze', `save:account:${timer.timer_id}`, `cancel:account:${timer.timer_id}:1`,
  ]);
  assert.equal((await routes.request(`/accounts/account/timers/${timer.timer_id}?secret=x`, { headers: auth })).status, 400);
  assert.equal((await routes.request(`/accounts/account/timers/${timer.timer_id}`, {})).status, 401);
});

test('timer routes return conflict and do not reveal internal exception details', async () => {
  const service: Pick<EmailTimerService, 'get' | 'list' | 'save' | 'cancel'> = {
    get: async () => { throw new EmailTimerError('EMAIL_TIMER_CONFLICT'); },
    list: async () => { throw Error('synthetic internals'); }, save: async () => timer, cancel: async () => timer,
  };
  const routes = createEmailTimerRoutes({ verify: async () => session, timers: async () => service });
  const conflict = await routes.request(`/accounts/account/timers/${timer.timer_id}`, { headers: auth });
  assert.equal(conflict.status, 409); assert.deepEqual(await conflict.json(), { code: 'EMAIL_TIMER_CONFLICT' });
  const failure = await routes.request('/accounts/account/timers', { headers: auth });
  assert.equal(failure.status, 503); assert.equal((await failure.text()).includes('synthetic'), false);
});
