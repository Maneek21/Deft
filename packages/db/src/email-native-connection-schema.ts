import {pgTable,text,integer,jsonb,timestamp,primaryKey,index,check,foreignKey} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
import {emailAccounts} from './email-schema.js';
const owner=()=>({org_id:text('org_id').notNull(),owner_user_id:text('owner_user_id').notNull()});
const times=()=>({created_at:timestamp('created_at',{withTimezone:true}).defaultNow().notNull(),updated_at:timestamp('updated_at',{withTimezone:true}).defaultNow().notNull()});
/** Bounded setup receipts exist before a mailbox account is activated. The
 * member FK is installed by migration85/apply-extras, avoiding schema cycles. */
export const emailNativeConnectionOwners=pgTable('email_native_connection_owners',{
 ...owner(),request_count:integer('request_count').default(0).notNull(),active_count:integer('active_count').default(0).notNull(),...times(),
},t=>[primaryKey({name:'email_native_connection_owners_pkey',columns:[t.org_id,t.owner_user_id]}),check('email_native_connection_owners_budget_check',sql`${t.request_count} BETWEEN 0 AND 512 AND ${t.active_count} BETWEEN 0 AND 8 AND ${t.active_count}<=${t.request_count}`)]);
export const emailNativeConnectionRequests=pgTable('email_native_connection_requests',{
 ...owner(),request_id:text('request_id').notNull(),account_id:text('account_id').notNull(),provider:text('provider').$type<'gmail'|'microsoft'>().notNull(),
 request_digest:text('request_digest').notNull(),binding_digest:text('binding_digest').notNull(),session_digest:text('session_digest').notNull(),
 state:text('state').$type<'preparing'|'pending'|'exchanging'|'connected'|'failed'|'unknown'|'expired'>().notNull(),revision:integer('revision').notNull(),state_digest:text('state_digest'),
 envelope:jsonb('envelope').$type<Record<string,unknown>>().notNull(),expires_at:timestamp('expires_at',{withTimezone:true}).notNull(),...times(),
},t=>[
 primaryKey({name:'email_native_connection_requests_pkey',columns:[t.org_id,t.owner_user_id,t.request_id]}),
 foreignKey({name:'email_native_connection_requests_owner_fk',columns:[t.org_id,t.owner_user_id],foreignColumns:[emailNativeConnectionOwners.org_id,emailNativeConnectionOwners.owner_user_id]}).onDelete('restrict'),
 index('email_native_connection_requests_state_idx').on(t.org_id,t.owner_user_id,t.state_digest),
 check('email_native_connection_requests_identity_check',sql`${t.request_id} ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' AND length(${t.account_id}) BETWEEN 1 AND 256 AND ${t.provider} IN ('gmail','microsoft') AND ${t.request_digest} ~ '^[a-f0-9]{64}$' AND ${t.binding_digest} ~ '^[a-f0-9]{64}$' AND ${t.session_digest} ~ '^[a-f0-9]{64}$'`),
 check('email_native_connection_requests_state_check',sql`${t.state} IN ('preparing','pending','exchanging','connected','failed','unknown','expired') AND ${t.revision} BETWEEN 1 AND 2147483646 AND (${t.state_digest} IS NULL OR ${t.state_digest} ~ '^[a-f0-9]{64}$') AND (${t.state} NOT IN ('pending','exchanging') OR ${t.state_digest} IS NOT NULL)`),
 check('email_native_connection_requests_envelope_check',sql`jsonb_typeof(${t.envelope})='object' AND octet_length(${t.envelope}::text)<=49152`),
 check('email_native_connection_requests_expiry_check',sql`${t.expires_at}>${t.created_at} AND ${t.expires_at}<=${t.created_at}+interval '10 minutes'`),
]);
/** Immutable native profile/custody descriptor; secrets remain in the existing
 * OAuth encrypted custody format. No App installation/binding rows are needed. */
export const emailNativeAccountConnections=pgTable('email_native_account_connections',{
 ...owner(),account_id:text('account_id').notNull(),provider:text('provider').$type<'gmail'|'microsoft'>().notNull(),principal_digest:text('principal_digest').notNull(),
 bridge_digest:text('bridge_digest').notNull(),revision:integer('revision').default(1).notNull(),descriptor_envelope:jsonb('descriptor_envelope').$type<Record<string,unknown>>().notNull(),...times(),
},t=>[
 primaryKey({name:'email_native_account_connections_pkey',columns:[t.org_id,t.owner_user_id,t.account_id]}),
 foreignKey({name:'email_native_account_connections_account_fk',columns:[t.org_id,t.owner_user_id,t.account_id],foreignColumns:[emailAccounts.org_id,emailAccounts.owner_user_id,emailAccounts.account_id]}).onDelete('restrict'),
 check('email_native_account_connections_identity_check',sql`${t.provider} IN ('gmail','microsoft') AND ${t.principal_digest} ~ '^[a-f0-9]{64}$' AND ${t.bridge_digest} ~ '^[a-f0-9]{64}$' AND ${t.revision}=1`),
 check('email_native_account_connections_envelope_check',sql`jsonb_typeof(${t.descriptor_envelope})='object' AND octet_length(${t.descriptor_envelope}::text)<=8192`),
]);
