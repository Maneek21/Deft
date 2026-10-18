import {pgTable,text,integer,timestamp,jsonb,primaryKey,foreignKey,check,customType} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
import {emailDrafts} from './email-schema.js';
const binary=customType<{data:Buffer;driverData:Buffer}>({dataType:()=> 'bytea'});
export const emailAttachments=pgTable('email_attachments',{
 org_id:text('org_id').notNull(),owner_user_id:text('owner_user_id').notNull(),account_id:text('account_id').notNull(),
 draft_id:text('draft_id').notNull(),file_id:text('file_id').notNull(),upload_revision:integer('upload_revision').notNull(),
 size_bytes:integer('size_bytes').notNull(),metadata_envelope:jsonb('metadata_envelope').$type<Record<string,unknown>>().notNull(),
 ciphertext:binary('ciphertext').notNull(),key_version:text('key_version').notNull(),nonce_b64:text('nonce_b64').notNull(),auth_tag_b64:text('auth_tag_b64').notNull(),
 created_at:timestamp('created_at',{withTimezone:true}).defaultNow().notNull(),detached_at:timestamp('detached_at',{withTimezone:true}),
},t=>[
 primaryKey({name:'email_attachments_pkey',columns:[t.org_id,t.owner_user_id,t.account_id,t.draft_id,t.file_id]}),
 foreignKey({name:'email_attachments_draft_fk',columns:[t.org_id,t.owner_user_id,t.account_id,t.draft_id],foreignColumns:[emailDrafts.org_id,emailDrafts.owner_user_id,emailDrafts.account_id,emailDrafts.draft_id]}).onDelete('restrict'),
 check('email_attachments_identity_check',sql`${t.file_id} ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' AND ${t.upload_revision}>0`),
 check('email_attachments_bytes_check',sql`${t.size_bytes} BETWEEN 0 AND 26214400 AND octet_length(${t.ciphertext})=${t.size_bytes}`),
 check('email_attachments_cipher_check',sql`char_length(${t.key_version}) BETWEEN 1 AND 64 AND char_length(${t.nonce_b64})=16 AND char_length(${t.auth_tag_b64})=24`),
]);
