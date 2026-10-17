import { check, foreignKey, index, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, integer } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { emailAccounts } from './email-schema.js';

/** Local snooze/follow-up state. Message identity and reminder text remain in
 * the encrypted envelope; the digest only supports scoped lookup/exclusion. */
export const emailTimers = pgTable('email_timers', {
  org_id: text('org_id').notNull(), owner_user_id: text('owner_user_id').notNull(), account_id: text('account_id').notNull(),
  timer_id: text('timer_id').notNull(), logical_message_digest: text('logical_message_digest').notNull(),
  kind: text('kind').$type<'snooze' | 'follow_up'>().notNull(), revision: integer('revision').notNull(),
  state: text('state').$type<'scheduled' | 'firing' | 'completed' | 'cancelled' | 'blocked'>().notNull(),
  scheduled_at: timestamp('scheduled_at', { withTimezone: true }).notNull(), display_timezone: text('display_timezone').notNull(),
  timer_envelope: jsonb('timer_envelope').$type<Record<string, unknown>>().notNull(),
  firing_job_id: text('firing_job_id'), firing_lock_token: text('firing_lock_token'),
  firing_lease_expires_at: timestamp('firing_lease_expires_at', { withTimezone: true }), completed_at: timestamp('completed_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  primaryKey({ name: 'email_timers_pkey', columns: [t.org_id, t.owner_user_id, t.account_id, t.timer_id] }),
  foreignKey({ name: 'email_timers_account_fk', columns: [t.org_id, t.owner_user_id, t.account_id],
    foreignColumns: [emailAccounts.org_id, emailAccounts.owner_user_id, emailAccounts.account_id] }).onDelete('restrict'),
  index('email_timers_due_idx').on(t.org_id, t.owner_user_id, t.account_id, t.state, t.scheduled_at, t.timer_id),
  index('email_timers_target_idx').on(t.org_id, t.owner_user_id, t.account_id, t.logical_message_digest, t.kind, t.state),
  uniqueIndex('email_timers_active_snooze_unique').on(t.org_id, t.owner_user_id, t.account_id, t.logical_message_digest)
    .where(sql`${t.kind}='snooze' AND ${t.state} IN ('scheduled','firing','blocked')`),
  check('email_timers_id_check', sql`${t.timer_id} ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'`),
  check('email_timers_target_digest_check', sql`${t.logical_message_digest} ~ '^[a-f0-9]{64}$'`),
  check('email_timers_kind_check', sql`${t.kind} IN ('snooze','follow_up')`),
  check('email_timers_revision_check', sql`${t.revision} BETWEEN 1 AND 2147483647`),
  check('email_timers_state_check', sql`${t.state} IN ('scheduled','firing','completed','cancelled','blocked')`),
  check('email_timers_timezone_check', sql`length(${t.display_timezone}) BETWEEN 1 AND 128`),
  check('email_timers_envelope_check', sql`jsonb_typeof(${t.timer_envelope})='object' AND octet_length(${t.timer_envelope}::text)<=32768`),
  check('email_timers_firing_lease_check', sql`(${t.state}='firing' AND ${t.firing_job_id} IS NOT NULL AND ${t.firing_lock_token} IS NOT NULL AND ${t.firing_lease_expires_at} IS NOT NULL) OR (${t.state}<>'firing' AND ${t.firing_job_id} IS NULL AND ${t.firing_lock_token} IS NULL AND ${t.firing_lease_expires_at} IS NULL)`),
  check('email_timers_completed_check', sql`(${t.state}='completed' AND ${t.completed_at} IS NOT NULL) OR (${t.state}<>'completed' AND ${t.completed_at} IS NULL)`),
]);
