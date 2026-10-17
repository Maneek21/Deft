import {pgTable,text,integer,timestamp,jsonb,primaryKey,foreignKey,check} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
import {emailAccounts} from './email-schema.js';
export const emailAccountConsents=pgTable('email_account_consents',{
 org_id:text('org_id').notNull(),owner_user_id:text('owner_user_id').notNull(),account_id:text('account_id').notNull(),
 provider:text('provider').$type<'gmail'|'microsoft'|'imap_smtp'>().notNull(),principal_digest:text('principal_digest').notNull(),
 revision:integer('revision').notNull(),native_revision:integer('native_revision').notNull(),credential_revision:integer('credential_revision').notNull(),
 state:text('state').$type<'active'|'paused'|'disconnected'|'revoked'>().notNull(),capabilities:jsonb('capabilities').$type<('read'|'modify'|'send')[]>().notNull(),
 bridge_digest:text('bridge_digest').notNull(),bridge_envelope:jsonb('bridge_envelope').$type<Record<string,unknown>>().notNull(),
 consented_at:timestamp('consented_at',{withTimezone:true}).notNull(),updated_at:timestamp('updated_at',{withTimezone:true}).notNull(),revoked_at:timestamp('revoked_at',{withTimezone:true}),
},t=>[
 primaryKey({name:'email_account_consents_pkey',columns:[t.org_id,t.owner_user_id,t.account_id]}),
 foreignKey({name:'email_account_consents_account_fk',columns:[t.org_id,t.owner_user_id,t.account_id],foreignColumns:[emailAccounts.org_id,emailAccounts.owner_user_id,emailAccounts.account_id]}).onDelete('restrict'),
 check('email_account_consents_provider_check',sql`${t.provider} IN ('gmail','microsoft','imap_smtp')`),
 check('email_account_consents_identity_check',sql`${t.principal_digest} ~ '^[a-f0-9]{64}$' AND ${t.bridge_digest} ~ '^[a-f0-9]{64}$'`),
 check('email_account_consents_revision_check',sql`${t.revision}>0 AND ${t.native_revision}>0 AND ${t.credential_revision}>0`),
 check('email_account_consents_bridge_bound_check',sql`octet_length(${t.bridge_envelope}::text)<=8192`),
 check('email_account_consents_state_check',sql`${t.state} IN ('active','paused','disconnected','revoked') AND ((${t.state}='revoked')=(${t.revoked_at} IS NOT NULL))`),
 check('email_account_consents_capabilities_check',sql`${t.capabilities} IN ('["read"]'::jsonb,'["modify","read"]'::jsonb,'["read","send"]'::jsonb,'["modify","read","send"]'::jsonb)`),
]);
