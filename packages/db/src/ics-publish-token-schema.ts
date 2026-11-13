import { pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** One published calendar feed per person per workspace. `org_id` is the
 * binding: a token serves only its own workspace. Created by upgrade
 * 0.3.0-preview.137 on both fresh installs and upgrades, so it is exported
 * as `@deft/db/ics-publish-tokens` rather than from schema.ts. */
export const icsPublishTokens = pgTable('ics_publish_tokens', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  org_id: text('org_id').notNull(),
  user_id: text('user_id').notNull(),
  token: text('token').notNull(),
  revoked_at: timestamp('revoked_at'),
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull().$onUpdate(() => new Date()),
}, (t) => [
  uniqueIndex('ics_publish_tokens_token_uidx').on(t.token),
  uniqueIndex('ics_publish_tokens_live_uidx').on(t.org_id, t.user_id).where(sql`revoked_at IS NULL`),
]);
