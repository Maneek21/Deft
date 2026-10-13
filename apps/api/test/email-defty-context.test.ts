import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmailDeftyContextRoutes } from '../src/routes/email-defty-context.js';

const messageId = `mail_${'a'.repeat(64)}`;
const url = `/accounts/work/messages/${messageId}/defty-context`;
const session = { id: 'owner', org_id: 'org', sid: 'actual-sid', exp: Math.floor(Date.now() / 1000) + 600 };
test('Email handoff validates identity and reference without accepting copied body or another owner', async () => {
  const calls: unknown[] = [];
  const app = createEmailDeftyContextRoutes({ verify: async () => session, open: async (...args) => { calls.push(args); return { url: '/chat?space=dm' }; } });
  const request = (body: unknown, path = url, auth = true) => app.request(path, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer valid' } : {}) }, body: JSON.stringify(body) });
  assert.equal((await request({}, url, false)).status, 401);
  assert.equal((await request({ body: 'private mail', owner_user_id: 'another' })).status, 400);
  assert.equal((await request({}, url.replace(messageId, 'invalid'))).status, 400);
  assert.equal((await request({}, `${url}?owner=another`)).status, 400);
  assert.equal(calls.length, 0);
  const result = await request({});
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.deepEqual(calls, [[{ user_id: 'owner', web_session_id: 'actual-sid', access_expires_at: session.exp * 1000 },
    { org_id: 'org', owner_user_id: 'owner', account_id: 'work' }, messageId]]);
});
test('Email handoff rejects expired sessions and returns actionable missing access without leaking internals', async () => {
  for (const [error, expected] of [['EMAIL_DEFTY_ACCESS_REQUIRED', 403], ['EMAIL_MESSAGE_UNAVAILABLE', 404], ['secret provider detail', 503]] as const) {
    const app = createEmailDeftyContextRoutes({ verify: async () => session, open: async () => { throw Error(error); } });
    const result = await app.request(url, { method: 'POST', headers: { authorization: 'Bearer valid', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(result.status, expected);
    assert.equal((await result.json()).code, expected === 503 ? 'EMAIL_CONTEXT_UNAVAILABLE' : error);
  }
  const app = createEmailDeftyContextRoutes({ verify: async () => ({ ...session, exp: NaN }), open: async () => assert.fail('expired session must not open a DM') });
  assert.equal((await app.request(url, { method: 'POST', headers: { authorization: 'Bearer valid' }, body: '{}' })).status, 401);
});
