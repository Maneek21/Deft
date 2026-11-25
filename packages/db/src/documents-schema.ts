import { bigint, boolean, customType, doublePrecision, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** Drives, folders, documents and what hangs off them. Created by upgrade
 * 0.3.0-preview.150 on both fresh installs and upgrades, so they are exported
 * as `@deft/db/documents` rather than from schema.ts. The upgrade file also
 * holds what this mirror leaves out: the org-qualified foreign keys, the
 * CHECKs, the principal check trigger (a member or share principal must
 * belong to the row's workspace), the member check trigger (a personal
 * drive's owner and a favorite's user need an `org_members` row in the row's
 * workspace) and the trigger that fills `documents.search_vector`. */

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });
const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

export const DOC_ROLES = ['full', 'edit', 'comment', 'view'] as const;
export type DocRole = (typeof DOC_ROLES)[number];
/** A drive's default role and a direct share never grant `full`. */
export type DocShareRole = Exclude<DocRole, 'full'>;
export type DriveKind = 'open' | 'private' | 'personal';
export type DriveSystemKey = 'workspace' | 'shared_notes';
export type DocPrincipalType = 'user' | 'space';
export type DocumentVersionKind = 'auto' | 'named' | 'agent' | 'restore' | 'import' | 'moved';
export type DocFavoriteTargetType = 'document' | 'drive';
export type NoteMoveSourceType = 'note' | 'note_folder' | 'canvas';
export type NoteMoveTargetType = 'document' | 'doc_folder';
export type NoteMoveOutcome = 'ok' | 'unsafe_content_dropped' | 'missing_images' | 'unsafe_and_missing';

const id = () => text('id').primaryKey().$defaultFn(() => crypto.randomUUID());
const createdAt = () => timestamp('created_at').defaultNow().notNull();
const updatedAt = () => timestamp('updated_at').defaultNow().notNull().$onUpdate(() => new Date());

/** An open drive gives every member `default_role`; a private drive only its
 * members; a personal drive is one person's My drive (`owner_user_id`).
 * `system_key` marks the drives a workspace creates for itself. Setting
 * `org_id` or `owner_user_id` to an owner with no `org_members` row in that
 * workspace is refused by a trigger (`doc_member_user_check`); other updates,
 * such as freezing, don't re-check. */
export const drives = pgTable('drives', {
  id: id(),
  org_id: text('org_id').notNull(),
  name: text('name').notNull(),
  icon: text('icon'),
  kind: text('kind').$type<DriveKind>().notNull(),
  system_key: text('system_key').$type<DriveSystemKey>(),
  owner_user_id: text('owner_user_id'),
  default_role: text('default_role').$type<DocShareRole>(),
  agent_suggest_only: boolean('agent_suggest_only').default(false).notNull(),
  knowledge_default: boolean('knowledge_default').default(true).notNull(),
  frozen_at: timestamp('frozen_at'),
  created_by: text('created_by'),
  is_deleted: boolean('is_deleted').default(false).notNull(),
  deleted_at: timestamp('deleted_at'),
  created_at: createdAt(),
  updated_at: updatedAt(),
}, (t) => [
  unique('drives_org_id_id_key').on(t.org_id, t.id),
  uniqueIndex('drives_personal_owner_uidx').on(t.org_id, t.owner_user_id).where(sql`kind = 'personal' AND NOT is_deleted`),
  uniqueIndex('drives_system_key_uidx').on(t.org_id, t.system_key).where(sql`system_key IS NOT NULL AND NOT is_deleted`),
]);

/** A person or a chat (space) with a role on a drive. `is_link` marks a
 * chat's own drive; a chat has at most one. */
