import {pgTable,text,integer,timestamp,jsonb,primaryKey,foreignKey,check} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
import {emailAccounts} from './email-schema.js';

/** Durable operation reservations survive process loss. Expiring a lease never
 * resets an encrypted started item or authorizes repeating a provider write. */
export const emailOperations=pgTable('email_operations',{
  org_id:text('org_id').notNull(),owner_user_id:text('owner_user_id').notNull(),account_id:text('account_id').notNull(),
  operation_id:text('operation_id').notNull(),kind:text('kind').$type<'triage'|'draft_sync'|'send_upload'|'sent_copy'|'folder_manage'>().notNull(),
  revision:integer('revision').default(0).notNull(),content_envelope:jsonb('content_envelope').$type<Record<string,unknown>>(),
  lease_token:text('lease_token'),lease_until:timestamp('lease_until',{withTimezone:true}),
  created_at:timestamp('created_at',{withTimezone:true}).defaultNow().notNull(),updated_at:timestamp('updated_at',{withTimezone:true}).defaultNow().notNull(),
},t=>[
  primaryKey({name:'email_operations_pkey',columns:[t.org_id,t.owner_user_id,t.account_id,t.operation_id]}),
  foreignKey({name:'email_operations_account_fk',columns:[t.org_id,t.owner_user_id,t.account_id],foreignColumns:[emailAccounts.org_id,emailAccounts.owner_user_id,emailAccounts.account_id]}).onDelete('restrict'),
  check('email_operations_kind_check',sql`${t.kind} IN ('triage','draft_sync','send_upload','sent_copy','folder_manage')`),
  check('email_operations_revision_check',sql`${t.revision}>=0 AND ((${t.revision}=0 AND ${t.content_envelope} IS NULL) OR (${t.revision}>0 AND ${t.content_envelope} IS NOT NULL))`),
  check('email_operations_lease_check',sql`(${t.lease_token} IS NULL)=(${t.lease_until} IS NULL)`),
]);
