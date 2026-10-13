import {pgTable,text,integer,jsonb,timestamp,primaryKey,foreignKey,check} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
import {emailAccounts} from './email-schema.js';

/** Per-account sender-identity preferences. Addresses and signature bodies are
 * encrypted together; the row exposes only account scope and CAS metadata. */
export const emailSignatures=pgTable('email_signatures',{
 org_id:text('org_id').notNull(),owner_user_id:text('owner_user_id').notNull(),account_id:text('account_id').notNull(),
 revision:integer('revision').notNull(),preferences_envelope:jsonb('preferences_envelope').$type<Record<string,unknown>>().notNull(),
 created_at:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),updated_at:timestamp('updated_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[
 primaryKey({name:'email_signatures_pkey',columns:[t.org_id,t.owner_user_id,t.account_id]}),
 foreignKey({name:'email_signatures_account_fk',columns:[t.org_id,t.owner_user_id,t.account_id],foreignColumns:[emailAccounts.org_id,emailAccounts.owner_user_id,emailAccounts.account_id]}).onDelete('restrict'),
 check('email_signatures_revision_check',sql`${t.revision} BETWEEN 1 AND 2147483647`),
]);
