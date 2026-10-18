import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { canonicalCapabilityJson } from '@deft/shared';
import { AppRunSecretEnvelopeSchema } from './app-run-secrets.js';
import type { EmailScope } from './email-mailbox-service.js';
import type { EmailRuleAction } from './email-rule-types.js';
import { emailRuleReceipts } from '@deft/db/schema';

const schema = { emailRuleReceipts };
type Database = Pick<NodePgDatabase<any>, 'transaction'>;
export type EmailRuleReceiptGuard = (tx: unknown) => Promise<void>;
export type EmailRuleReceiptCryptoContext = Readonly<{ org_id: string; owner_user_id: string; account_id: string; kind: 'rule'; record_id: string; revision: number }>;
export type EmailRuleReceiptCipher = Readonly<{ seal(value: unknown, context: EmailRuleReceiptCryptoContext): unknown;
  open(envelope: unknown, context: EmailRuleReceiptCryptoContext): unknown }>;
export type EmailRuleReceiptState = 'planned' | 'reserved' | 'applied' | 'failed' | 'unknown' | 'conflict';
export type EmailRuleReceiptValue = Readonly<{ logical_message_id: string; source_digest: string; action: EmailRuleAction;
  result?: Readonly<{ state: 'succeeded' | 'failed' | 'unknown' | 'prepared'; code?: string }> }>;
export type EmailRuleReceipt = Readonly<{ rule_id: string; rule_revision: number; target_digest: string; action_index: number;
  operation_id: string; storage_revision: number; state: EmailRuleReceiptState; value: EmailRuleReceiptValue }>;
export type EmailRuleReceiptKey = Readonly<{ rule_id: string; rule_revision: number; logical_message_id: string; action_index: number }>;

const context = (scope: EmailScope, ruleId: string, targetDigest: string, actionIndex: number, revision: number): EmailRuleReceiptCryptoContext => ({
  ...scope, kind: 'rule', record_id: `rule-receipt:${ruleId}:${targetDigest}:${actionIndex}`, revision,
});
export function emailRuleTargetDigest(scope: EmailScope, logicalId: string): string {
  return createHash('sha256').update(canonicalCapabilityJson([scope.org_id, scope.owner_user_id, scope.account_id, logicalId])).digest('hex');
}
const where = (scope: EmailScope, key: Pick<EmailRuleReceiptKey, 'rule_id' | 'rule_revision' | 'logical_message_id' | 'action_index'>) => and(
  eq(emailRuleReceipts.org_id, scope.org_id), eq(emailRuleReceipts.owner_user_id, scope.owner_user_id), eq(emailRuleReceipts.account_id, scope.account_id),
  eq(emailRuleReceipts.rule_id, key.rule_id), eq(emailRuleReceipts.rule_revision, key.rule_revision),
  eq(emailRuleReceipts.target_digest, emailRuleTargetDigest(scope, key.logical_message_id)), eq(emailRuleReceipts.action_index, key.action_index));

function materialize(cipher: EmailRuleReceiptCipher, scope: EmailScope, row: typeof emailRuleReceipts.$inferSelect): EmailRuleReceipt {
  const value = cipher.open(AppRunSecretEnvelopeSchema.parse(row.receipt_envelope),
    context(scope, row.rule_id, row.target_digest, row.action_index, row.storage_revision)) as EmailRuleReceiptValue;
  if (!value || typeof value !== 'object' || typeof value.logical_message_id !== 'string' || !/^[a-f0-9]{64}$/u.test(value.source_digest)
    || !['mark_read','mark_unread','star','unstar','archive','trash'].includes(value.action)) throw new Error('EMAIL_RULE_UNAVAILABLE');
  return Object.freeze({ rule_id: row.rule_id, rule_revision: row.rule_revision, target_digest: row.target_digest, action_index: row.action_index,
    operation_id: row.operation_id, storage_revision: row.storage_revision, state: row.state, value });
}
function sealed(cipher: EmailRuleReceiptCipher, scope: EmailScope, ruleId: string, targetDigest: string, actionIndex: number, revision: number, value: EmailRuleReceiptValue) {
  return AppRunSecretEnvelopeSchema.parse(cipher.seal(value, context(scope, ruleId, targetDigest, actionIndex, revision)));
}

/** Fenced per-target receipt store. Effects are never performed in these transactions. */
export class EmailRuleReceiptStore {
  constructor(private readonly database: Database, private readonly cipher: EmailRuleReceiptCipher, private readonly now = () => new Date()) {}

