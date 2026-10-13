import { check, foreignKey, index, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { orgs, users } from './schema.js';
import { emailAccounts } from './email-schema.js';

/** A create receipt contains no copied content, email headers or provider
 * locators. Its digest binds the entire reviewed request; the destination keeps
 * its ordinary retention and permissions. */
export const emailContextTransfers = pgTable('email_context_transfers', {
  org_id: text('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  owner_user_id: text('owner_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  request_id: text('request_id').notNull(), request_digest: text('request_digest').notNull(),
  account_id: text('account_id').notNull(), logical_message_id: text('logical_message_id').notNull(),
  source_digest: text('source_digest').notNull(), mode: text('mode').notNull(), review_digest: text('review_digest').notNull(),
  destination_kind: text('destination_kind').notNull(), destination_id: text('destination_id').notNull(),
  destination_url: text('destination_url').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, t => [primaryKey({ name: 'email_context_transfers_pkey', columns: [t.org_id, t.owner_user_id, t.request_id] }),
  foreignKey({ name: 'email_context_transfer_account_fk', columns: [t.org_id, t.owner_user_id, t.account_id],
    foreignColumns: [emailAccounts.org_id, emailAccounts.owner_user_id, emailAccounts.account_id] }).onDelete('cascade'),
  index('email_context_transfer_source_idx').on(t.org_id, t.owner_user_id, t.account_id, t.logical_message_id),
  check('email_context_transfer_digest_check', sql`${t.request_digest} ~ '^[a-f0-9]{64}$'`),
  check('email_context_transfer_source_digest_check', sql`${t.source_digest} ~ '^[a-f0-9]{64}$'`),
  check('email_context_transfer_review_digest_check', sql`${t.review_digest} ~ '^[a-f0-9]{64}$'`),
  check('email_context_transfer_logical_check', sql`${t.logical_message_id} ~ '^mail_[a-f0-9]{64}$'`),
  check('email_context_transfer_mode_check', sql`${t.mode} IN ('source_link','excerpt')`),
  check('email_context_transfer_kind_check', sql`${t.destination_kind} IN ('note','knowledge','chat')`)]);
