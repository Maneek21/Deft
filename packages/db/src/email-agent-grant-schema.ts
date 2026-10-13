import { pgTable, text, integer, jsonb, timestamp, unique, foreignKey } from 'drizzle-orm/pg-core';
import { emailAccounts } from './email-schema.js';
export const emailAgentGrants = pgTable('email_agent_grants', {
  id: text('id').primaryKey(), org_id: text('org_id').notNull(), owner_user_id: text('owner_user_id').notNull(), account_id: text('account_id').notNull(),
  principal_kind: text('principal_kind').$type<'defty'|'personal_mcp'>().notNull(), principal_id: text('principal_id').notNull(),
  operations: jsonb('operations').$type<Array<'read'|'draft'|'triage'|'send'>>().notNull(), revision: integer('revision').notNull(),
  revoked_at: timestamp('revoked_at', {withTimezone:true}), created_at: timestamp('created_at', {withTimezone:true}).defaultNow().notNull(),
  updated_at: timestamp('updated_at', {withTimezone:true}).defaultNow().notNull(),
}, t => [unique('email_agent_grants_principal_unique').on(t.org_id,t.owner_user_id,t.account_id,t.principal_kind,t.principal_id),
  foreignKey({columns:[t.org_id,t.owner_user_id,t.account_id],foreignColumns:[emailAccounts.org_id,emailAccounts.owner_user_id,emailAccounts.account_id]}).onDelete('restrict')]);
