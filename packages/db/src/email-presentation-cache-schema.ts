import {pgTable,text,integer,jsonb,timestamp,primaryKey,foreignKey,index,check} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
import {emailAccounts} from './email-schema.js';

/** Rebuildable encrypted reader copies; eviction never removes source mail. */
export const emailPresentationCache=pgTable('email_presentation_cache',{
 org_id:text('org_id').notNull(),owner_user_id:text('owner_user_id').notNull(),account_id:text('account_id').notNull(),
 cache_key:text('cache_key').notNull(),revision:integer('revision').default(1).notNull(),
 content_envelope:jsonb('content_envelope').$type<Record<string,unknown>>().notNull(),
 byte_length:integer('byte_length').notNull(),expires_at:timestamp('expires_at',{withTimezone:true}).notNull(),
 created_at:timestamp('created_at',{withTimezone:true}).defaultNow().notNull(),updated_at:timestamp('updated_at',{withTimezone:true}).defaultNow().notNull(),
},t=>[
 primaryKey({name:'email_presentation_cache_pkey',columns:[t.org_id,t.owner_user_id,t.account_id,t.cache_key]}),
 foreignKey({name:'email_presentation_cache_account_fk',columns:[t.org_id,t.owner_user_id,t.account_id],foreignColumns:[emailAccounts.org_id,emailAccounts.owner_user_id,emailAccounts.account_id]}).onDelete('restrict'),
 index('email_presentation_cache_expiry_idx').on(t.org_id,t.owner_user_id,t.account_id,t.expires_at),
 check('email_presentation_cache_value_check',sql`${t.cache_key} ~ '^[a-f0-9]{64}$' AND ${t.revision}=1 AND ${t.byte_length} BETWEEN 1 AND 491520 AND ${t.expires_at}>${t.created_at}`),
]);
