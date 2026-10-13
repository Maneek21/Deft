import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { connectionBegin, pendingAppConnection, connectionCallback } from './app-connection-flow';

const pending = { sessionId: randomUUID(), installationId: randomUUID(), experienceKey: 'main', state: 's'.repeat(43), expiresAt: Date.now() + 60_000 };
test('account setup keeps only a bounded session pointer and exact provider state', () => {
  assert.deepEqual(pendingAppConnection(pending), pending);
  assert.throws(() => pendingAppConnection({ ...pending, token: 'must-not-persist' }));
  assert.throws(() => pendingAppConnection({ ...pending, expiresAt: 0 }));
  assert.throws(() => pendingAppConnection({ ...pending, experienceKey: '../foreign' }));
});
test('authorization navigation requires HTTPS and a current exact setup state', () => {
  const value = { authorization_url: `https://accounts.google.com/o/oauth2/v2/auth?state=${pending.state}`, expires_at: pending.expiresAt };
  assert.equal(connectionBegin(value).state, pending.state);
  for (const url of ['javascript:alert(1)', `http://accounts.google.com/?state=${pending.state}`, `https://user:secret@accounts.google.com/?state=${pending.state}`]) {
    assert.throws(() => connectionBegin({ ...value, authorization_url: url }));
  }
});
test('callback strips provider metadata and rejects replacement, duplicate or ambiguous state/code', () => {
  assert.deepEqual(connectionCallback(`?state=${pending.state}&code=opaque&scope=mail&authuser=1`, pending), { state: pending.state, code: 'opaque' });
  assert.deepEqual(connectionCallback(`?state=${pending.state}&error=access_denied&error_description=private`, pending), { state: pending.state, error: 'access_denied' });
  for (const query of [`?state=${'x'.repeat(43)}&code=opaque`, `?state=${pending.state}&code=one&code=two`, `?state=${pending.state}&code=one&error=denied`, `?state=${pending.state}&code=one&account_id=foreign`]) {
    assert.throws(() => connectionCallback(query, pending));
  }
});
