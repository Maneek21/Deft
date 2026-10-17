import {pgTable,text,integer,timestamp,jsonb,uuid,primaryKey,foreignKey,index,check} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
import {emailAccounts} from './email-schema.js';
import {emailOutbox} from './email-outbox-schema.js';
import {events} from './schema.js';
const scope=()=>({org_id:text('org_id').notNull(),owner_user_id:text('owner_user_id').notNull(),account_id:text('account_id').notNull()});
/** Bridge identity/version/receipts only. Existing events remain the Calendar
 * content source. UID/organizer/description/recurrence model stay encrypted. */
export const emailCalendarInvitations=pgTable('email_calendar_invitations',{
 ...scope(),invitation_id:text('invitation_id').notNull(),revision:integer('revision').default(1).notNull(),sequence:integer('sequence').notNull(),dtstamp:timestamp('dtstamp',{withTimezone:true}).notNull(),
 content_digest:text('content_digest').notNull(),logical_message_id:text('logical_message_id').notNull(),source_digest:text('source_digest').notNull(),
 model_envelope:jsonb('model_envelope').$type<Record<string,unknown>>().notNull(),event_id:text('event_id'),event_fingerprint:text('event_fingerprint'),
 created_at:timestamp('created_at',{withTimezone:true}).defaultNow().notNull(),updated_at:timestamp('updated_at',{withTimezone:true}).defaultNow().notNull(),
},t=>[
 primaryKey({name:'email_calendar_invitations_pkey',columns:[t.org_id,t.owner_user_id,t.account_id,t.invitation_id]}),
 foreignKey({name:'email_calendar_invitations_account_fk',columns:[t.org_id,t.owner_user_id,t.account_id],foreignColumns:[emailAccounts.org_id,emailAccounts.owner_user_id,emailAccounts.account_id]}).onDelete('restrict'),
 foreignKey({name:'email_calendar_invitations_event_fk',columns:[t.event_id],foreignColumns:[events.id]}).onDelete('set null'),
 check('email_calendar_invitations_identity_check',sql`${t.invitation_id} ~ '^[a-f0-9]{64}$' AND ${t.content_digest} ~ '^[a-f0-9]{64}$' AND ${t.source_digest} ~ '^[a-f0-9]{64}$' AND ${t.logical_message_id} ~ '^mail_[a-f0-9]{64}$' AND ${t.revision}>0 AND ${t.sequence}>=0 AND (${t.event_fingerprint} IS NULL OR ${t.event_fingerprint} ~ '^[a-f0-9]{64}$')`),
 index('email_calendar_invitations_updated_idx').on(t.org_id,t.owner_user_id,t.account_id,t.updated_at),
]);
export const emailCalendarInvitationActions=pgTable('email_calendar_invitation_actions',{
 ...scope(),request_id:uuid('request_id').notNull(),invitation_id:text('invitation_id').notNull(),payload_digest:text('payload_digest').notNull(),invitation_revision:integer('invitation_revision').notNull(),
 receipt_envelope:jsonb('receipt_envelope').$type<Record<string,unknown>>().notNull(),outbox_id:text('outbox_id'),created_at:timestamp('created_at',{withTimezone:true}).defaultNow().notNull(),
},t=>[
 primaryKey({name:'email_calendar_invitation_actions_pkey',columns:[t.org_id,t.owner_user_id,t.account_id,t.request_id]}),
 foreignKey({name:'email_calendar_invitation_actions_invitation_fk',columns:[t.org_id,t.owner_user_id,t.account_id,t.invitation_id],foreignColumns:[emailCalendarInvitations.org_id,emailCalendarInvitations.owner_user_id,emailCalendarInvitations.account_id,emailCalendarInvitations.invitation_id]}).onDelete('restrict'),
 foreignKey({name:'email_calendar_invitation_actions_outbox_fk',columns:[t.org_id,t.owner_user_id,t.account_id,t.outbox_id],foreignColumns:[emailOutbox.org_id,emailOutbox.owner_user_id,emailOutbox.account_id,emailOutbox.outbox_id]}).onDelete('restrict'),
 check('email_calendar_invitation_actions_digest_check',sql`${t.payload_digest} ~ '^[a-f0-9]{64}$' AND ${t.invitation_revision}>0`),
]);
