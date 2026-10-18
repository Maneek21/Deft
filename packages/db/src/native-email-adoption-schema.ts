import {pgTable,text,integer,uuid,timestamp,jsonb,primaryKey,foreignKey,unique,check} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
import {emailAccounts} from './email-schema.js';
const scope=()=>({org_id:text('org_id').notNull(),owner_user_id:text('owner_user_id').notNull(),account_id:text('account_id').notNull()});
export const nativeEmailAdoptions=pgTable('native_email_adoptions',{
 ...scope(),adoption_id:uuid('adoption_id').notNull().unique('native_email_adoptions_adoption_id_key'),revision:integer('revision').notNull(),state:text('state').notNull(),
 source_generation:integer('source_generation').notNull(),source_authority_revision:integer('source_authority_revision').notNull(),source_consent_revision:integer('source_consent_revision').notNull(),
 source_principal_digest:text('source_principal_digest').notNull(),source_binding_digest:text('source_binding_digest').notNull(),snapshot_digest:text('snapshot_digest'),destination_binding_digest:text('destination_binding_digest'),destination_admission_digest:text('destination_admission_digest'),runtime_receipt_digest:text('runtime_receipt_digest'),
 created_at:timestamp('created_at',{withTimezone:true}).notNull(),updated_at:timestamp('updated_at',{withTimezone:true}).notNull(),
},t=>[primaryKey({name:'native_email_adoptions_pkey',columns:[t.org_id,t.owner_user_id,t.account_id]}),foreignKey({name:'native_email_adoptions_account_fk',columns:[t.org_id,t.owner_user_id,t.account_id],foreignColumns:[emailAccounts.org_id,emailAccounts.owner_user_id,emailAccounts.account_id]}).onDelete('restrict'),
 check('native_email_adoptions_revision_check',sql`${t.revision} BETWEEN 1 AND 2147483647`),
 check('native_email_adoptions_state_check',sql`${t.state} IN ('native_frozen','runtime_prepared','runtime_active','archive_only')`),
 check('native_email_adoptions_source_generation_check',sql`${t.source_generation}>0`),
 check('native_email_adoptions_source_authority_revision_check',sql`${t.source_authority_revision}>0`),
 check('native_email_adoptions_source_consent_revision_check',sql`${t.source_consent_revision}>0`),
 check('native_email_adoptions_source_principal_digest_check',sql`${t.source_principal_digest} ~ '^[a-f0-9]{64}$'`),
 check('native_email_adoptions_source_binding_digest_check',sql`${t.source_binding_digest} ~ '^[a-f0-9]{64}$'`),
 check('native_email_adoptions_snapshot_digest_check',sql`${t.snapshot_digest} ~ '^[a-f0-9]{64}$'`),
 check('native_email_adoptions_destination_binding_digest_check',sql`${t.destination_binding_digest} ~ '^[a-f0-9]{64}$'`),
 check('native_email_adoptions_destination_admission_digest_check',sql`${t.destination_admission_digest} ~ '^[a-f0-9]{64}$'`),
 check('native_email_adoptions_runtime_receipt_digest_check',sql`${t.runtime_receipt_digest} ~ '^[a-f0-9]{64}$'`),
 check('native_email_adoptions_account_id_check',sql`length(${t.account_id}) BETWEEN 1 AND 256 AND ${t.account_id} ~ '^[A-Za-z0-9_-]+$'`),
 check('native_email_adoptions_check',sql`${t.updated_at}>=${t.created_at}`),
 check('native_email_adoptions_check1',sql`${t.state} NOT IN ('runtime_prepared','runtime_active') OR (${t.snapshot_digest} IS NOT NULL AND ${t.destination_binding_digest} IS NOT NULL AND ${t.destination_admission_digest} IS NOT NULL)`),
 check('native_email_adoptions_check2',sql`${t.state}<>'runtime_active' OR ${t.runtime_receipt_digest} IS NOT NULL`),
]);
export const nativeEmailAdoptionDestinations=pgTable('native_email_adoption_destinations',{
 ...scope(),adoption_id:uuid('adoption_id').notNull(),session_id:text('session_id').notNull(),admission:jsonb('admission').$type<Record<string,unknown>>().notNull(),profile:jsonb('profile').$type<Record<string,unknown>>().notNull(),receipt:jsonb('receipt').$type<Record<string,unknown>>(),created_at:timestamp('created_at',{withTimezone:true}).notNull(),published_at:timestamp('published_at',{withTimezone:true}),
},t=>[primaryKey({name:'native_email_adoption_destinations_pkey',columns:[t.org_id,t.owner_user_id,t.account_id]}),unique('native_email_adoption_destinations_session_key').on(t.org_id,t.owner_user_id,t.session_id),foreignKey({name:'native_email_adoption_destinations_account_fk',columns:[t.org_id,t.owner_user_id,t.account_id],foreignColumns:[nativeEmailAdoptions.org_id,nativeEmailAdoptions.owner_user_id,nativeEmailAdoptions.account_id]}).onDelete('restrict'),
 check('native_email_adoption_destinations_admission_check',sql`jsonb_typeof(${t.admission})='object' AND octet_length(${t.admission}::text)<=32768`),
 check('native_email_adoption_destinations_profile_check',sql`jsonb_typeof(${t.profile})='object' AND octet_length(${t.profile}::text)<=16384`),
 check('native_email_adoption_destinations_receipt_check',sql`${t.receipt} IS NULL OR jsonb_typeof(${t.receipt})='object' AND octet_length(${t.receipt}::text)<=16384`),
 check('native_email_adoption_destinations_check',sql`(${t.receipt} IS NULL)=(${t.published_at} IS NULL)`),
]);
