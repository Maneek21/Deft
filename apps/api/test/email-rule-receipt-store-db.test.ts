import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { emailAccounts } from '@deft/db/schema';
import { emailRules, emailRuleReceipts } from '@deft/db/schema';
import { EmailMailboxCrypto } from '../src/lib/email-mailbox-crypto.js';
import { EmailRuleReceiptStore } from '../src/lib/email-rule-receipt-store.js';
import { EmailRuleStore } from '../src/lib/email-rule-store.js';
import { listEmailMailboxKeyReferences } from '../src/lib/email-mailbox-key-references.js';
import type { EmailRuleContent } from '../src/lib/email-rule-types.js';

const isolatedUrl = 'postgresql://gate_g_test@127.0.0.1:55435/email_stage34_rules_fixture_83';
const safe = process.env.DEFT_TEST_DATABASE_URL === isolatedUrl && process.env.DATABASE_URL === isolatedUrl;
const schema = { emailAccounts, emailRuleReceipts, emailRules };
const content: EmailRuleContent = { name: 'Follow invoices', match: 'all', conditions: [{ field: 'subject', operator: 'contains', value: 'invoice' }],
  exceptions: [], actions: ['mark_read','star'], stop_processing: false, execution_location: 'deft_service' };

test('isolated PostgreSQL rule receipts are private, scoped, fenced and stable on replay', { skip: !safe, timeout: 120000 }, async t => {
  const pool = new pg.Pool({ connectionString: isolatedUrl, max: 8 }), db = drizzle(pool, { schema });
  const identity = (await pool.query('SELECT org_id,owner_user_id,resource_binding_id FROM email_accounts LIMIT 1')).rows[0]!;
  const scope = { org_id: identity.org_id as string, owner_user_id: identity.owner_user_id as string, account_id: `rule-receipt-${randomUUID()}` };
  await db.insert(emailAccounts).values({ ...scope, provider: 'gmail', resource_binding_id: identity.resource_binding_id as string,
    principal_digest: 'b'.repeat(64), state: 'active', authority_revision: 1, consented_at: new Date() });
  const guard = async (tx: unknown) => {
    const [row] = await (tx as typeof db).select({ account_id: emailAccounts.account_id }).from(emailAccounts).where(and(
      eq(emailAccounts.org_id, scope.org_id), eq(emailAccounts.owner_user_id, scope.owner_user_id), eq(emailAccounts.account_id, scope.account_id))).limit(1).for('share');
    if (!row) throw new Error('fixture authority revoked');
  };
  const keys = { current: () => ({ key_id: 'rule-receipt-key', key: Buffer.alloc(32, 49) }),
    read: (_purpose: unknown, key: string) => key === 'rule-receipt-key' ? { key_id: key, key: Buffer.alloc(32, 49) } : null,
    keyIds: () => ['rule-receipt-key'] };
  const cipher = new EmailMailboxCrypto(keys), rules = new EmailRuleStore(db, cipher), receipts = new EmailRuleReceiptStore(db, cipher);
  const ruleId = randomUUID(), logicalId = `mail_${'c'.repeat(64)}`, target = { rule_id: ruleId, rule_revision: 1, logical_message_id: logicalId, action_index: 0 };
  t.after(async () => {
    await db.delete(emailRuleReceipts).where(and(eq(emailRuleReceipts.org_id, scope.org_id), eq(emailRuleReceipts.owner_user_id, scope.owner_user_id), eq(emailRuleReceipts.account_id, scope.account_id)));
    await db.delete(emailRules).where(and(eq(emailRules.org_id, scope.org_id), eq(emailRules.owner_user_id, scope.owner_user_id), eq(emailRules.account_id, scope.account_id)));
    await db.delete(emailAccounts).where(and(eq(emailAccounts.org_id, scope.org_id), eq(emailAccounts.owner_user_id, scope.owner_user_id), eq(emailAccounts.account_id, scope.account_id)));
    await pool.end();
  });
  await rules.create(scope, ruleId, content, guard);
  const sourceDigest = 'd'.repeat(64);
  const [one, two] = await Promise.all([receipts.prepare(scope, target, sourceDigest, 'mark_read', guard), receipts.prepare(scope, target, sourceDigest, 'mark_read', guard)]);
  assert.equal(one.operation_id, two.operation_id); assert.equal(one.state, 'planned');
  const reserved = await receipts.transition(scope, one, 'reserved', undefined, guard);
  const applied = await receipts.transition(scope, reserved, 'applied', { state: 'succeeded' }, guard);
  assert.equal(applied.storage_revision, 3); assert.equal(applied.value.logical_message_id, logicalId);
  assert.equal((await receipts.prepare(scope, target, sourceDigest, 'mark_read', guard)).operation_id, one.operation_id);
  await assert.rejects(receipts.prepare(scope, target, 'e'.repeat(64), 'mark_read', guard), /EMAIL_RULE_CONFLICT/u);
  await assert.rejects(receipts.prepare({ ...scope, account_id: 'foreign' }, target, sourceDigest, 'mark_read', guard));
  const raw = await pool.query('SELECT target_digest,receipt_envelope::text AS envelope FROM email_rule_receipts WHERE account_id=$1', [scope.account_id]);
  assert.equal(raw.rows.length, 1); assert.notEqual(raw.rows[0]?.target_digest, logicalId); assert.equal(raw.rows[0]?.envelope.includes(logicalId), false);
  const refs = await db.transaction(tx => listEmailMailboxKeyReferences(tx as never));
  assert.ok(refs.some(ref => ref.key_id === 'rule-receipt-key'));
  assert.equal((await receipts.get(scope, { ...target, action_index: 1 }, guard)), null);
});
