import {pgTable,text,integer,timestamp,jsonb,primaryKey,foreignKey,unique,index,check,customType} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
import {emailDrafts} from './email-schema.js';
const binary=customType<{data:Buffer;driverData:Buffer}>({dataType:()=> 'bytea'});
export const emailOutbox=pgTable('email_outbox',{
 org_id:text('org_id').notNull(),owner_user_id:text('owner_user_id').notNull(),account_id:text('account_id').notNull(),outbox_id:text('outbox_id').notNull(),
 request_id:text('request_id').notNull(),operation_id:text('operation_id').notNull(),draft_id:text('draft_id').notNull(),draft_revision:integer('draft_revision').notNull(),
 revision:integer('revision').default(1).notNull(),state:text('state').$type<'queued'|'paused'|'submitting'|'accepted'|'uncertain'|'cancelled'>().notNull(),job_id:text('job_id').notNull(),
 earliest_dispatch_at:timestamp('earliest_dispatch_at',{withTimezone:true}).notNull(),snapshot_envelope:jsonb('snapshot_envelope').$type<Record<string,unknown>>().notNull(),
 state_envelope:jsonb('state_envelope').$type<Record<string,unknown>>().notNull(),mime_digest:text('mime_digest').notNull(),byte_length:integer('byte_length').notNull(),
 ciphertext:binary('ciphertext').notNull(),key_version:text('key_version').notNull(),nonce_b64:text('nonce_b64').notNull(),auth_tag_b64:text('auth_tag_b64').notNull(),
 attempt_id:text('attempt_id'),attempt_lock_hash:text('attempt_lock_hash'),started_at:timestamp('started_at',{withTimezone:true}),
 created_at:timestamp('created_at',{withTimezone:true}).defaultNow().notNull(),updated_at:timestamp('updated_at',{withTimezone:true}).defaultNow().notNull(),
},t=>[
 primaryKey({name:'email_outbox_pkey',columns:[t.org_id,t.owner_user_id,t.account_id,t.outbox_id]}),
 foreignKey({name:'email_outbox_draft_fk',columns:[t.org_id,t.owner_user_id,t.account_id,t.draft_id],foreignColumns:[emailDrafts.org_id,emailDrafts.owner_user_id,emailDrafts.account_id,emailDrafts.draft_id]}).onDelete('restrict'),
 unique('email_outbox_request_unique').on(t.org_id,t.owner_user_id,t.account_id,t.request_id),unique('email_outbox_operation_unique').on(t.org_id,t.owner_user_id,t.account_id,t.operation_id),
 unique('email_outbox_draft_revision_unique').on(t.org_id,t.owner_user_id,t.account_id,t.draft_id,t.draft_revision),index('email_outbox_owner_idx').on(t.org_id,t.owner_user_id,t.account_id,t.created_at,t.outbox_id),
 check('email_outbox_identity_check',sql`${t.outbox_id} ~ '^[a-f0-9-]{36}$' AND ${t.request_id} ~ '^[a-f0-9-]{36}$' AND ${t.operation_id} ~ '^[a-f0-9-]{36}$' AND ${t.job_id} ~ '^[a-f0-9-]{36}$' AND ${t.draft_revision}>0 AND ${t.revision} BETWEEN 1 AND 128 AND ${t.mime_digest} ~ '^[a-f0-9]{64}$'`),
 check('email_outbox_state_check',sql`${t.state} IN ('queued','paused','submitting','accepted','uncertain','cancelled') AND ((${t.state} IN ('queued','paused','cancelled') AND ${t.attempt_id} IS NULL AND ${t.attempt_lock_hash} IS NULL AND ${t.started_at} IS NULL) OR (${t.state} IN ('submitting','accepted','uncertain') AND ${t.attempt_id} IS NOT NULL AND ${t.attempt_lock_hash} IS NOT NULL AND ${t.attempt_id} ~ '^[a-f0-9-]{36}$' AND ${t.attempt_lock_hash} ~ '^[a-f0-9]{64}$' AND ${t.started_at} IS NOT NULL))`),
 check('email_outbox_bytes_check',sql`${t.byte_length} BETWEEN 1 AND 36700160 AND octet_length(${t.ciphertext})=${t.byte_length} AND char_length(${t.key_version}) BETWEEN 1 AND 64 AND char_length(${t.nonce_b64})=16 AND char_length(${t.auth_tag_b64})=24`),
]);
export const emailOutboxEvents=pgTable('email_outbox_events',{
 org_id:text('org_id').notNull(),owner_user_id:text('owner_user_id').notNull(),account_id:text('account_id').notNull(),outbox_id:text('outbox_id').notNull(),
 revision:integer('revision').notNull(),envelope:jsonb('envelope').$type<Record<string,unknown>>().notNull(),created_at:timestamp('created_at',{withTimezone:true}).defaultNow().notNull(),
},t=>[primaryKey({name:'email_outbox_events_pkey',columns:[t.org_id,t.owner_user_id,t.account_id,t.outbox_id,t.revision]}),
 foreignKey({name:'email_outbox_events_outbox_fk',columns:[t.org_id,t.owner_user_id,t.account_id,t.outbox_id],foreignColumns:[emailOutbox.org_id,emailOutbox.owner_user_id,emailOutbox.account_id,emailOutbox.outbox_id]}).onDelete('restrict'),
 check('email_outbox_events_revision_check',sql`${t.revision} BETWEEN 1 AND 128`)]);
