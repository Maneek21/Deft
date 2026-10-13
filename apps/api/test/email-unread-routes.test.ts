import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { createEmailUnreadRoutes } from '../src/routes/email-unread.js';
import type { EmailActor, EmailScope } from '../src/lib/email-mailbox-service.js';
import type { EmailUnreadService } from '../src/lib/email-unread.js';

const session = { id: 'owner', org_id: 'org', sid: 'sid', exp: Math.floor(Date.now() / 1000) + 60 };
const snapshot = { account_id: 'account', folder: 'INBOX', unread_count: 2, cached_unread_count: 2, coverage: 'complete' as const,
  sync_state: 'idle' as const, checkpoint_revision: 9, observed_at: '2026-10-04T00:00:00.000Z', fresh_until: '2026-10-04T00:00:30.000Z' };

function app(service: Pick<EmailUnreadService, 'read'|'readUnified'>) {
  const routes = createEmailUnreadRoutes({ verify: async token => token === 'valid' ? session : Promise.reject(new Error('bad token')),
    service: async () => service });
  const server = new Hono(); server.route('/api/email', routes); return server;
}

test('account unread API derives owner/org from the verified session and returns bounded counts only', async () => {
  let observed: { actor?: EmailActor; scope?: EmailScope; folder?: string } = {};
  const server = app({ async read(actor, scope, folder) { observed = { actor, scope, folder }; return snapshot; }, async readUnified() { throw new Error('not called'); } });
  const response = await server.request('/api/email/accounts/account-a/unread?folder=INBOX', { headers: { authorization: 'Bearer valid' } });
  assert.equal(response.status, 200);
  assert.deepEqual(observed.scope, { org_id: session.org_id, owner_user_id: session.id, account_id: 'account-a' });
  assert.deepEqual(observed.folder, 'INBOX');
  assert.equal(observed.actor?.web_session_id, session.sid);
  const body = await response.json(); assert.equal(body.unread_count, 2); assert.equal('items' in body, false);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('unified API uses repeated account nominations, strict query bounds and verified scope', async () => {
  let observed: { actor?: EmailActor; scopes?: EmailScope[]; folder?: string } = {};
  const result = { unread_count: 3, cached_unread_count: 3, coverage: 'complete' as const, folder: 'all', accounts: [] };
  const server = app({ async read() { return snapshot; }, async readUnified(actor, scopes, folder) { observed = { actor, scopes: [...scopes], folder }; return result; } });
  const response = await server.request('/api/email/unread?folder=all&account_id=a&account_id=b', { headers: { authorization: 'Bearer valid' } });
  assert.equal(response.status, 200);
  assert.deepEqual(observed.scopes, [
    { org_id: session.org_id, owner_user_id: session.id, account_id: 'a' },
    { org_id: session.org_id, owner_user_id: session.id, account_id: 'b' },
  ]);
  assert.deepEqual(observed.folder, 'all');
  assert.equal((await response.json()).unread_count, 3);
  const malformed = await server.request('/api/email/unread?folder=all&account_id=a&account_id=a', { headers: { authorization: 'Bearer valid' } });
  assert.equal(malformed.status, 400);
  const unknown = await server.request('/api/email/unread?account_id=a&include_subject=true', { headers: { authorization: 'Bearer valid' } });
  assert.equal(unknown.status, 400);
});

test('missing session and revoked authority do not reveal account counts', async () => {
  const server = app({ async read() { throw new Error('EMAIL_ACCESS_DENIED'); }, async readUnified() { throw new Error('EMAIL_ACCESS_DENIED'); } });
  assert.equal((await server.request('/api/email/accounts/a/unread')).status, 401);
  const denied = await server.request('/api/email/accounts/a/unread', { headers: { authorization: 'Bearer valid' } });
  assert.equal(denied.status, 403); assert.deepEqual(await denied.json(), { code: 'EMAIL_ACCESS_DENIED' });
});

test('corrupt snooze projection is unavailable and never emits a count', async () => {
  const server = app({ async read() { throw new Error('timer envelope mismatch'); }, async readUnified() { throw new Error('timer envelope mismatch'); } });
  const response = await server.request('/api/email/accounts/a/unread', { headers: { authorization: 'Bearer valid' } });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { code: 'EMAIL_UNREAD_UNAVAILABLE' });
});
