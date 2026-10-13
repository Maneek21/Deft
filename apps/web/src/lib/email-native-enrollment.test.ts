import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeEmailSetup, adoptNativeEmailAccount } from './email-native-enrollment';
const setup = { account_id: 'stable/account', resource_binding_id: '11111111-1111-4111-8111-111111111111', state: 'available' as const };
const status = { state: 'connected', account: { account_id: setup.account_id, health: 'connected' }, native_email: setup };
test('native setup nomination must match connected account and reviewed binding shape', () => {
  assert.deepEqual(nativeEmailSetup(status), setup);
  for (const value of [null, { ...status, state: 'revoked' }, { ...status, account: { account_id: 'other', health: 'connected' } },
    { ...status, native_email: { ...setup, resource_binding_id: 'browser-credential' } }, { ...status, native_email: { ...setup, state: 'ready' } }]) {
    assert.equal(nativeEmailSetup(value), null);
  }
});
test('explicit cache retry sends only server nomination and requires exact account success', async () => {
  let calls = 0;
  const output = await adoptNativeEmailAccount(setup, { current: () => true, fetch: async (path, init) => {
    calls++; assert.equal(path, '/api/email/accounts/stable%2Faccount/adopt'); assert.equal(init.body, JSON.stringify({ resource_binding_id: setup.resource_binding_id }));
    assert.equal(init.cache, 'no-store'); return Response.json({ state: 'active', account_id: setup.account_id, provider: 'gmail', authority_revision: 2 }); } });
  assert.equal(output.state, 'active'); assert.equal(calls, 1);
  await assert.rejects(adoptNativeEmailAccount(setup, { current: () => true, fetch: async () => Response.json({ state: 'active', account_id: 'other', provider: 'gmail', authority_revision: 1 }) }), /not confirmed/);
});
test('held cache setup results cannot cross session, visibility or abort boundary', async () => {
  let current = true;
  await assert.rejects(adoptNativeEmailAccount(setup, { current: () => current, fetch: async () => { current = false;
    return Response.json({ state: 'active', account_id: setup.account_id, provider: 'gmail', authority_revision: 2 }); } }), /access ended/);
  const controller = new AbortController(); controller.abort(Error('Stopped'));
  await assert.rejects(adoptNativeEmailAccount(setup, { current: () => true, fetch: async () => { throw Error('Must not fetch'); } }, controller.signal), /Stopped/);
});
test('cache failure is retryable without disconnecting OAuth or exposing raw errors', async () => {
  await assert.rejects(adoptNativeEmailAccount(setup, { current: () => true, fetch: async () => Response.json({ secret: 'token' }, { status: 503 }) }),
    /Your account is connected\. Cached mailbox setup was not confirmed/);
});