  async prepare(scope: EmailScope, key: EmailRuleReceiptKey, sourceDigest: string, action: EmailRuleAction,
    guard: EmailRuleReceiptGuard, signal?: AbortSignal): Promise<EmailRuleReceipt> {
    if (!/^[a-f0-9]{64}$/u.test(sourceDigest) || !Number.isSafeInteger(key.rule_revision) || key.rule_revision < 1
      || !Number.isSafeInteger(key.action_index) || key.action_index < 0 || key.action_index > 5) throw new Error('EMAIL_RULE_INVALID');
    signal?.throwIfAborted(); const targetDigest = emailRuleTargetDigest(scope, key.logical_message_id), value: EmailRuleReceiptValue = {
      logical_message_id: key.logical_message_id, source_digest: sourceDigest, action,
    };
    return this.database.transaction(async tx => {
      await guard(tx); signal?.throwIfAborted();
      await tx.insert(emailRuleReceipts).values({ ...scope, rule_id: key.rule_id, rule_revision: key.rule_revision, target_digest: targetDigest,
        action_index: key.action_index, operation_id: randomUUID(), storage_revision: 1, state: 'planned',
        receipt_envelope: sealed(this.cipher, scope, key.rule_id, targetDigest, key.action_index, 1, value), created_at: this.now(), updated_at: this.now() }).onConflictDoNothing();
      const [row] = await tx.select().from(emailRuleReceipts).where(where(scope, key)).limit(1).for('update');
      if (!row) throw new Error('EMAIL_RULE_UNAVAILABLE');
      const receipt = materialize(this.cipher, scope, row);
      if (receipt.value.logical_message_id !== key.logical_message_id || receipt.value.source_digest !== sourceDigest || receipt.value.action !== action) throw new Error('EMAIL_RULE_CONFLICT');
      await guard(tx); signal?.throwIfAborted(); return receipt;
    });
  }

  async transition(scope: EmailScope, receipt: EmailRuleReceipt, state: EmailRuleReceiptState, result: EmailRuleReceiptValue['result'],
    guard: EmailRuleReceiptGuard, signal?: AbortSignal): Promise<EmailRuleReceipt> {
    const transitions: Record<EmailRuleReceiptState, readonly EmailRuleReceiptState[]> = {
      planned: ['reserved','failed','conflict'], reserved: ['applied','failed','unknown','conflict'],
      unknown: ['applied','unknown','conflict'], applied: ['applied'], failed: ['failed'], conflict: ['conflict'],
    };
    if (!transitions[receipt.state]?.includes(state)) throw new Error('EMAIL_RULE_CONFLICT');
    signal?.throwIfAborted(); const key = { rule_id: receipt.rule_id, rule_revision: receipt.rule_revision,
      logical_message_id: receipt.value.logical_message_id, action_index: receipt.action_index };
    return this.database.transaction(async tx => {
      await guard(tx); signal?.throwIfAborted(); const [row] = await tx.select().from(emailRuleReceipts).where(where(scope, key)).limit(1).for('update');
      if (!row || row.operation_id !== receipt.operation_id || row.storage_revision !== receipt.storage_revision || row.state !== receipt.state) throw new Error('EMAIL_RULE_CONFLICT');
      const nextRevision = row.storage_revision + 1;
      const value: EmailRuleReceiptValue = { ...receipt.value, ...(result ? { result } : {}) };
      const [updated] = await tx.update(emailRuleReceipts).set({ state, storage_revision: nextRevision,
        receipt_envelope: sealed(this.cipher, scope, receipt.rule_id, receipt.target_digest, receipt.action_index, nextRevision, value), updated_at: this.now() })
        .where(and(where(scope, key), eq(emailRuleReceipts.operation_id, receipt.operation_id), eq(emailRuleReceipts.storage_revision, receipt.storage_revision), eq(emailRuleReceipts.state, receipt.state))).returning();
      if (!updated) throw new Error('EMAIL_RULE_CONFLICT'); await guard(tx); signal?.throwIfAborted(); return materialize(this.cipher, scope, updated);
    });
  }

  async get(scope: EmailScope, key: EmailRuleReceiptKey, guard: EmailRuleReceiptGuard, signal?: AbortSignal): Promise<EmailRuleReceipt | null> {
    signal?.throwIfAborted(); return this.database.transaction(async tx => {
      await guard(tx); signal?.throwIfAborted(); const [row] = await tx.select().from(emailRuleReceipts).where(where(scope, key)).limit(1);
      await guard(tx); signal?.throwIfAborted(); return row ? materialize(this.cipher, scope, row) : null;
    });
  }
}
