import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { emailAccounts } from '@deft/db/schema';
import { emailRules } from '@deft/db/schema';
import { EmailMailboxCrypto } from '../src/lib/email-mailbox-crypto.js';
import { EmailRuleStore } from '../src/lib/email-rule-store.js';
import type { EmailRuleContent } from '../src/lib/email-rule-types.js';

const isolatedUrl = 'postgresql://gate_g_test@127.0.0.1:55435/email_stage34_rules_fixture_83';
const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = target === isolatedUrl && process.env.DATABASE_URL === isolatedUrl;
const schema = { emailAccounts, emailRules };
const content = (name: string): EmailRuleContent => ({ name, match: 'all',
  conditions: [{ field: 'from', operator: 'contains', value: 'example.test' }], exceptions: [],
  actions: ['mark_read'], stop_processing: false, execution_location: 'deft_service' });

test('isolated PostgreSQL rule store encryption, account scope, CAS, ordering and cursor invalidation', { skip: !safe, timeout: 120000 }, async t => {
  const pool = new pg.Pool({ connectionString: target, max: 8 });
  const db = drizzle(pool, { schema });
  const check = await pool.query('SELECT current_database() AS db,current_user AS role,inet_server_port() AS port,host(inet_server_addr()) AS host');
  assert.deepEqual(check.rows[0], { db: 'email_stage34_rules_fixture_83', role: 'gate_g_test', port: 55435, host: '127.0.0.1' });
  const identity = await pool.query('SELECT org_id,owner_user_id,resource_binding_id FROM email_accounts LIMIT 1');
  assert.ok(identity.rows[0], 'fixture has a synthetic owner and exact reviewed binding');
  const base = identity.rows[0]!;
  const scope = { org_id: base.org_id as string, owner_user_id: base.owner_user_id as string, account_id: `rule-test-${randomUUID()}` };
  const guard = async (tx: unknown) => {
    const [account] = await (tx as typeof db).select({ account_id: emailAccounts.account_id }).from(emailAccounts).where(and(
      eq(emailAccounts.org_id, scope.org_id), eq(emailAccounts.owner_user_id, scope.owner_user_id), eq(emailAccounts.account_id, scope.account_id))).limit(1).for('share');
    if (!account) throw new Error('fixture authority revoked');
  };
  const keys = { current: () => ({ key_id: 'rule-test-key', key: Buffer.alloc(32, 31) }),
    read: (_purpose: unknown, key: string) => key === 'rule-test-key' ? { key_id: key, key: Buffer.alloc(32, 31) } : null,
    keyIds: () => ['rule-test-key'] };
  const store = new EmailRuleStore(db, new EmailMailboxCrypto(keys));
  const ids = Array.from({ length: 3 }, () => randomUUID());
  await pool.query("INSERT INTO email_accounts (org_id,owner_user_id,account_id,provider,resource_binding_id,principal_digest,state,authority_revision,consented_at) VALUES ($1,$2,$3,'gmail',$4,$5,'active',1,now())",[scope.org_id,scope.owner_user_id,scope.account_id,base.resource_binding_id,'a'.repeat(64)]);
  t.after(async () => {
    await pool.query('DELETE FROM email_rules WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3', Object.values(scope));
    await db.delete(emailAccounts).where(and(eq(emailAccounts.org_id, scope.org_id), eq(emailAccounts.owner_user_id, scope.owner_user_id), eq(emailAccounts.account_id, scope.account_id)));
    await pool.end();
  });

  const first = await store.create(scope, ids[0]!, content('Internal label: invoices'), guard);
  assert.equal(first.revision, 1);
  assert.equal((await store.create(scope, ids[0]!, content('Internal label: invoices'), guard)).rule_id, ids[0]);
  await store.create(scope, ids[1]!, content('Internal label: follow up'), guard);
  const dump = await pool.query('SELECT content_envelope::text AS value FROM email_rules WHERE account_id=$1', [scope.account_id]);
  assert.equal(JSON.stringify(dump.rows).includes('Internal label'), false, 'rule names/conditions stay encrypted');

  const page1 = await store.list(scope, null, 1, guard);
  assert.equal(page1.items.length, 1); assert.equal(page1.has_more, true); assert.ok(page1.next_cursor);
  const page2 = await store.list(scope, page1.next_cursor, 1, guard);
  assert.equal(page2.items.length, 1); assert.equal(page2.has_more, false);
  await assert.rejects(store.list(scope, page1.next_cursor!.slice(0, -1) + (page1.next_cursor!.endsWith('A') ? 'B' : 'A'), 1, guard), /EMAIL_RULE_INVALID/u);
  await assert.rejects(store.list({ ...scope, account_id: 'foreign' }, page1.next_cursor, 1, guard), /EMAIL_RULE_INVALID/u);

  const updated = await store.update(scope, ids[0]!, 1, content('Renamed invoice'), 'paused', guard);
  assert.equal(updated.revision, 2); assert.equal(updated.state, 'paused');
  await assert.rejects(store.update(scope, ids[0]!, 1, content('stale'), 'active', guard), /EMAIL_RULE_CONFLICT/u);
  await assert.rejects(store.list(scope, page1.next_cursor, 1, guard), /EMAIL_RULE_INVALID/u, 'cursor binds current rule-order snapshot');
  const ordered = await store.reorder(scope, [{ rule_id: ids[1]!, expected_revision: 1 }, { rule_id: ids[0]!, expected_revision: 2 }], guard);
  assert.deepEqual(ordered.map(value => value.order_index), [0, 1]);
  assert.equal(ordered[1]!.revision, 3);
  const archived = await store.archive(scope, ids[0]!, 3, guard);
  assert.equal(archived.state, 'archived'); assert.equal(archived.revision, 4);
  assert.equal((await store.list(scope, null, 50, guard)).items.length, 1);
  assert.equal(await store.read({ ...scope, owner_user_id: 'foreign-owner' }, ids[0]!, guard), null);
  assert.equal(await db.select().from(emailRules).where(eq(emailRules.account_id, scope.account_id)).then(rows => rows.length), 2);
  const paused=await store.create(scope,ids[2]!,content('Initially paused'),guard,undefined,'paused');
  assert.equal(paused.state,'paused');assert.equal(paused.revision,1);
  assert.equal((await store.active(scope,guard)).some(row=>row.rule_id===ids[2]),false);
  assert.equal((await store.create(scope,ids[2]!,content('Initially paused'),guard,undefined,'paused')).revision,1);
  await assert.rejects(store.create(scope,ids[2]!,content('Initially paused'),guard,undefined,'active'),/EMAIL_RULE_CONFLICT/);
});
