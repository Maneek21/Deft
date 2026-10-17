import {pgTable,text,timestamp,integer,jsonb,primaryKey} from 'drizzle-orm/pg-core';
/** SQL101 installs the deferred common-carrier identity and immutability guards.
 * This declaration is not a replacement for the fresh-push extras script. */
export const appConnectionForms=pgTable('app_connection_forms',{
 org_id:text('org_id').notNull(),owner_user_id:text('owner_user_id').notNull(),session_id:text('session_id').notNull(),
 web_session_id:text('web_session_id').notNull(),access_expires_at:timestamp('access_expires_at',{withTimezone:true}).notNull(),
 revision:integer('revision').notNull(),record:jsonb('record').notNull(),created_at:timestamp('created_at',{withTimezone:true}).notNull(),updated_at:timestamp('updated_at',{withTimezone:true}).notNull(),
},t=>[primaryKey({columns:[t.org_id,t.owner_user_id,t.session_id]})]);
