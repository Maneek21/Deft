import { check, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { emailAccounts } from './email-schema.js';

/** Rule titles and predicates stay encrypted; order/state are the only indexed controls. */
export const emailRules = pgTable('email_rules', {
  org_id: text('org_id').notNull(), owner_user_id: text('owner_user_id').notNull(), account_id: text('account_id').notNull(),
  rule_id: text('rule_id').notNull(), revision: integer('revision').notNull(), state: text('state').$type<'active' | 'paused' | 'archived'>().notNull(),
  order_index: integer('order_index').notNull(), content_envelope: jsonb('content_envelope').$type<Record<string, unknown>>().notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  primaryKey({ name: 'email_rules_pkey', columns: [t.org_id, t.owner_user_id, t.account_id, t.rule_id] }),
  foreignKey({ name: 'email_rules_account_fk', columns: [t.org_id, t.owner_user_id, t.account_id],
    foreignColumns: [emailAccounts.org_id, emailAccounts.owner_user_id, emailAccounts.account_id] }).onDelete('restrict'),
  index('email_rules_order_idx').on(t.org_id, t.owner_user_id, t.account_id, t.state, t.order_index, t.rule_id),
  check('email_rules_id_check', sql`${t.rule_id} ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'`),
  check('email_rules_revision_check', sql`${t.revision} BETWEEN 1 AND 2147483647`),
  check('email_rules_state_check', sql`${t.state} IN ('active','paused','archived')`),
  check('email_rules_order_check', sql`${t.order_index} BETWEEN 0 AND 2147483647`),
  check('email_rules_envelope_check', sql`jsonb_typeof(${t.content_envelope})='object' AND octet_length(${t.content_envelope}::text)<=49152`),
]);
