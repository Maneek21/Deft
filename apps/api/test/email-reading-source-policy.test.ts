import assert from 'node:assert/strict';
import test from 'node:test';
import { createEmailSourceReadingPolicy } from '../src/lib/email-reading-source-policy.js';
import type { db } from '../src/lib/db.js';
import type { AppConnectionEntry } from '../src/lib/app-connection-registry.js';
const caller = { org_id: 'org', user_id: 'owner', sid: 'sid', access_expires_at: 10000 };
const entry = { pins: { org_id: 'org', owner_user_id: 'owner', installation_id: 'app', app_version_id: 'version',
  grant_snapshot_id: 'grant', target_key: 'personal', resource_key: 'inbox', resource_binding_id: 'binding' },
  adapter: { nativeEmailAccount: async () => { throw Error('Use service connected inspection'); } } } as unknown as AppConnectionEntry;
const record = { data: { account_id: 'stable', provider: 'gmail', logical_message_id: 'logical' },
  provider_source: { schema_version: 'deft.email_provider_source.v1', account_id: 'stable', provider: 'gmail', logical_message_id: 'logical', locator: { secret: 'private-id' } } };
function fixture() {
  const row = { account: { org_id: 'org', owner_user_id: 'owner', account_id: 'stable', resource_binding_id: 'binding', provider: 'gmail', state: 'active', principal_digest: 'a'.repeat(64) },
    binding: { org_id: 'org', owner_user_id: 'owner', id: 'binding', app_installation_id: 'app', app_version_id: 'version', grant_snapshot_id: 'grant', target_key: 'personal', resource_key: 'inbox' } };
  const state = { rows: [row], reads: 0, policy: 'always' as 'ask' | 'always' };
  const query = { from: () => query, innerJoin: () => query, where: () => query, limit: async () => state.rows };
  const database = { select: () => query } as unknown as Pick<typeof db, 'select'>;
  const read = createEmailSourceReadingPolicy(database, async (actor, org, account) => { state.reads++;
    assert.deepEqual(actor, { user_id: 'owner', web_session_id: 'sid', access_expires_at: 10000 }); assert.equal(org, 'org'); assert.equal(account, 'stable');
    return { account_id: account, external_images: state.policy, revision: 2 }; });
  return { state, row, read, input: { caller, entry, record, signal: new AbortController().signal } };
}
test('only exact DB-resolved enrolled account and source identity apply saved host choice; private locator stays private', async () => {
  const f = fixture(); assert.equal(await f.read(f.input), 'always'); assert.equal(f.state.reads, 1);
  f.state.policy = 'ask'; assert.equal(await f.read(f.input), 'ask');
});
test('unenrolled, duplicate, foreign binding or provider identities keep ask without reading another account choice', async () => {
  for (const change of [(f: ReturnType<typeof fixture>) => { f.state.rows = []; },
    (f: ReturnType<typeof fixture>) => { f.state.rows.push(f.row); },
    (f: ReturnType<typeof fixture>) => { f.row.binding.app_installation_id = 'foreign'; },
    (f: ReturnType<typeof fixture>) => { f.row.account.account_id = 'foreign'; },
    (f: ReturnType<typeof fixture>) => { f.row.account.provider = 'microsoft'; },
    (f: ReturnType<typeof fixture>) => { f.row.account.principal_digest = ''; }]) {
    const f = fixture(); change(f); assert.equal(await f.read(f.input), 'ask'); assert.equal(f.state.reads, 0);
  }
  const f = fixture(); assert.equal(await f.read({ ...f.input, record: { ...record, data: { ...record.data, logical_message_id: 'other' } } }), 'ask');
});
