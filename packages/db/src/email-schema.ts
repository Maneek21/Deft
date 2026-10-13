import { pgTable, text, integer, boolean, timestamp, jsonb, primaryKey, foreignKey, index, unique, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// Native account custody is independent of Experience leases. An existing
// reviewed binding is the migration bridge; no historical account is activated
// merely by installing this schema. Cross-table owner/binding constraints are
// installed by preview.63 and apply-extras on supported fresh installations.
const scope = () => ({ org_id: text('org_id').notNull(), owner_user_id: text('owner_user_id').notNull(), account_id: text('account_id').notNull() });
const times = () => ({ created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(), updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull() });
export const emailAccounts = pgTable('email_accounts', {
  ...scope(), provider: text('provider').$type<'gmail'|'microsoft'|'imap_smtp'>().notNull(),
  provider_draft_sync_enabled: boolean('provider_draft_sync_enabled').default(false).notNull(),
  credential_source:text('credential_source').$type<'retained_registry_v1'|'native_owner_provider_v1'>().default('retained_registry_v1').notNull(),
  resource_binding_id: text('resource_binding_id').notNull(),
  retained_resource_binding_id:text('retained_resource_binding_id').generatedAlwaysAs(sql`CASE WHEN credential_source='retained_registry_v1' THEN resource_binding_id ELSE NULL END`),
  principal_digest: text('principal_digest'),
  state: text('state').$type<'active'|'paused'|'disconnected'|'revoked'>().default('paused').notNull(),
  authority_revision: integer('authority_revision').default(1).notNull(),
  consented_at: timestamp('consented_at', { withTimezone: true }),
  revoked_at: timestamp('revoked_at', { withTimezone: true }), ...times(),
}, t => [
  primaryKey({ name:'email_accounts_pkey',columns: [t.org_id,t.owner_user_id,t.account_id] }),
  index('email_accounts_binding_idx').on(t.org_id,t.resource_binding_id),
  index('email_accounts_retained_binding_idx').on(t.org_id,t.retained_resource_binding_id),
  check('email_accounts_provider_check',sql`${t.provider} IN ('gmail','microsoft','imap_smtp')`),
  check('email_accounts_source_check',sql`${t.credential_source} IN ('retained_registry_v1','native_owner_provider_v1') AND (${t.credential_source}<>'native_owner_provider_v1' OR ${t.provider} IN ('gmail','microsoft'))`),
  check('email_accounts_state_check',sql`${t.state} IN ('active','paused','disconnected','revoked')`),
  check('email_accounts_revision_check',sql`${t.authority_revision} > 0`),
  check('email_accounts_consent_check',sql`${t.state} <> 'active' OR (${t.consented_at} IS NOT NULL AND ${t.revoked_at} IS NULL)`),
  check('email_accounts_principal_check',sql`(${t.principal_digest} IS NULL OR ${t.principal_digest} ~ '^[a-f0-9]{64}$') AND (${t.state} <> 'active' OR ${t.principal_digest} IS NOT NULL)`),
]);
export const emailCheckpoints = pgTable('email_checkpoints', {
  ...scope(), revision: integer('revision').default(0).notNull(), cursor_envelope: jsonb('cursor_envelope').$type<Record<string,unknown>>(),
  observed_at: timestamp('observed_at', { withTimezone: true }), fresh_until: timestamp('fresh_until', { withTimezone: true }),
  coverage: text('coverage').$type<'partial'|'complete'>().default('partial').notNull(),
  has_more: boolean('has_more').default(false).notNull(),
  sync_state: text('sync_state').$type<'idle'|'queued'|'syncing'|'failed'|'paused'>().default('idle').notNull(), ...times(),
}, t => [
  primaryKey({name:'email_checkpoints_pkey',columns:[t.org_id,t.owner_user_id,t.account_id]}),
  foreignKey({columns:[t.org_id,t.owner_user_id,t.account_id],foreignColumns:[emailAccounts.org_id,emailAccounts.owner_user_id,emailAccounts.account_id],name:'email_checkpoints_account_fk'}).onDelete('restrict'),
  check('email_checkpoints_revision_check',sql`${t.revision} >= 0`),
  check('email_checkpoints_coverage_check',sql`${t.coverage} IN ('partial','complete')`),
  check('email_checkpoints_state_check',sql`${t.sync_state} IN ('idle','queued','syncing','failed','paused')`),
]);
export const emailMessages = pgTable('email_messages', {
  ...scope(), logical_message_id:text('logical_message_id').notNull(), revision:text('revision').notNull(),
  storage_revision:integer('storage_revision').notNull(), received_at:timestamp('received_at',{withTimezone:true}),
  sort_at:timestamp('sort_at',{withTimezone:true}).notNull(), seen:boolean('seen').default(false).notNull(),
  flagged:boolean('flagged').default(false).notNull(), answered:boolean('answered').default(false).notNull(),
  summary_envelope:jsonb('summary_envelope').$type<Record<string,unknown>>(), source_envelope:jsonb('source_envelope').$type<Record<string,unknown>>(),
  inventory_generation:text('inventory_generation'),
  deleted_at:timestamp('deleted_at',{withTimezone:true}), ...times(),
},t=>[
  primaryKey({name:'email_messages_pkey',columns:[t.org_id,t.owner_user_id,t.account_id,t.logical_message_id]}),
  foreignKey({columns:[t.org_id,t.owner_user_id,t.account_id],foreignColumns:[emailAccounts.org_id,emailAccounts.owner_user_id,emailAccounts.account_id],name:'email_messages_account_fk'}).onDelete('restrict'),
  index('email_messages_page_idx').on(t.org_id,t.owner_user_id,t.account_id,t.sort_at,t.logical_message_id).where(sql`${t.deleted_at} IS NULL`),
  index('email_messages_inventory_idx').on(t.org_id,t.owner_user_id,t.account_id,t.inventory_generation,t.logical_message_id).where(sql`${t.deleted_at} IS NULL`),
  check('email_messages_identity_check',sql`${t.logical_message_id} ~ '^mail_[a-f0-9]{64}$' AND ${t.storage_revision} > 0`),
  check('email_messages_content_check',sql`(${t.deleted_at} IS NULL AND ${t.summary_envelope} IS NOT NULL AND ${t.source_envelope} IS NOT NULL) OR (${t.deleted_at} IS NOT NULL AND ${t.summary_envelope} IS NULL AND ${t.source_envelope} IS NULL)`),
]);
export const emailMemberships = pgTable('email_memberships', {
  ...scope(), logical_message_id:text('logical_message_id').notNull(), folder:text('folder').notNull(), inventory_generation:text('inventory_generation'), ...times(),
},t=>[
  primaryKey({name:'email_memberships_pkey',columns:[t.org_id,t.owner_user_id,t.account_id,t.logical_message_id,t.folder]}),
  foreignKey({columns:[t.org_id,t.owner_user_id,t.account_id,t.logical_message_id],foreignColumns:[emailMessages.org_id,emailMessages.owner_user_id,emailMessages.account_id,emailMessages.logical_message_id],name:'email_memberships_message_fk'}).onDelete('restrict'),
  index('email_memberships_folder_idx').on(t.org_id,t.owner_user_id,t.account_id,t.folder,t.logical_message_id),
]);
export const emailSyncReceipts = pgTable('email_sync_receipts', {
  ...scope(), page_id:text('page_id').notNull(), request_digest:text('request_digest').notNull(),page_digest:text('page_digest').notNull(),
  checkpoint_revision:integer('checkpoint_revision').notNull(),observed_at:timestamp('observed_at',{withTimezone:true}).notNull(),complete:boolean('complete').notNull(),has_more:boolean('has_more').default(false).notNull(), ...times(),
},t=>[
  primaryKey({name:'email_sync_receipts_pkey',columns:[t.org_id,t.owner_user_id,t.account_id,t.page_id]}),
  foreignKey({columns:[t.org_id,t.owner_user_id,t.account_id],foreignColumns:[emailAccounts.org_id,emailAccounts.owner_user_id,emailAccounts.account_id],name:'email_sync_receipts_account_fk'}).onDelete('restrict'),
  check('email_sync_receipts_digest_check',sql`${t.request_digest} ~ '^[a-f0-9]{64}$' AND ${t.page_digest} ~ '^[a-f0-9]{64}$' AND ${t.checkpoint_revision} > 0`),
]);
export const emailProviderStates = pgTable('email_provider_states', {
  ...scope(), state_key:text('state_key').notNull(), storage_revision:integer('storage_revision').notNull(),
  generation:text('generation').notNull(), state_envelope:jsonb('state_envelope').$type<Record<string,unknown>>().notNull(), ...times(),
},t=>[
  primaryKey({name:'email_provider_states_pkey',columns:[t.org_id,t.owner_user_id,t.account_id,t.state_key]}),
  foreignKey({columns:[t.org_id,t.owner_user_id,t.account_id],foreignColumns:[emailAccounts.org_id,emailAccounts.owner_user_id,emailAccounts.account_id],name:'email_provider_states_account_fk'}).onDelete('restrict'),
  check('email_provider_states_identity_check',sql`${t.storage_revision}>0 AND ${t.state_key} ~ '^[a-f0-9]{64}$' AND char_length(${t.generation}) BETWEEN 1 AND 128`),
]);

/** Human reading preferences do not grant an agent or third-party App access. */
export const emailReadingPreferences=pgTable('email_reading_preferences',{
  ...scope(),external_images:text('external_images').$type<'ask'|'always'>().default('ask').notNull(),
  revision:integer('revision').default(1).notNull(),...times(),
},t=>[
  primaryKey({name:'email_reading_preferences_pkey',columns:[t.org_id,t.owner_user_id,t.account_id]}),
  foreignKey({columns:[t.org_id,t.owner_user_id,t.account_id],foreignColumns:[emailAccounts.org_id,emailAccounts.owner_user_id,emailAccounts.account_id],name:'email_reading_preferences_account_fk'}).onDelete('restrict'),
  check('email_reading_preferences_policy_check',sql`${t.external_images} IN ('ask','always') AND ${t.revision}>0`),
]);

/** IMAP secrets use the host keyring; endpoint and login are inside the envelope. */
export const emailImapCredentials=pgTable('email_imap_credentials',{
  ...scope(),principal_digest:text('principal_digest').notNull(),connection_revision:integer('connection_revision').notNull(),
  envelope:jsonb('envelope').$type<Record<string,unknown>>().notNull(),...times(),
},t=>[
  primaryKey({name:'email_imap_credentials_pkey',columns:[t.org_id,t.owner_user_id,t.account_id]}),
  foreignKey({columns:[t.org_id,t.owner_user_id,t.account_id],foreignColumns:[emailAccounts.org_id,emailAccounts.owner_user_id,emailAccounts.account_id],name:'email_imap_credentials_account_fk'}).onDelete('restrict'),
  check('email_imap_credentials_identity_check',sql`${t.principal_digest} ~ '^[a-f0-9]{64}$' AND ${t.connection_revision}>0`),
]);

/** Durable owner/account-scoped native compose drafts. Payload and attachment
 * nominations remain encrypted; the Experience lease is not their lifetime. */
export const emailDrafts=pgTable('email_drafts',{
  ...scope(),draft_id:text('draft_id').notNull(),revision:integer('revision').notNull(),content_revision:integer('content_revision').notNull(),
  origin:text('origin').$type<'human'|'agent'>().notNull(),created_by_user_id:text('created_by_user_id').notNull(),origin_run_id:text('origin_run_id'),
  last_edited_by_user_id:text('last_edited_by_user_id').notNull(),
  status:text('status').$type<'draft'|'submitted'|'archived'>().default('draft').notNull(),
  content_envelope:jsonb('content_envelope').$type<Record<string,unknown>>().notNull(),submitted_at:timestamp('submitted_at',{withTimezone:true}),
  archived_at:timestamp('archived_at',{withTimezone:true}),...times(),
},t=>[
  primaryKey({name:'email_drafts_pkey',columns:[t.org_id,t.owner_user_id,t.account_id,t.draft_id]}),
  foreignKey({columns:[t.org_id,t.owner_user_id,t.account_id],foreignColumns:[emailAccounts.org_id,emailAccounts.owner_user_id,emailAccounts.account_id],name:'email_drafts_account_fk'}).onDelete('restrict'),
  index('email_drafts_owner_idx').on(t.org_id,t.owner_user_id,t.account_id,t.status,t.updated_at),
  check('email_drafts_id_check',sql`${t.draft_id} ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'`),
  check('email_drafts_revision_check',sql`${t.revision}>0 AND ${t.content_revision}>0 AND ${t.content_revision}<=${t.revision}`),
  check('email_drafts_origin_check',sql`${t.origin} IN ('human','agent') AND char_length(${t.created_by_user_id}) BETWEEN 1 AND 256 AND char_length(${t.last_edited_by_user_id}) BETWEEN 1 AND 256`),
  check('email_drafts_status_check',sql`${t.status} IN ('draft','submitted','archived') AND (${t.status}<>'submitted' OR ${t.submitted_at} IS NOT NULL) AND (${t.status}<>'archived' OR ${t.archived_at} IS NOT NULL)`),
]);

/** One immutable send reservation per draft content revision. The receipt is
 * encrypted; a reserved row is conservatively treated as unknown after loss. */
export const emailSendOperations=pgTable('email_send_operations',{
  ...scope(),operation_id:text('operation_id').notNull(),draft_id:text('draft_id').notNull(),draft_revision:integer('draft_revision').notNull(),
  operation_digest:text('operation_digest').notNull(),state:text('state').$type<'reserved'|'accepted'|'unknown'>().notNull(),
  receipt_envelope:jsonb('receipt_envelope').$type<Record<string,unknown>>().notNull(),initiated_by_user_id:text('initiated_by_user_id').notNull(),
  ...times(),
},t=>[
  primaryKey({name:'email_send_operations_pkey',columns:[t.org_id,t.owner_user_id,t.account_id,t.operation_id]}),
  foreignKey({name:'email_send_operations_account_fk',columns:[t.org_id,t.owner_user_id,t.account_id],foreignColumns:[emailAccounts.org_id,emailAccounts.owner_user_id,emailAccounts.account_id]}).onDelete('restrict'),
  foreignKey({name:'email_send_operations_draft_fk',columns:[t.org_id,t.owner_user_id,t.account_id,t.draft_id],foreignColumns:[emailDrafts.org_id,emailDrafts.owner_user_id,emailDrafts.account_id,emailDrafts.draft_id]}).onDelete('restrict'),
  unique('email_send_operations_revision_unique').on(t.org_id,t.owner_user_id,t.account_id,t.draft_id,t.draft_revision),
  check('email_send_operations_identity_check',sql`${t.operation_id} ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' AND ${t.draft_revision}>0 AND ${t.operation_digest} ~ '^[a-f0-9]{64}$' AND char_length(${t.initiated_by_user_id}) BETWEEN 1 AND 256`),
  check('email_send_operations_state_check',sql`${t.state} IN ('reserved','accepted','unknown')`),
]);

/** Opt-in mirror ledger. Provider locators and comparison baselines are kept
 * only in the encrypted envelope; rows contain no message content. */
export const emailProviderDraftMirrors=pgTable('email_provider_draft_mirrors',{
  ...scope(),draft_id:text('draft_id').notNull(),desired_revision:integer('desired_revision').notNull(),
  synced_revision:integer('synced_revision'),generation:integer('generation').default(1).notNull(),
  envelope_revision:integer('envelope_revision').default(0).notNull(),
  claim_token_hash:text('claim_token_hash'),claim_generation:integer('claim_generation'),claim_revision:integer('claim_revision'),claim_operation_id:text('claim_operation_id'),
  state:text('state').$type<'queued'|'syncing'|'synced'|'conflict'|'unknown'|'unsupported'|'delete_pending'|'deleted'|'paused'>().default('queued').notNull(),
  provider_envelope:jsonb('provider_envelope').$type<Record<string,unknown>>(),last_error_code:text('last_error_code'),...times(),
},t=>[
  primaryKey({name:'email_provider_draft_mirrors_pkey',columns:[t.org_id,t.owner_user_id,t.account_id,t.draft_id]}),
  foreignKey({columns:[t.org_id,t.owner_user_id,t.account_id],foreignColumns:[emailAccounts.org_id,emailAccounts.owner_user_id,emailAccounts.account_id],name:'email_provider_draft_mirrors_account_fk'}).onDelete('restrict'),
  foreignKey({columns:[t.org_id,t.owner_user_id,t.account_id,t.draft_id],foreignColumns:[emailDrafts.org_id,emailDrafts.owner_user_id,emailDrafts.account_id,emailDrafts.draft_id],name:'email_provider_draft_mirrors_draft_fk'}).onDelete('restrict'),
  index('email_provider_draft_mirrors_repair_idx').on(t.org_id,t.owner_user_id,t.account_id,t.state,t.updated_at),
  check('email_provider_draft_mirrors_revision_check',sql`${t.desired_revision}>0 AND (${t.synced_revision} IS NULL OR ${t.synced_revision}>0) AND ${t.generation}>0 AND ${t.envelope_revision}>=0`),
  check('email_provider_draft_mirrors_state_check',sql`${t.state} IN ('queued','syncing','synced','conflict','unknown','unsupported','delete_pending','deleted','paused')`),
  check('email_provider_draft_mirrors_claim_check',sql`${t.claim_token_hash} IS NULL OR ${t.claim_token_hash} ~ '^[a-f0-9]{64}$'`),
  check('email_provider_draft_mirrors_lease_state_check',sql`(${t.state}='syncing') = (${t.claim_token_hash} IS NOT NULL AND ${t.claim_generation} IS NOT NULL AND ${t.claim_revision} IS NOT NULL AND ${t.claim_operation_id} IS NOT NULL) AND (${t.state}='syncing' OR (${t.claim_generation} IS NULL AND ${t.claim_revision} IS NULL AND ${t.claim_operation_id} IS NULL))`),
  check('email_provider_draft_mirrors_operation_check',sql`${t.claim_operation_id} IS NULL OR ${t.claim_operation_id} ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'`),
  check('email_provider_draft_mirrors_synced_envelope_check',sql`${t.state}<>'synced' OR ${t.provider_envelope} IS NOT NULL`),
  check('email_provider_draft_mirrors_error_check',sql`${t.last_error_code} IS NULL OR ${t.last_error_code} ~ '^[A-Z0-9_]{1,64}$'`),
]);
