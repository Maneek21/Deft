import assert from 'node:assert/strict';
import test from 'node:test';
import { PostgresEmailReadingPreferences } from '../src/lib/email-reading-preferences.js';
import type { ConnectedEmailMailboxAuthority } from '../src/lib/email-mailbox-connected-authority.js';
import { EmailMailboxError } from '../src/lib/email-mailbox-service.js';
const actor = { user_id: 'owner', web_session_id: 'sid', access_expires_at: 10000 };
const scope = { org_id: 'org', owner_user_id: 'owner', account_id: 'account' };
const denied = (error: unknown) => error instanceof EmailMailboxError && error.code === 'EMAIL_ACCESS_DENIED';
function fixture() {
  const state = { row: null as Record<string, unknown> | null, version: 'initial', principal: 'a'.repeat(64), now: 1000,
    checks: 0, race: false, events: [] as string[], afterRead: undefined as (() => void) | undefined, afterWrite: undefined as (() => void) | undefined };
  const tx = {
    select: () => { const query = { from: () => query, where: () => query,
      limit: () => { const result = () => { state.events.push('read'); state.afterRead?.(); return state.row ? [state.row] : []; };
        return { then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve), for: () => Promise.resolve(result()) }; } }; return query; },
    update: () => ({ set: (values: Record<string, unknown>) => ({ where: () => ({ returning: async () => {
      state.row = { ...state.row, ...values }; state.events.push('write'); state.afterWrite?.(); return [state.row]; } }) }) }),
    insert: () => ({ values: (values: Record<string, unknown>) => ({ onConflictDoNothing: () => ({ returning: async () => {
      if (state.race) return []; state.row = { ...values }; state.events.push('write'); state.afterWrite?.(); return [state.row]; } }) }) }),
  };
  const database = { ...tx, transaction: async (run: (value: typeof tx) => Promise<unknown>) => {
    const saved = state.row ? { ...state.row } : null; try { const result = await run(tx); state.events.push('commit'); return result; }
    catch (error) { state.row = saved; state.events.push('rollback'); throw error; }
  } } as unknown as ConstructorParameters<typeof PostgresEmailReadingPreferences>[0];
  const authority = { inspect: async (actual: typeof actor, actualScope: typeof scope, _op: string, transaction?: unknown) => {
    assert.deepEqual(actual, actor); assert.deepEqual(actualScope, scope); state.events.push(transaction ? 'held-authority' : 'authority'); state.checks++;
    return { capability: { authority_version: state.version }, account: { principal_digest: state.principal, provider: 'gmail' } };
  } } as unknown as Pick<ConnectedEmailMailboxAuthority, 'inspect'>;
  const service = new PostgresEmailReadingPreferences(database, async () => ({ authority }), () => state.now);
  return { state, service };
}
test('missing preference defaults to ask and every read checks fresh connected human authority on both sides', async () => {
  const f = fixture(); assert.deepEqual(await f.service.get(actor, 'org', 'account'), { account_id: 'account', external_images: 'ask', revision: 1 });
  assert.deepEqual(f.state.events, ['authority', 'read', 'authority']);
  f.state.afterRead = () => { f.state.version = 'revoked'; }; await assert.rejects(f.service.get(actor, 'org', 'account'), denied);
});
test('explicit first choice saves revision two, subsequent CAS choice changes to ask; stale tab cannot overwrite', async () => {
  const f = fixture(); assert.deepEqual(await f.service.update(actor, 'org', 'account', { external_images: 'always', expected_revision: 1 }),
    { account_id: 'account', external_images: 'always', revision: 2 });
  assert.deepEqual(f.state.events, ['held-authority', 'read', 'write', 'held-authority', 'commit']);
  await assert.rejects(f.service.update(actor, 'org', 'account', { external_images: 'ask', expected_revision: 1 }),
    (error: unknown) => error instanceof EmailMailboxError && error.code === 'EMAIL_CHECKPOINT_CONFLICT');
  assert.equal(f.state.row?.external_images, 'always');
  assert.equal((await f.service.update(actor, 'org', 'account', { external_images: 'ask', expected_revision: 2 })).revision, 3);
});
test('revocation, changed provider principal and expiry after SQL write roll back the choice', async () => {
  for (const change of ['version', 'principal', 'expiry']) { const f = fixture(); f.state.afterWrite = () => {
    if (change === 'version') f.state.version = 'new'; if (change === 'principal') f.state.principal = 'b'.repeat(64); if (change === 'expiry') f.state.now = 10000;
  }; await assert.rejects(f.service.update(actor, 'org', 'account', { external_images: 'always', expected_revision: 1 }), denied);
    assert.equal(f.state.row, null); assert.equal(f.state.events.at(-1), 'rollback'); }
});
test('foreign preference rows and first-save unique races do not leak or overwrite another choice', async () => {
  const f = fixture(); f.state.row = { ...scope, owner_user_id: 'other', external_images: 'always', revision: 2 };
  await assert.rejects(f.service.get(actor, 'org', 'account'), denied);
  f.state.row = null; f.state.race = true;
  await assert.rejects(f.service.update(actor, 'org', 'account', { external_images: 'always', expected_revision: 1 }),
    (error: unknown) => error instanceof EmailMailboxError && error.code === 'EMAIL_CHECKPOINT_CONFLICT');
});
test('cancelled requests and invalid or extra update fields do not enter custody or SQL', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort(Error('Stopped'));
  await assert.rejects(f.service.get(actor, 'org', 'account', controller.signal), /Stopped/);
  await assert.rejects(f.service.update(actor, 'org', 'account', { external_images: 'always', expected_revision: 1, grant_agent: true } as never));
  assert.deepEqual(f.state.events, []);
});
