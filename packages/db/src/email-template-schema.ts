import { pgTable, text, integer, jsonb, timestamp, primaryKey, foreignKey, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { emailAccounts } from './email-schema.js';

/** Account-owned reusable compose documents. User content including the title
 * stays encrypted; only scope, revision, lifecycle and timestamps are indexed. */
export const emailTemplates = pgTable('email_templates', {
  org_id:text('org_id').notNull(),owner_user_id:text('owner_user_id').notNull(),account_id:text('account_id').notNull(),
  template_id:text('template_id').notNull(),revision:integer('revision').notNull(),status:text('status').$type<'active'|'archived'>().notNull().default('active'),
  content_envelope:jsonb('content_envelope').$type<Record<string,unknown>>().notNull(),
  created_at:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),updated_at:timestamp('updated_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[
  primaryKey({name:'email_templates_pkey',columns:[t.org_id,t.owner_user_id,t.account_id,t.template_id]}),
  foreignKey({name:'email_templates_account_fk',columns:[t.org_id,t.owner_user_id,t.account_id],
    foreignColumns:[emailAccounts.org_id,emailAccounts.owner_user_id,emailAccounts.account_id]}).onDelete('restrict'),
  index('email_templates_owner_idx').on(t.org_id,t.owner_user_id,t.account_id,t.status,t.updated_at,t.template_id),
  check('email_templates_id_check',sql`${t.template_id} ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'`),
  check('email_templates_revision_check',sql`${t.revision} BETWEEN 1 AND 2147483647`),
  check('email_templates_status_check',sql`${t.status} IN ('active','archived')`),
]);
