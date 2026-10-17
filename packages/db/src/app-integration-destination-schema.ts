import {jsonb,pgTable,primaryKey,text,timestamp,check} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
import {orgs,users} from './schema.js';
/** A transaction reservation/result, not a generic source registry. App UUIDs
 * cannot use the native Email account FK or mail_ source constraint. */
export const appIntegrationDestinationReceipts=pgTable('app_integration_destination_receipts',{
 org_id:text('org_id').notNull().references(()=>orgs.id,{onDelete:'cascade'}),
 owner_user_id:text('owner_user_id').notNull().references(()=>users.id,{onDelete:'cascade'}),
 request_id:text('request_id').notNull(),request_digest:text('request_digest').notNull(),review_digest:text('review_digest').notNull(),
 destination:jsonb('destination').$type<Record<string,unknown>>().notNull(),source:jsonb('source').$type<Record<string,unknown>>().notNull(),result:jsonb('result').$type<Record<string,unknown>>(),
 created_at:timestamp('created_at',{withTimezone:true}).defaultNow().notNull(),updated_at:timestamp('updated_at',{withTimezone:true}).defaultNow().notNull(),
},t=>[primaryKey({columns:[t.org_id,t.owner_user_id,t.request_id]}),
 check('app_integration_destination_request_digest',sql`${t.request_digest} ~ '^sha256:[a-f0-9]{64}$'`),
 check('app_integration_destination_review_digest',sql`${t.review_digest} ~ '^sha256:[a-f0-9]{64}$'`),
 check('app_integration_destination_destination_shape',sql`jsonb_typeof(${t.destination})='object'`),
 check('app_integration_destination_source_shape',sql`jsonb_typeof(${t.source})='object'`),
 check('app_integration_destination_result_shape',sql`${t.result} IS NULL OR jsonb_typeof(${t.result})='object'`)]);