export const driveMembers = pgTable('drive_members', {
  id: id(),
  org_id: text('org_id').notNull(),
  drive_id: text('drive_id').notNull(),
  principal_type: text('principal_type').$type<DocPrincipalType>().notNull(),
  principal_id: text('principal_id').notNull(),
  role: text('role').$type<DocRole>().notNull(),
  is_link: boolean('is_link').default(false).notNull(),
  added_by: text('added_by'),
  created_at: createdAt(),
  updated_at: updatedAt(),
}, (t) => [
  unique('drive_members_drive_principal_key').on(t.drive_id, t.principal_type, t.principal_id),
  index('drive_members_principal_idx').on(t.principal_type, t.principal_id),
  uniqueIndex('drive_members_space_link_uidx').on(t.org_id, t.principal_id).where(sql`principal_type = 'space' AND is_link`),
]);

/** Folders nest inside one drive; the parent folder is in the same drive. */
export const docFolders = pgTable('doc_folders', {
  id: id(),
  org_id: text('org_id').notNull(),
  drive_id: text('drive_id').notNull(),
  parent_folder_id: text('parent_folder_id'),
  name: text('name').notNull(),
  position: doublePrecision('position').default(0).notNull(),
  created_by: text('created_by'),
  is_deleted: boolean('is_deleted').default(false).notNull(),
  deleted_at: timestamp('deleted_at'),
  created_at: createdAt(),
  updated_at: updatedAt(),
}, (t) => [
  unique('doc_folders_org_drive_id_key').on(t.org_id, t.drive_id, t.id),
]);

/** A document is in a folder or under a parent document, never both, and in
 * the same drive as either. `ydoc_state` is the live-editing state and
 * `content_json` / `content_text` its stored copies. `revision` counts content
 * writes and `knowledge_generation` knowledge withdrawals. `search_vector` is
 * filled by a trigger; never write it. */
export const documents = pgTable('documents', {
  id: id(),
  org_id: text('org_id').notNull(),
  drive_id: text('drive_id').notNull(),
  folder_id: text('folder_id'),
  parent_document_id: text('parent_document_id'),
  title: text('title').default('').notNull(),
  icon: text('icon'),
  position: doublePrecision('position').default(0).notNull(),
  ydoc_state: bytea('ydoc_state'),
  content_json: jsonb('content_json').notNull(),
  content_text: text('content_text').default('').notNull(),
  search_vector: tsvector('search_vector'),
  use_in_knowledge: boolean('use_in_knowledge'),
  size_bytes: integer('size_bytes').default(0).notNull(),
  is_template: boolean('is_template').default(false).notNull(),
  revision: bigint('revision', { mode: 'number' }).default(0).notNull(),
  knowledge_generation: integer('knowledge_generation').default(0).notNull(),
  created_by: text('created_by'),
  last_edited_by: text('last_edited_by'),
  last_edited_at: timestamp('last_edited_at'),
  is_deleted: boolean('is_deleted').default(false).notNull(),
  deleted_at: timestamp('deleted_at'),
  deleted_by: text('deleted_by'),
  created_at: createdAt(),
  updated_at: updatedAt(),
}, (t) => [
  unique('documents_org_id_id_key').on(t.org_id, t.id),
  unique('documents_org_drive_id_key').on(t.org_id, t.drive_id, t.id),
  index('documents_org_drive_live_idx').on(t.org_id, t.drive_id).where(sql`NOT is_deleted`),
  index('documents_parent_idx').on(t.parent_document_id),
  index('documents_search_idx').using('gin', t.search_vector),
]);

/** A document shared directly with a person or a chat. */
export const documentShares = pgTable('document_shares', {
  id: id(),
  org_id: text('org_id').notNull(),
  document_id: text('document_id').notNull(),
  principal_type: text('principal_type').$type<DocPrincipalType>().notNull(),
  principal_id: text('principal_id').notNull(),
  role: text('role').$type<DocShareRole>().notNull(),
  shared_by: text('shared_by'),
  created_at: createdAt(),
  updated_at: updatedAt(),
}, (t) => [
  unique('document_shares_document_principal_key').on(t.document_id, t.principal_type, t.principal_id),
  index('document_shares_principal_idx').on(t.principal_type, t.principal_id),
]);

