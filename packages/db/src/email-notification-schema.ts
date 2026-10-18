import { boolean, foreignKey, index, integer, pgTable, primaryKey, text, timestamp, unique, check, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { emailAccounts } from './email-schema.js';

const scope = () => ({ org_id: text('org_id').notNull(), owner_user_id: text('owner_user_id').notNull(), account_id: text('account_id').notNull() });

/** Metadata-only durable event outbox. No subject, sender, snippet, locator or body. */
export const emailNotificationEvents = pgTable('email_notification_events', {
  ...scope(), notification_id: uuid('notification_id').notNull(), logical_message_id: text('logical_message_id').notNull(),
  revision: integer('revision').default(1).notNull(), authority_revision: integer('authority_revision').notNull(),
  state: text('state').$type<'pending'|'projected'|'suppressed'>().default('pending').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(), projected_at: timestamp('projected_at', { withTimezone: true }),
}, t => [
  primaryKey({ name: 'email_notification_events_pkey', columns: [t.org_id, t.owner_user_id, t.account_id, t.notification_id] }),
  unique('email_notification_events_message_unique').on(t.org_id, t.owner_user_id, t.account_id, t.logical_message_id),
  foreignKey({ columns: [t.org_id, t.owner_user_id, t.account_id], foreignColumns: [emailAccounts.org_id, emailAccounts.owner_user_id, emailAccounts.account_id], name: 'email_notification_events_account_fk' }).onDelete('restrict'),
  check('email_notification_events_identity_check', sql`${t.logical_message_id} ~ '^mail_[a-f0-9]{64}$' AND ${t.revision} > 0 AND ${t.authority_revision} > 0`),
  check('email_notification_events_state_check', sql`${t.state} IN ('pending','projected','suppressed')`),
  index('email_notification_events_pending_idx').on(t.org_id, t.owner_user_id, t.account_id, t.created_at).where(sql`${t.state} = 'pending'`),
]);

/** One-way baseline gate: the initial inventory never creates a notification flood. */
export const emailNotificationStates = pgTable('email_notification_states', {
  ...scope(), initial_inventory_complete: boolean('initial_inventory_complete').default(false).notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(), updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, t => [
  primaryKey({ name: 'email_notification_states_pkey', columns: [t.org_id, t.owner_user_id, t.account_id] }),
  foreignKey({ columns: [t.org_id, t.owner_user_id, t.account_id], foreignColumns: [emailAccounts.org_id, emailAccounts.owner_user_id, emailAccounts.account_id], name: 'email_notification_states_account_fk' }).onDelete('restrict'),
]);
