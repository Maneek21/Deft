import { pgTable, text, integer, boolean, timestamp, jsonb, primaryKey, foreignKey, unique, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { emailAccounts } from './email-schema.js';
const scope = () => ({ org_id:text('org_id').notNull(),owner_user_id:text('owner_user_id').notNull(),account_id:text('account_id').notNull() });
const times = () => ({created_at:timestamp('created_at',{withTimezone:true}).defaultNow().notNull(),updated_at:timestamp('updated_at',{withTimezone:true}).defaultNow().notNull()});
export const emailKnowledgePolicies=pgTable('email_knowledge_policies',{
 ...scope(),enabled:boolean('enabled').default(false).notNull(),revision:integer('revision').default(1).notNull(),
 destination:jsonb('destination').$type<{scope:'user'|'space';space_id:string|null}>().notNull(),history_days:integer('history_days').default(30).notNull(),
 include_bulk:boolean('include_bulk').default(false).notNull(),excluded_senders:jsonb('excluded_senders').$type<string[]>().default([]).notNull(),excluded_folders:jsonb('excluded_folders').$type<string[]>().default([]).notNull(),
 history_since:timestamp('history_since',{withTimezone:true}).notNull(),...times(),
},t=>[primaryKey({columns:[t.org_id,t.owner_user_id,t.account_id]}),foreignKey({columns:[t.org_id,t.owner_user_id,t.account_id],foreignColumns:[emailAccounts.org_id,emailAccounts.owner_user_id,emailAccounts.account_id]}),check('email_knowledge_policy_valid',sql`${t.revision}>0 AND ${t.history_days} BETWEEN 1 AND 365`)]);
export const emailKnowledgeObservations=pgTable('email_knowledge_observations',{
 ...scope(),logical_message_id:text('logical_message_id').notNull(),storage_revision:integer('storage_revision').default(0).notNull(),
 policy_revision:integer('policy_revision').default(0).notNull(),content_digest:text('content_digest'),thread_key:text('thread_key'),state:text('state').$type<'captured'|'updated'|'skipped'|'retry'|'suppressed'|'protected'>().default('retry').notNull(),
 suppressed:boolean('suppressed').default(false).notNull(),last_error_code:text('last_error_code'),retry_at:timestamp('retry_at',{withTimezone:true}),attempts:integer('attempts').default(0).notNull(),...times(),
},t=>[primaryKey({columns:[t.org_id,t.owner_user_id,t.account_id,t.logical_message_id]}),foreignKey({columns:[t.org_id,t.owner_user_id,t.account_id],foreignColumns:[emailAccounts.org_id,emailAccounts.owner_user_id,emailAccounts.account_id]})]);
export const emailKnowledgeSources=pgTable('email_knowledge_sources',{
 id:text('id').primaryKey(),...scope(),logical_message_id:text('logical_message_id').notNull(),message_revision:text('message_revision').notNull(),thread_key:text('thread_key').notNull(),
 content_digest:text('content_digest').notNull(),policy_revision:integer('policy_revision').notNull(),provider:text('provider').notNull(),source_digest:text('source_digest').notNull(),
 sender:text('sender').notNull(),received_at:timestamp('received_at',{withTimezone:true}),partial:boolean('partial').default(true).notNull(),...times(),
},t=>[unique('email_knowledge_sources_identity').on(t.org_id,t.owner_user_id,t.account_id,t.logical_message_id,t.content_digest,t.policy_revision),foreignKey({columns:[t.org_id,t.owner_user_id,t.account_id],foreignColumns:[emailAccounts.org_id,emailAccounts.owner_user_id,emailAccounts.account_id]})]);
export const emailKnowledgeThreads=pgTable('email_knowledge_threads',{
 ...scope(),thread_key:text('thread_key').notNull(),destination_key:text('destination_key').notNull(),page_id:text('page_id').notNull(),page_version:integer('page_version').notNull(),last_source_order:text('last_source_order').notNull(),...times(),
},t=>[primaryKey({columns:[t.org_id,t.owner_user_id,t.account_id,t.thread_key,t.destination_key]}),foreignKey({columns:[t.org_id,t.owner_user_id,t.account_id],foreignColumns:[emailAccounts.org_id,emailAccounts.owner_user_id,emailAccounts.account_id]})]);
export const emailKnowledgeBudgets=pgTable('email_knowledge_budgets',{
 org_id:text('org_id').notNull(),day:text('day').notNull(),budget_key:text('budget_key').notNull(),reserved_tokens:integer('reserved_tokens').default(0).notNull(),...times(),
},t=>[primaryKey({columns:[t.org_id,t.day,t.budget_key]}),check('email_knowledge_budget_valid',sql`${t.reserved_tokens}>=0`)]);
