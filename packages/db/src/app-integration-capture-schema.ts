import {pgTable,text,integer,boolean,jsonb,timestamp,unique,foreignKey,check} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
import {appInstallations,users,orgs,wikiPages} from './schema.js';
const scope=()=>({org_id:text('org_id').notNull(),owner_user_id:text('owner_user_id').notNull(),installation_id:text('installation_id').notNull(),account_ref:text('account_ref').notNull(),store_key:text('store_key').notNull()});
const times=()=>({created_at:timestamp('created_at',{withTimezone:true}).defaultNow().notNull(),updated_at:timestamp('updated_at',{withTimezone:true}).defaultNow().notNull()});
export const appIntegrationCapturePolicies=pgTable('app_integration_capture_policies',{
 id:text('id').primaryKey(),...scope(),revision:integer('revision').notNull(),enabled:boolean('enabled').default(false).notNull(),
 input:jsonb('input').$type<Record<string,unknown>>().notNull(),history_since:timestamp('history_since',{withTimezone:true}).notNull(),scan_checkpoint_id:text('scan_checkpoint_id'),scan_after_projection_id:text('scan_after_projection_id'),...times(),
},t=>[unique('app_integration_capture_policy_scope').on(t.org_id,t.owner_user_id,t.installation_id,t.account_ref,t.store_key),
 unique('app_integration_capture_policy_org_id').on(t.org_id,t.id),foreignKey({columns:[t.org_id],foreignColumns:[orgs.id]}),
 foreignKey({columns:[t.owner_user_id],foreignColumns:[users.id]}),foreignKey({columns:[t.org_id,t.installation_id],foreignColumns:[appInstallations.org_id,appInstallations.id]}),
 check('app_integration_capture_policy_revision',sql`${t.revision}>0`)]);
export const appIntegrationCaptureClaims=pgTable('app_integration_capture_claims',{
 id:text('id').primaryKey(),...scope(),policy_id:text('policy_id').notNull(),policy_revision:integer('policy_revision').notNull(),
 thread_key:text('thread_key').notNull(),body_digest:text('body_digest').notNull(),target:jsonb('target').$type<Record<string,unknown>>().notNull(),
 state:text('state').$type<'processing'|'captured'|'updated'|'skipped'|'protected'|'failed'>().default('processing').notNull(),
 page_id:text('page_id'),error_code:text('error_code'),...times(),
},t=>[unique('app_integration_capture_claim_identity').on(t.org_id,t.owner_user_id,t.installation_id,t.account_ref,t.store_key,t.policy_revision,t.thread_key,t.body_digest),
 unique('app_integration_capture_claim_org_id').on(t.org_id,t.id),foreignKey({columns:[t.org_id,t.policy_id],foreignColumns:[appIntegrationCapturePolicies.org_id,appIntegrationCapturePolicies.id]}),
 check('app_integration_capture_claim_valid',sql`${t.policy_revision}>0 AND ${t.body_digest} ~ '^sha256:[a-f0-9]{64}$' AND ${t.thread_key} ~ '^sha256:[a-f0-9]{64}$'`),check('app_integration_capture_claim_state',sql`${t.state} IN ('processing','captured','updated','skipped','protected','failed')`)]);
export const appIntegrationCaptureThreads=pgTable('app_integration_capture_threads',{
 id:text('id').primaryKey(),...scope(),thread_key:text('thread_key').notNull(),destination_key:text('destination_key').notNull(),
 page_id:text('page_id').notNull(),page_version:integer('page_version').notNull(),last_observed_at:timestamp('last_observed_at',{withTimezone:true}).notNull(),...times(),
},t=>[unique('app_integration_capture_thread_identity').on(t.org_id,t.owner_user_id,t.installation_id,t.account_ref,t.store_key,t.thread_key,t.destination_key),
 foreignKey({columns:[t.page_id],foreignColumns:[wikiPages.id]}),check('app_integration_capture_thread_version',sql`${t.page_version}>0`)]);
export const appIntegrationCaptureSources=pgTable('app_integration_capture_sources',{
 id:text('id').primaryKey(),...scope(),claim_id:text('claim_id').notNull(),page_id:text('page_id').notNull(),
 target:jsonb('target').$type<Record<string,unknown>>().notNull(),publication:jsonb('publication').$type<Record<string,unknown>>().notNull(),
 thread_key:text('thread_key').notNull(),body_digest:text('body_digest').notNull(),observed_at:timestamp('observed_at',{withTimezone:true}).notNull(),
 partial:boolean('partial').default(true).notNull(),...times(),
},t=>[unique('app_integration_capture_source_claim').on(t.org_id,t.claim_id),
 foreignKey({columns:[t.org_id,t.claim_id],foreignColumns:[appIntegrationCaptureClaims.org_id,appIntegrationCaptureClaims.id]}),
 foreignKey({columns:[t.page_id],foreignColumns:[wikiPages.id]}),check('app_integration_capture_partial',sql`${t.partial}=true`)]);
