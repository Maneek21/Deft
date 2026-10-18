import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createEmailConnectionCompletion } from '../src/lib/email-mailbox-connection-completion.js';
import type { AppConnectionEntry } from '../src/lib/app-connection-registry.js';
const caller = { org_id: randomUUID(), user_id: randomUUID(), sid: randomUUID(), access_expires_at: Date.now() + 60000 };
const entry: AppConnectionEntry = { pins: { org_id: caller.org_id, owner_user_id: caller.user_id, installation_id: randomUUID(),
  app_version_id: randomUUID(), grant_snapshot_id: randomUUID(), target_key: 'personal', resource_key: 'inbox',
  resource_binding_id: randomUUID(), action_key: null, action_binding_id: null }, adapter: {
  handle: async () => Response.json({}), nativeEmailAccount: async () => { throw Error('Completion must delegate independent verification'); },
} };
const result = { state: 'connected', account: { account_id: 'stable-account', health: 'connected', primary_address: 'private@example.test',
  resource_binding_id: 'untrusted-result-binding', principal_digest: 'must-not-be-used' } };
function fixture() {
  const state = { enabled: true, events: [] as string[], fail: '' };
  const complete = createEmailConnectionCompletion({ enabled: () => state.enabled,
    adopt: async (actor, org, nomination) => { state.events.push('adopt'); assert.deepEqual(actor,
      { user_id: caller.user_id, web_session_id: caller.sid, access_expires_at: caller.access_expires_at }); assert.equal(org, caller.org_id);
      assert.deepEqual(nomination, { account_id: 'stable-account', resource_binding_id: entry.pins.resource_binding_id });
      if (state.fail === 'adopt') throw Error('SECRET');
      return { account_id: nomination.account_id, provider: 'gmail', state: 'active', authority_revision: 4 }; },
    schedule: async scope => { state.events.push('schedule'); assert.deepEqual(scope,
      { org_id: caller.org_id, owner_user_id: caller.user_id, account_id: 'stable-account', authority_revision: 4 });
      if (state.fail === 'schedule') throw Error('SECRET'); },
  });
  return { state, complete, input: { caller, entry, result, operation: 'callback' as const, purpose: 'connect' as const, signal: new AbortController().signal } };
}
test('successful OAuth adopts stable adapter account with registry binding and schedules committed revision', async () => {
  const f = fixture(), output = await f.complete(f.input) as { native_email: unknown };
  assert.deepEqual(f.state.events, ['adopt', 'schedule']);
  assert.deepEqual(output.native_email, { account_id: 'stable-account', resource_binding_id: entry.pins.resource_binding_id, state: 'active' });
});
test('cache enrollment and scheduling failures preserve connected state and return a secret-free retry outcome', async () => {
  for (const fail of ['adopt', 'schedule']) { const f = fixture(); f.state.fail = fail;
    const output = await f.complete(f.input) as { state: string; native_email: { state: string } };
    assert.equal(output.state, 'connected'); assert.equal(output.native_email.state, 'unavailable');
    assert.ok(!JSON.stringify(output).includes('SECRET')); assert.deepEqual(f.state.events, fail === 'adopt' ? ['adopt'] : ['adopt', 'schedule']); }
});
test('passive retained status only supplies retry nomination, never enrolls or schedules', async () => {
  const f = fixture(), output = await f.complete({ ...f.input, operation: 'manage', purpose: 'status' }) as { native_email: { state: string } };
  assert.equal(output.native_email.state, 'available'); assert.deepEqual(f.state.events, []);
});
test('disabled flag, unsupported adapter, disconnected health and cleanup do not activate native accounts', async () => {
  const f = fixture(); f.state.enabled = false; assert.equal(await f.complete(f.input), result); f.state.enabled = true;
  assert.equal(await f.complete({ ...f.input, entry: { ...entry, adapter: { handle: entry.adapter.handle } } }), result);
  assert.equal(await f.complete({ ...f.input, purpose: 'disconnect' }), result);
  const disconnected = { ...result, state: 'reauth_required' }; assert.equal(await f.complete({ ...f.input, result: disconnected }), disconnected);
  assert.deepEqual(f.state.events, []);
});
test('aborted completion never publishes a connected enrollment result', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort(Error('Stopped'));
  await assert.rejects(f.complete({ ...f.input, signal: controller.signal }), /Stopped/); assert.deepEqual(f.state.events, []);
});
