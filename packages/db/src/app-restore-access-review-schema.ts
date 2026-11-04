import {pgTable,text,timestamp,jsonb,index,foreignKey,check} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
import {orgs,users,appInstallations} from './schema.js';

/** Server-stored restore-access reviews (§5.3). Each issued review is an
 * opaque, single-use record binding the exact offered grant set, owner,
 * reconnected session and expiry so activation can never be revived by
 * recomputing a caller-visible digest after its window has passed. */
export const appRestoreAccessReviews=pgTable('app_restore_access_reviews',{
  id:text('id').primaryKey(),
  org_id:text('org_id').notNull(),
  owner_user_id:text('owner_user_id').notNull(),
  installation_id:text('installation_id').notNull(),
  target_key:text('target_key').notNull(),
  session_id:text('session_id').notNull(),
  account_ref:text('account_ref').notNull(),
  offered_grants:jsonb('offered_grants').$type<unknown[]>().notNull(),
  review_digest:text('review_digest').notNull(),
  issued_at:timestamp('issued_at',{withTimezone:true}).notNull(),
  expires_at:timestamp('expires_at',{withTimezone:true}).notNull(),
  consumed_at:timestamp('consumed_at',{withTimezone:true}),
  created_at:timestamp('created_at',{withTimezone:true}).defaultNow().notNull(),
  updated_at:timestamp('updated_at',{withTimezone:true}).defaultNow().notNull(),
},t=>[
  index('app_restore_access_reviews_owner_idx').on(t.org_id,t.owner_user_id,t.installation_id,t.target_key),
  foreignKey({columns:[t.org_id],foreignColumns:[orgs.id]}),
  foreignKey({columns:[t.owner_user_id],foreignColumns:[users.id]}),
  foreignKey({columns:[t.org_id,t.installation_id],foreignColumns:[appInstallations.org_id,appInstallations.id]}),
  check('app_restore_access_reviews_digest_check',sql`${t.review_digest} ~ '^sha256:[a-f0-9]{64}$'`),
  check('app_restore_access_reviews_target_check',sql`${t.target_key} ~ '^[a-z][a-z0-9_]{0,47}$'`),
  check('app_restore_access_reviews_expiry_check',sql`${t.expires_at}>${t.issued_at} AND ${t.expires_at}<=${t.issued_at}+interval '15 minutes'`),
]);
