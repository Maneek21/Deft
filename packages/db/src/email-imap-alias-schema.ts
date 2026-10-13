import {pgTable,text,integer,jsonb,timestamp,primaryKey,foreignKey,index,check} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
import {emailMessages} from './email-schema.js';
import {emailOperations} from './email-operation-schema.js';
const scope=()=>({org_id:text('org_id').notNull(),owner_user_id:text('owner_user_id').notNull(),account_id:text('account_id').notNull(),logical_message_id:text('logical_message_id').notNull()});
export const emailImapAliases=pgTable('email_imap_aliases',{
 ...scope(),locator_key:text('locator_key').notNull(),revision:integer('revision').notNull(),
 evidence_envelope:jsonb('evidence_envelope').$type<Record<string,unknown>>().notNull(),
 updated_at:timestamp('updated_at',{withTimezone:true}).defaultNow().notNull(),
},t=>[
 primaryKey({name:'email_imap_aliases_pkey',columns:[t.org_id,t.owner_user_id,t.account_id,t.locator_key]}),
 foreignKey({name:'email_imap_aliases_message_fk',columns:[t.org_id,t.owner_user_id,t.account_id,t.logical_message_id],foreignColumns:[emailMessages.org_id,emailMessages.owner_user_id,emailMessages.account_id,emailMessages.logical_message_id]}).onDelete('restrict'),
 index('email_imap_aliases_message_idx').on(t.org_id,t.owner_user_id,t.account_id,t.logical_message_id),
 check('email_imap_aliases_identity_check',sql`${t.locator_key} ~ '^[a-f0-9]{64}$' AND ${t.revision}>0`),
]);
/** One unresolved reservation per message. Unknown effects retain this fence;
 * another MOVE cannot consume unbounded slots or guess the new server UID. */
export const emailImapMoveReservations=pgTable('email_imap_move_reservations',{
 ...scope(),operation_id:text('operation_id').notNull(),source_digest:text('source_digest').notNull(),
 reservation_envelope:jsonb('reservation_envelope').$type<Record<string,unknown>>().notNull(),
 created_at:timestamp('created_at',{withTimezone:true}).defaultNow().notNull(),
},t=>[
 primaryKey({name:'email_imap_move_reservations_pkey',columns:[t.org_id,t.owner_user_id,t.account_id,t.logical_message_id]}),
 foreignKey({name:'email_imap_move_reservations_message_fk',columns:[t.org_id,t.owner_user_id,t.account_id,t.logical_message_id],foreignColumns:[emailMessages.org_id,emailMessages.owner_user_id,emailMessages.account_id,emailMessages.logical_message_id]}).onDelete('restrict'),
 foreignKey({name:'email_imap_move_reservations_operation_fk',columns:[t.org_id,t.owner_user_id,t.account_id,t.operation_id],foreignColumns:[emailOperations.org_id,emailOperations.owner_user_id,emailOperations.account_id,emailOperations.operation_id]}).onDelete('restrict'),
 check('email_imap_move_reservations_identity_check',sql`${t.source_digest} ~ '^[a-f0-9]{64}$' AND ${t.operation_id} ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'`),
]);
