import { bigint, index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/** Two-step verification belongs to the account (the `users` row), like the
 * password, so these tables carry `user_id` and no `org_id`. Created by
 * upgrade 0.3.0-preview.149 on both fresh installs and upgrades, so they are
 * exported as `@deft/db/two-step` rather than from schema.ts. */

/** One row per person who has started or finished enrolment. The secret is
 * encrypted with ENCRYPTION_KEY and never leaves the server after enrolment.
 * `last_used_step` is the newest 30-second step a code was accepted for; a
 * code for that step or an older one is refused. `failed_attempts` and
 * `locked_until` are the per-account attempt limit. */
export const userTwoStep = pgTable('user_two_step', {
  user_id: text('user_id').primaryKey(),
  secret_encrypted: text('secret_encrypted'),
  confirmed_at: timestamp('confirmed_at', { withTimezone: true }),
  pending_secret_encrypted: text('pending_secret_encrypted'),
  pending_created_at: timestamp('pending_created_at', { withTimezone: true }),
  last_used_step: bigint('last_used_step', { mode: 'number' }).default(0).notNull(),
  failed_attempts: integer('failed_attempts').default(0).notNull(),
  locked_until: timestamp('locked_until', { withTimezone: true }),
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull().$onUpdate(() => new Date()),
});

/** Recovery codes are stored only as SHA-256 hashes and each works once. */
export const userTwoStepRecoveryCodes = pgTable('user_two_step_recovery_codes', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  user_id: text('user_id').notNull(),
  code_hash: text('code_hash').notNull(),
  used_at: timestamp('used_at', { withTimezone: true }),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  uniqueIndex('user_two_step_recovery_codes_hash_uidx').on(t.code_hash),
  index('user_two_step_recovery_codes_user_idx').on(t.user_id),
]);

/** A short-lived, single-purpose token issued after a correct password.
 * `verify` is exchanged, with a code, for a session. `enrol` can only set up
 * two-step verification. Only the token's hash is stored. */
export const twoStepChallenges = pgTable('two_step_challenges', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  user_id: text('user_id').notNull(),
  org_id: text('org_id').notNull(),
  kind: text('kind').$type<'verify' | 'enrol'>().notNull(),
  token_hash: text('token_hash').notNull(),
  password_version: integer('password_version').notNull(),
  failed_attempts: integer('failed_attempts').default(0).notNull(),
  consumed_at: timestamp('consumed_at', { withTimezone: true }),
  expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  uniqueIndex('two_step_challenges_token_uidx').on(t.token_hash),
  index('two_step_challenges_user_idx').on(t.user_id),
]);

/** Memberships that are or have ever been owner or admin (created by the same
 * upgrade). Only the owner manages them, even after a demotion or a removal. */
export const orgMemberPrivilegeHistory = pgTable('org_member_privilege_history', {
  org_id: text('org_id').notNull(),
  user_id: text('user_id').notNull(),
  first_recorded_at: timestamp('first_recorded_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [primaryKey({ columns: [t.org_id, t.user_id] })]);