/** Saved versions. An agent edit stores at most one version per `action_id`,
 * so a retried edit is idempotent. Rows are never updated except to record
 * that their content was removed (`content_removed_*`). */
export const documentVersions = pgTable('document_versions', {
  id: id(),
  org_id: text('org_id').notNull(),
  document_id: text('document_id').notNull(),
  kind: text('kind').$type<DocumentVersionKind>().notNull(),
  name: text('name'),
  title: text('title'),
  ydoc_state: bytea('ydoc_state'),
  content_json: jsonb('content_json').notNull(),
  size_bytes: integer('size_bytes').notNull(),
  created_by: text('created_by'),
  agent_user_id: text('agent_user_id'),
  action_id: text('action_id'),
  edit_details: jsonb('edit_details'),
  content_removed_at: timestamp('content_removed_at'),
  content_removed_by: text('content_removed_by'),
  created_at: createdAt(),
}, (t) => [
  index('document_versions_document_created_idx').on(t.document_id, t.created_at.desc()),
  uniqueIndex('document_versions_agent_action_uidx').on(t.document_id, t.action_id).where(sql`kind = 'agent'`),
]);

/** Files a document uses. `in_current` turns false once the file is no longer
 * in the current content; the row stays for older versions. */
export const documentAttachments = pgTable('document_attachments', {
  id: id(),
  org_id: text('org_id').notNull(),
  document_id: text('document_id').notNull(),
  file_id: text('file_id').notNull(),
  in_current: boolean('in_current').default(true).notNull(),
  added_by: text('added_by'),
  created_at: createdAt(),
}, (t) => [
  unique('document_attachments_document_file_key').on(t.document_id, t.file_id),
  index('document_attachments_file_idx').on(t.file_id),
]);

/** A person's starred documents and drives. `user_id` must have an
 * `org_members` row in the row's workspace (trigger `doc_member_user_check`). */
export const docFavorites = pgTable('doc_favorites', {
  id: id(),
  org_id: text('org_id').notNull(),
  user_id: text('user_id').notNull(),
  target_type: text('target_type').$type<DocFavoriteTargetType>().notNull(),
  target_id: text('target_id').notNull(),
  created_at: createdAt(),
}, (t) => [
  unique('doc_favorites_user_target_key').on(t.user_id, t.target_type, t.target_id),
]);

/** Where each note, note folder and chat canvas went in the notes move, and
 * what the move had to leave out. One row per source. */
export const noteDocumentMap = pgTable('note_document_map', {
  id: id(),
  org_id: text('org_id').notNull(),
  source_type: text('source_type').$type<NoteMoveSourceType>().notNull(),
  source_id: text('source_id').notNull(),
  target_type: text('target_type').$type<NoteMoveTargetType>().notNull(),
  target_id: text('target_id').notNull(),
  outcome: text('outcome').$type<NoteMoveOutcome>().default('ok').notNull(),
  details: jsonb('details'),
  moved_at: timestamp('moved_at').defaultNow().notNull(),
}, (t) => [
  unique('note_document_map_source_key').on(t.source_type, t.source_id),
]);

export type DriveRow = typeof drives.$inferSelect;
export type DriveMemberRow = typeof driveMembers.$inferSelect;
export type DocFolderRow = typeof docFolders.$inferSelect;
export type DocumentRow = typeof documents.$inferSelect;
export type DocumentShareRow = typeof documentShares.$inferSelect;
export type DocumentVersionRow = typeof documentVersions.$inferSelect;
export type DocumentAttachmentRow = typeof documentAttachments.$inferSelect;
export type DocFavoriteRow = typeof docFavorites.$inferSelect;
export type NoteDocumentMapRow = typeof noteDocumentMap.$inferSelect;
