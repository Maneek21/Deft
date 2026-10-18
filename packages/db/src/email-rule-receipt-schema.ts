import { check, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { emailAccounts } from './email-schema.js';
import { emailRules } from './email-rule-schema.js';

/** Per-target idempotency records. Target identities/action details stay encrypted. */
export const emailRuleReceipts = pgTable('email_rule_receipts', {
  org_id: text('org_id').notNull(), owner_user_id: text('owner_user_id').notNull(), account_id: text('account_id').notNull(),
  rule_id: text('rule_id').notNull(), rule_revision: integer('rule_revision').notNull(), target_digest: text('target_digest').notNull(),
  action_index: integer('action_index').notNull(), operation_id: text('operation_id').notNull(), storage_revision: integer('storage_revision').notNull(),
  state: text('state').$type<'planned' | 'reserved' | 'applied' | 'failed' | 'unknown' | 'conflict'>().notNull(),
  receipt_envelope: jsonb('receipt_envelope').$type<Record<string, unknown>>().notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  primaryKey({ name: 'email_rule_receipts_pkey', columns: [t.org_id, t.owner_user_id, t.account_id, t.rule_id, t.rule_revision, t.target_digest, t.action_index] }),
  foreignKey({ name: 'email_rule_receipts_account_fk', columns: [t.org_id, t.owner_user_id, t.account_id],
    foreignColumns: [emailAccounts.org_id, emailAccounts.owner_user_id, emailAccounts.account_id] }).onDelete('restrict'),
  foreignKey({ name: 'email_rule_receipts_rule_fk', columns: [t.org_id, t.owner_user_id, t.account_id, t.rule_id],
    foreignColumns: [emailRules.org_id, emailRules.owner_user_id, emailRules.account_id, emailRules.rule_id] }).onDelete('restrict'),
  check('email_rule_receipts_revision_check', sql`${t.rule_revision} > 0 AND ${t.storage_revision} > 0`),
  check('email_rule_receipts_target_check', sql`${t.target_digest} ~ '^[a-f0-9]{64}$' AND ${t.action_index} BETWEEN 0 AND 5`),
  check('email_rule_receipts_operation_check', sql`${t.operation_id} ~ '^[0-9a-fA-F-]{36}$'`),
  check('email_rule_receipts_state_check', sql`${t.state} IN ('planned','reserved','applied','failed','unknown','conflict')`),
  check('email_rule_receipts_envelope_check', sql`jsonb_typeof(${t.receipt_envelope})='object' AND octet_length(${t.receipt_envelope}::text)<=65536`),
  index('email_rule_receipts_rule_idx').on(t.org_id, t.owner_user_id, t.account_id, t.rule_id, t.rule_revision, t.state),
]);
