import {pgTable,text,integer,timestamp,jsonb,primaryKey,index,check} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
export const appDataConsents=pgTable('app_data_consents',{
  org_id:text('org_id').notNull(),owner_user_id:text('owner_user_id').notNull(),consent_id:text('consent_id').notNull(),
  connection_session_id:text('connection_session_id').notNull(),store_key:text('store_key').notNull(),
  state:text('state').notNull(),consent_digest:text('consent_digest').notNull(),snapshot:jsonb('snapshot').$type<Record<string,unknown>>().notNull(),
  expires_at:timestamp('expires_at',{withTimezone:true}),created_at:timestamp('created_at',{withTimezone:true}).notNull(),
  updated_at:timestamp('updated_at',{withTimezone:true}).notNull(),
},t=>[primaryKey({columns:[t.org_id,t.owner_user_id,t.consent_id]}),
  index('app_data_consents_target_idx').on(t.org_id,t.owner_user_id,t.connection_session_id,t.store_key,t.state),
  check('app_data_consents_state_check',sql`${t.state} IN ('proposed','active','revoked')`),
  check('app_data_consents_snapshot_bound',sql`octet_length(${t.snapshot}::text)<=16384`)]);
export const appDataInvocations=pgTable('app_data_invocations',{
  org_id:text('org_id').notNull(),owner_user_id:text('owner_user_id').notNull(),request_id:text('request_id').notNull(),
  connection_session_id:text('connection_session_id').notNull(),operation:text('operation').notNull(),input_digest:text('input_digest').notNull(),
  state:text('state').notNull(),revision:integer('revision').notNull(),
  web_session_id:text('web_session_id').notNull(),access_expires_at:timestamp('access_expires_at',{withTimezone:true}).notNull(),
  expires_at:timestamp('expires_at',{withTimezone:true}).notNull(),context:jsonb('context').$type<Record<string,unknown>>().notNull(),
  result:jsonb('result').$type<Record<string,unknown>>(),created_at:timestamp('created_at',{withTimezone:true}).notNull(),
  updated_at:timestamp('updated_at',{withTimezone:true}).notNull(),
},t=>[primaryKey({columns:[t.org_id,t.owner_user_id,t.request_id]}),
  index('app_data_invocations_owner_idx').on(t.org_id,t.owner_user_id,t.connection_session_id,t.created_at),
  check('app_data_invocations_state_check',sql`${t.state} IN ('inflight','completed','indeterminate')`),
  check('app_data_invocations_revision_check',sql`${t.revision}>=0`),
  check('app_data_invocations_context_bound',sql`octet_length(${t.context}::text)<=16384 AND (${t.result} IS NULL OR octet_length(${t.result}::text)<=16384)`)]);
