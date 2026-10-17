import {pgTable,text,integer,timestamp,jsonb,primaryKey,index,check} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
export const appConnectionConsentContinuations=pgTable('app_connection_consent_continuations',{
  org_id:text('org_id').notNull(),owner_user_id:text('owner_user_id').notNull(),session_id:text('session_id').notNull(),
  source_session_id:text('source_session_id').notNull(),resource_binding_id:text('resource_binding_id').notNull(),
  web_session_id:text('web_session_id').notNull(),access_expires_at:timestamp('access_expires_at',{withTimezone:true}).notNull(),
  authority_operation:text('authority_operation').notNull(),authority_expires_at:timestamp('authority_expires_at',{withTimezone:true}).notNull(),
  revision:integer('revision').notNull(),record:jsonb('record').$type<Record<string,unknown>>().notNull(),
  created_at:timestamp('created_at',{withTimezone:true}).notNull(),updated_at:timestamp('updated_at',{withTimezone:true}).notNull(),
},t=>[primaryKey({columns:[t.org_id,t.owner_user_id,t.session_id]}),
  index('app_connection_consent_continuations_owner_idx').on(t.org_id,t.owner_user_id,t.updated_at),
  check('app_connection_consent_continuations_record_bound',sql`octet_length(${t.record}::text)<=32768`),
  check('app_connection_consent_continuations_revision_check',sql`${t.revision}>=0`)]);
