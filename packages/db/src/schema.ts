// packages/db/schema.ts — Deft database schema (Drizzle ORM + PostgreSQL)
// This schema covers: Auth, Orgs, Users, Chat (spaces + messages), Tasks, Projects, Agent, Events

import { pgTable, bigserial, text, timestamp, boolean, integer, jsonb, pgEnum, index, unique, uniqueIndex, real, vector, check, primaryKey, numeric, customType, foreignKey } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

// ═══ HELPERS ═══
const id = () => ({ id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()) });
const orgId = () => ({ org_id: text('org_id').notNull() });
const timestamps = () => ({
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull().$onUpdate(() => new Date()),
});
const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

// ═══ ENUMS ═══
export const orgRoleEnum = pgEnum('org_role', ['owner', 'admin', 'member', 'guest']);
export const userKindEnum = pgEnum('user_kind', ['human', 'agent', 'system']);
export const teamRoleEnum = pgEnum('team_role', ['lead', 'member', 'viewer']);
export const teamVisibilityEnum = pgEnum('team_visibility', ['private', 'org']);
export const teamResourceTypeEnum = pgEnum('team_resource_type', [
  'space',
  'project',
  'wiki_page',
  'note',
  'calendar_feed',
  'task_template',
  'agent_employee',
]);
export const spaceTypeEnum = pgEnum('space_type', ['public', 'private', 'dm', 'group_dm', 'agent_conversation']);
export const taskPriorityEnum = pgEnum('task_priority', ['p0', 'p1', 'p2', 'p3']);
export const taskStatusEnum = pgEnum('task_status', ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled']);
export const trustLevelEnum = pgEnum('trust_level', ['conservative', 'standard', 'autonomous']);
export const approvalTierEnum = pgEnum('approval_tier', ['auto', 'quick', 'full']);
export const approvalStatusEnum = pgEnum('approval_status', ['pending', 'approved', 'rejected', 'expired']);
export const workIntentKindEnum = pgEnum('work_intent_kind', [
  'task_candidate',
  'blocker_candidate',
  'decision_candidate',
  'resource_candidate',
  'note_candidate',
  'question_candidate',
]);
export const workIntentStatusEnum = pgEnum('work_intent_status', [
  'proposed',
  'converted',
  'dismissed',
  'expired',
  'failed',
]);
export const messageObservationStatusEnum = pgEnum('message_observation_status', [
  'queued',
  'processing',
  'ignored',
  'no_capture',
  'captured',
  'retrying',
  'failed',
]);
export const attachmentProcessingStatusEnum = pgEnum('attachment_processing_status', [
  'pending',
  'ready',
  'blocked',
  'failed',
]);
export const eventSourceEnum = pgEnum('event_source', ['native', 'google_calendar', 'github', 'slack', 'gmail', 'linear', 'ics']);
export const wikiPageTypeEnum = pgEnum('wiki_page_type', ['concept', 'entity', 'decision', 'resource', 'procedure', 'preference', 'fact']);
export const wikiPageScopeEnum = pgEnum('wiki_page_scope', ['org', 'space', 'user']);
export const mcpTransportEnum = pgEnum('mcp_transport', ['stdio', 'sse', 'streamable-http']);
export const agentEmployeeRoleEnum = pgEnum('agent_employee_role', [
  'superintendent',
  'project_manager',
  'engineering_lead',
  'executive_assistant',
  'custom',
  // Task 61 — expanded to cover the 8 first-party templates (Phase 9).
  'product_designer',
  'qa_engineer',
  'customer_success',
  'community_manager',
  'cfo',
]);
export const planStatusEnum = pgEnum('plan_status', ['draft', 'approved', 'executing', 'paused', 'completed', 'failed']);
export const planStepStatusEnum = pgEnum('plan_step_status', ['pending', 'running', 'completed', 'failed', 'skipped', 'waiting_approval']);
export const taskRelationshipTypeEnum = pgEnum('task_relationship_type', ['blocks', 'blocked_by', 'relates_to', 'duplicates']);
export type UserNotificationPreferences = {
  keywords: string[];
  channels: {
    chat: boolean;
    tasks: boolean;
    approvals: boolean;
    calendar: boolean;
    agents: boolean;
  };
  push: {
    enabled: boolean;
    chat: boolean;
    tasks: boolean;
    approvals: boolean;
    calendar: boolean;
    agents: boolean;
    quiet_hours: {
      enabled: boolean;
      start: string;
      end: string;
    };
  };
};

export const DEFAULT_NOTIFICATION_PREFERENCES: UserNotificationPreferences = {
  keywords: [],
  channels: {
    chat: true,
    tasks: true,
    approvals: true,
    calendar: true,
    agents: true,
  },
  push: {
    enabled: false,
    chat: true,
    tasks: true,
    approvals: true,
    calendar: true,
    agents: true,
    quiet_hours: {
      enabled: false,
      start: '22:00',
      end: '08:00',
    },
  },
};
export const notificationTypeEnum = pgEnum('notification_type', [
  'task',
  'task_assigned',
  'task_updated',
  'agent_suggestion',
  'mention',
  'message',
  'reminder',
  'huddle_started',
  'system',
  'blocked',
  'cross_reference',
  'workload_imbalance',
  'wiki_update',
  // Task 4.14 — daily cron surfaces when an installed skill has a newer
  // version in the registry; one notification per (employee, skill,
  // target_version) tuple, re-surfaces on the next version bump.
  'skill_update_available',
]);

// ═══ ORGS ═══
export const orgs = pgTable('orgs', {
  ...id(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  logo_url: text('logo_url'),
  timezone: text('timezone').default('UTC').notNull(),
  trust_level: trustLevelEnum('trust_level').default('conservative').notNull(),
  agent_name: text('agent_name').default('Deft'),
  agent_enabled: boolean('agent_enabled').default(true).notNull(),
  // Per-org AI provider config (BYOK). Read via apps/api/src/lib/org-ai-config.ts.
  // Schema documented in packages/db/drizzle/0061_org_ai_config.sql.
  ai_config: jsonb('ai_config').$type<Record<string, unknown>>().notNull().default({}),
  ...timestamps(),
});

// ═══ USERS ═══
export const users = pgTable('users', {
  ...id(),
  email: text('email').unique(),
  name: text('name').notNull(),
  kind: userKindEnum('kind').default('human').notNull(),
  is_agent: boolean('is_agent').default(false).notNull(),
  agent_employee_id: text('agent_employee_id'),
  avatar_url: text('avatar_url'),
  title: text('title'),
  profile_summary: text('profile_summary'),
  expertise_tags: text('expertise_tags').array(),
  timezone: text('timezone').default('UTC'),
  status_emoji: text('status_emoji'),
  status_text: text('status_text'),
  status_expires_at: timestamp('status_expires_at'),
  password_hash: text('password_hash'),
  password_version: integer('password_version').default(0).notNull(),
  email_verified: boolean('email_verified').default(false).notNull(),
  last_seen_at: timestamp('last_seen_at'),
  notification_keywords: text('notification_keywords').array(),
  notification_preferences: jsonb('notification_preferences')
    .$type<UserNotificationPreferences>()
    .notNull()
    .default(DEFAULT_NOTIFICATION_PREFERENCES),
  show_read_receipts: boolean('show_read_receipts').default(true).notNull(),
  // Per-user secret token for the outbound ICS feed. Lazily generated when
  // the user first opens Settings → Calendar. See migration 0062.
  ics_publish_token: text('ics_publish_token'),
  ...timestamps(),
});

// Durable native-create identities; retain tombstones when a resource is deleted.
export const nativeCreateRequests = pgTable('native_create_requests', {
  id: text('id').primaryKey(),
  org_id: text('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  operation: text('operation').notNull(),
  request_hash: text('request_hash').notNull(),
  resource_id: text('resource_id').notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (t) => [index('native_create_requests_org_idx').on(t.org_id)]);

// ═══ ORG MEMBERS ═══
export const orgMembers = pgTable('org_members', {
  ...id(),
  ...orgId(),
  user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: orgRoleEnum('role').default('member').notNull(),
  is_active: boolean('is_active').default(true).notNull(),
  app_run_authorization_version: integer('app_run_authorization_version').default(1).notNull(),
  joined_at: timestamp('joined_at').defaultNow().notNull(),
  ...timestamps(),
}, (t) => [
  unique('org_member_unique').on(t.org_id, t.user_id),
]);

// ═══ INVITES ═══
export const invites = pgTable('invites', {
  ...id(),
  ...orgId(),
  email: text('email'),
  token: text('token').notNull().unique(),
  type: text('type').default('email').notNull(), // 'email' | 'link'
  invited_by: text('invited_by').notNull().references(() => users.id),
  accepted_by: text('accepted_by').references(() => users.id),
  accepted_at: timestamp('accepted_at'),
  expires_at: timestamp('expires_at'),
  ...timestamps(),
});

// ═══ SPACES (CHANNELS) ═══
export const spaces = pgTable('spaces', {
  ...id(),
  ...orgId(),
  name: text('name').notNull(),
  description: text('description'),
  topic: text('topic'),
  type: spaceTypeEnum('type').default('public').notNull(),
  is_default: boolean('is_default').default(false).notNull(),
  is_archived: boolean('is_archived').default(false).notNull(),
  agent_enabled: boolean('agent_enabled').default(true).notNull(),
  created_by: text('created_by').references(() => users.id),
  ...timestamps(),
}, (t) => [
  index('space_org_idx').on(t.org_id),
]);

// ═══ SPACE MEMBERS ═══
export const spaceMembers = pgTable('space_members', {
  ...id(),
  space_id: text('space_id').notNull().references(() => spaces.id),
  user_id: text('user_id').notNull().references(() => users.id),
  is_muted: boolean('is_muted').default(false).notNull(),
  notification_level: text('notification_level').default('all').notNull(),
  last_read_message_id: text('last_read_message_id'),
  last_read_at: timestamp('last_read_at'),
  joined_at: timestamp('joined_at').defaultNow().notNull(),
}, (t) => [
  uniqueIndex('space_member_unique').on(t.space_id, t.user_id),
]);

// ═══ MESSAGES ═══
export const messages = pgTable('messages', {
  ...id(),
  ...orgId(),
  space_id: text('space_id').notNull().references(() => spaces.id),
  user_id: text('user_id').notNull().references(() => users.id),
  content: text('content').notNull(),
  parent_id: text('parent_id'), // thread parent (self-ref)
  is_pinned: boolean('is_pinned').default(false).notNull(),
  is_deleted: boolean('is_deleted').default(false).notNull(),
  edited_at: timestamp('edited_at'),
  metadata: jsonb('metadata'), // link previews, unfurled data, etc.
  ...timestamps(),
}, (t) => [
  index('message_space_idx').on(t.space_id),
  index('message_org_idx').on(t.org_id),
  index('message_parent_idx').on(t.parent_id),
  index('message_created_idx').on(t.created_at),
  unique('messages_org_id_id_unique').on(t.org_id, t.id),
]);

// ═══ REACTIONS ═══
export const reactions = pgTable('reactions', {
  ...id(),
  message_id: text('message_id').notNull().references(() => messages.id),
  user_id: text('user_id').notNull().references(() => users.id),
  emoji: text('emoji').notNull(),
  ...timestamps(),
}, (t) => [
  uniqueIndex('reaction_unique').on(t.message_id, t.user_id, t.emoji),
]);

// ═══ FILES ═══
export const files = pgTable('files', {
  ...id(),
  ...orgId(),
  uploaded_by: text('uploaded_by').notNull().references(() => users.id),
  filename: text('filename').notNull(),
  mime_type: text('mime_type').notNull(),
  size_bytes: integer('size_bytes').notNull(),
  storage_key: text('storage_key').notNull(), // R2/local path
  thumbnail_key: text('thumbnail_key'),
  detected_mime_type: text('detected_mime_type'),
  attachment_kind: text('attachment_kind').default('binary').notNull(),
  content_sha256: text('content_sha256'),
  processing_status: attachmentProcessingStatusEnum('processing_status').default('pending').notNull(),
  processing_error: text('processing_error'),
  processed_at: timestamp('processed_at'),
  staged_expires_at: timestamp('staged_expires_at'),
  message_id: text('message_id').references(() => messages.id),
  task_id: text('task_id'), // filled when attached to task
  ...timestamps(),
}, (t) => [
  index('files_org_idx').on(t.org_id),
  index('files_staged_expiry_idx').on(t.staged_expires_at),
  unique('files_org_id_id_unique').on(t.org_id, t.id),
  check(
    'files_attachment_kind_check',
    sql`${t.attachment_kind} IN ('text', 'image', 'spreadsheet', 'pdf', 'document', 'archive', 'binary')`,
  ),
  check(
    'files_content_sha256_check',
    sql`${t.content_sha256} IS NULL OR ${t.content_sha256} ~ '^sha256:[a-f0-9]{64}$'`,
  ),
]);

// Bounded, permission-inheriting derivatives. The original bytes stay in the
// FileStore; this table contains only safe-to-read text representations.
export const attachmentDerivatives = pgTable('attachment_derivatives', {
  org_id: text('org_id').notNull(),
  file_id: text('file_id').notNull(),
  kind: text('kind').notNull(),
  mime_type: text('mime_type').notNull(),
  content: text('content').notNull(),
  size_bytes: integer('size_bytes').notNull(),
  metadata: jsonb('metadata'),
  ...timestamps(),
}, (t) => [
  primaryKey({ columns: [t.file_id, t.kind] }),
  foreignKey({
    columns: [t.org_id, t.file_id],
    foreignColumns: [files.org_id, files.id],
    name: 'attachment_derivatives_org_file_fk',
  }).onDelete('cascade'),
  index('attachment_derivatives_org_file_idx').on(t.org_id, t.file_id),
  check('attachment_derivatives_size_check', sql`${t.size_bytes} >= 0`),
]);

// ═══ PROJECTS ═══
export const projects = pgTable('projects', {
  ...id(),
  ...orgId(),
  name: text('name').notNull(),
  description: text('description'),
  prefix: text('prefix').notNull(), // e.g., 'PROJ', 'ENG' — for task IDs
  icon: text('icon'),
  color: text('color'),
  lead_id: text('lead_id').references(() => users.id),
  is_archived: boolean('is_archived').default(false).notNull(),
  is_deleted: boolean('is_deleted').default(false).notNull(),
  deleted_at: timestamp('deleted_at'),
  task_counter: integer('task_counter').default(0).notNull(), // auto-increment for task IDs
  ...timestamps(),
}, (t) => [
  uniqueIndex('project_prefix_unique').on(t.org_id, t.prefix),
]);

// ═══ PROJECT ↔ SPACE LINKS ═══
export const projectSpaces = pgTable('project_spaces', {
  ...id(),
  project_id: text('project_id').notNull().references(() => projects.id),
  space_id: text('space_id').notNull().references(() => spaces.id),
}, (t) => [
  uniqueIndex('project_space_unique').on(t.project_id, t.space_id),
]);

// ═══ TASKS ═══
export const tasks = pgTable('tasks', {
  ...id(),
  ...orgId(),
  project_id: text('project_id').notNull().references(() => projects.id),
  number: integer('number').notNull(), // auto-increment per project
  title: text('title').notNull(),
  description: text('description'),
  status: taskStatusEnum('status').default('backlog').notNull(),
  priority: taskPriorityEnum('priority').default('p2').notNull(),
  /**
   * Primary assignee (singular).
   * Used by board columns, dashboard "My Tasks", nudge targeting, and status-change
   * notifications. Every task has exactly one primary assignee or null.
   * @see Phase 0.3 plan — primary assignee; use taskAssignees for additional
   */
  assignee_id: text('assignee_id').references(() => users.id),
  created_by: text('created_by').notNull().references(() => users.id),
  due_date: timestamp('due_date'),
  start_date: timestamp('start_date'),
  estimation: text('estimation'),
  is_template: boolean('is_template').default(false).notNull(),
  recurrence: text('recurrence'), // 'daily' | 'weekly' | 'biweekly' | 'monthly' | null
  recurrence_source_id: text('recurrence_source_id'), // links to original recurring task
  sort_order: real('sort_order').default(0).notNull(),
  source_message_id: text('source_message_id').references(() => messages.id),
  parent_task_id: text('parent_task_id').references((): any => tasks.id, { onDelete: 'set null' }),  // self-reference for subtasks (one level deep)
  is_deleted: boolean('is_deleted').default(false).notNull(),
  /**
   * Task 3.8 — pgvector embedding over (title + description) for semantic
   * search via retrieveContext({ types: ['tasks'] }). Populated by the
   * embed-content worker (source_type: 'task') and backfilled via
   * backfill-task-embeddings.ts.
   */
  embedding: vector('embedding', { dimensions: 1536 }),
  /**
   * Task 4.11 — skill-defined custom-field payload. Keys match the `id`s
   * in the resolved skill config's `custom_fields[]` (e.g. Sales skill
   * stores `deal_value`, `contact_name`). Null for tasks in projects with
   * no custom fields. Not covered by tasks.search_vector (FTS still scans
   * title + description only).
   */
  metadata: jsonb('metadata'),
  ...timestamps(),
  // NOTE: tasks.search_vector is a GENERATED ALWAYS column declared in
  // migration 0033. Drizzle does not have a first-class generated-column
  // builder, so it is intentionally omitted from the schema — SQL code paths
  // that need it reference it via `sql` literals (see retrieve-context.ts).
}, (t) => [
  index('task_project_idx').on(t.project_id),
  index('task_assignee_idx').on(t.assignee_id),
  index('task_org_idx').on(t.org_id),
  index('task_parent_idx').on(t.parent_task_id),
  uniqueIndex('task_number_unique').on(t.project_id, t.number),
  unique('tasks_org_id_id_unique').on(t.org_id, t.id),
]);

// ═══ TYPED ATTACHMENT LINKS ═══
// Legacy files.message_id/task_id stay in place during the expand-and-contract
// window. New writes are mirrored here so every target link carries an explicit
// tenant boundary and deterministic ordering.
export const messageAttachments = pgTable('message_attachments', {
  org_id: text('org_id').notNull(),
  message_id: text('message_id').notNull(),
  file_id: text('file_id').notNull(),
  position: integer('position').default(0).notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  primaryKey({ columns: [t.message_id, t.file_id] }),
  foreignKey({
    columns: [t.org_id, t.message_id],
    foreignColumns: [messages.org_id, messages.id],
    name: 'message_attachments_org_message_fk',
  }).onDelete('cascade'),
  foreignKey({
    columns: [t.org_id, t.file_id],
    foreignColumns: [files.org_id, files.id],
    name: 'message_attachments_org_file_fk',
  }).onDelete('cascade'),
  index('message_attachments_org_message_position_idx').on(t.org_id, t.message_id, t.position),
  index('message_attachments_file_idx').on(t.file_id),
  check('message_attachments_position_check', sql`${t.position} >= 0`),
]);

export const taskAttachments = pgTable('task_attachments', {
  org_id: text('org_id').notNull(),
  task_id: text('task_id').notNull(),
  file_id: text('file_id').notNull(),
  position: integer('position').default(0).notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  primaryKey({ columns: [t.task_id, t.file_id] }),
  foreignKey({
    columns: [t.org_id, t.task_id],
    foreignColumns: [tasks.org_id, tasks.id],
    name: 'task_attachments_org_task_fk',
  }).onDelete('cascade'),
  foreignKey({
    columns: [t.org_id, t.file_id],
    foreignColumns: [files.org_id, files.id],
    name: 'task_attachments_org_file_fk',
  }).onDelete('cascade'),
  index('task_attachments_org_task_position_idx').on(t.org_id, t.task_id, t.position),
  index('task_attachments_file_idx').on(t.file_id),
  check('task_attachments_position_check', sql`${t.position} >= 0`),
]);

// ═══ LABELS ═══
export const labels = pgTable('labels', {
  ...id(),
  ...orgId(),
  name: text('name').notNull(),
  color: text('color').notNull(),
  ...timestamps(),
});

export const taskLabels = pgTable('task_labels', {
  task_id: text('task_id').notNull().references(() => tasks.id),
  label_id: text('label_id').notNull().references(() => labels.id),
}, (t) => [
  primaryKey({ columns: [t.task_id, t.label_id] }),
]);

// ═══ TASK COMMENTS ═══
export const taskComments = pgTable('task_comments', {
  ...id(),
  org_id: text('org_id').notNull().references(() => orgs.id),
  task_id: text('task_id').notNull().references(() => tasks.id),
  user_id: text('user_id').notNull().references(() => users.id),
  content: text('content').notNull(),
  is_deleted: boolean('is_deleted').default(false).notNull(),
  ...timestamps(),
}, (t) => [
  index('task_comments_org_task_idx').on(t.org_id, t.task_id),
]);

// ═══ TASK REACTIONS ═══
// Task 6.3 — emoji reactions on tasks. A (task, user, emoji)
// tuple is unique; duplicate POST toggles off, DELETE removes explicitly.
export const taskReactions = pgTable('task_reactions', {
  ...id(),
  org_id: text('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  task_id: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  emoji: text('emoji').notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  uniqueIndex('task_reactions_unique').on(t.task_id, t.user_id, t.emoji),
  index('task_reactions_task_idx').on(t.task_id),
  index('task_reactions_org_idx').on(t.org_id),
]);

// ═══ TASK ACTIVITY LOG ═══
export const taskActivity = pgTable('task_activity', {
  ...id(),
  org_id: text('org_id').notNull().references(() => orgs.id),
  task_id: text('task_id').notNull().references(() => tasks.id),
  user_id: text('user_id').references(() => users.id), // null = agent
  action: text('action').notNull(), // 'status_changed', 'assigned', 'priority_changed', 'commented', 'created'
  field: text('field'),
  old_value: text('old_value'),
  new_value: text('new_value'),
  // Task 3.3 — attribution to the specific agent action + employee that
  // produced this activity row. Both nullable; when set they link the
  // activity log entry to an agentActions row and/or an agentEmployees
  // row so the UI can show "done by agent X via plan Y".
  agent_action_id: text('agent_action_id'),
  acting_agent_employee_id: text('acting_agent_employee_id'),
  ...timestamps(),
}, (t) => [
  index('activity_task_idx').on(t.task_id),
  index('task_activity_org_task_idx').on(t.org_id, t.task_id),
]);

// ═══ TASK RELATIONSHIPS ═══
export const taskRelationships = pgTable('task_relationships', {
  ...id(),
  source_task_id: text('source_task_id').notNull().references(() => tasks.id),
  target_task_id: text('target_task_id').notNull().references(() => tasks.id),
  type: taskRelationshipTypeEnum('type').notNull(),
  ...timestamps(),
});

// ═══ TASK WATCHERS ═══
export const taskWatchers = pgTable('task_watchers', {
  ...id(),
  task_id: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  user_id: text('user_id').notNull().references(() => users.id),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  uniqueIndex('task_watcher_unique').on(t.task_id, t.user_id),
  index('task_watcher_task_idx').on(t.task_id),
]);

// ═══ TASK ASSIGNEES ═══
/**
 * Additional (non-primary) assignees — shown as secondary avatars on the task card.
 * The task's single primary assignee lives on tasks.assignee_id and MUST NOT be
 * duplicated here. Route handlers enforce this invariant.
 * @see Phase 0.3 — additional (non-primary) assignees; do not duplicate tasks.assignee_id here
 */
export const taskAssignees = pgTable('task_assignees', {
  ...id(),
  task_id: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  user_id: text('user_id').notNull().references(() => users.id),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  uniqueIndex('task_assignee_unique').on(t.task_id, t.user_id),
]);

// ═══ NOTIFICATIONS ═══
export const notifications = pgTable('notifications', {
  ...id(),
  ...orgId(),
  user_id: text('user_id').notNull().references(() => users.id),
  type: notificationTypeEnum('type').notNull(),
  title: text('title').notNull(),
  body: text('body'),
  link: text('link'), // URL to navigate to
  is_read: boolean('is_read').default(false).notNull(),
  metadata: jsonb('metadata'),
  ...timestamps(),
}, (t) => [
  index('notification_user_idx').on(t.user_id),
  uniqueIndex('notification_reminder_unique')
    .on(t.org_id, sql`(${t.metadata}->>'reminder_id')`)
    .where(sql`${t.type} = 'reminder' AND ${t.metadata} ? 'reminder_id'`),
]);

// ═══ SAVED VIEWS ═══
export const savedViews = pgTable('saved_views', {
  ...id(),
  ...orgId(),
  project_id: text('project_id').references(() => projects.id),
  user_id: text('user_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  config: jsonb('config').notNull(), // { filters, sort, group_by, columns }
  is_shared: boolean('is_shared').default(false).notNull(),
  ...timestamps(),
});

// ═══ USER FAVORITES ═══
export const favorites = pgTable('favorites', {
  ...id(),
  user_id: text('user_id').notNull().references(() => users.id),
  entity_type: text('entity_type').notNull(), // 'project', 'space', 'task'
  entity_id: text('entity_id').notNull(),
  sort_order: real('sort_order').default(0).notNull(),
  ...timestamps(),
}, (t) => [
  uniqueIndex('favorite_unique').on(t.user_id, t.entity_type, t.entity_id),
]);

// ═══ GOVERNED APP RUNS (DORMANT PHASE 3 FOUNDATION) ═══
// These tables are additive and have no execution consumer until a later,
// separately certified phase. Secret payload ciphertext is intentionally split
// from safe Run metadata so ordinary app_runs selections cannot expose it.
export const capabilityProviderSnapshots = pgTable('capability_provider_snapshots', {
  ...id(),
  org_id: text('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  provider_kind: text('provider_kind').$type<'mcp' | 'app_runtime' | 'native'>().notNull(),
  provider_instance_id: text('provider_instance_id').notNull(),
  adapter_contract_version: text('adapter_contract_version').notNull(),
  snapshot_digest: text('snapshot_digest').notNull(),
  safe_snapshot: jsonb('safe_snapshot').$type<Record<string, unknown>>().notNull(),
  captured_at: timestamp('captured_at').notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  unique('capability_provider_snapshots_org_id_id_unique').on(t.org_id, t.id),
  unique('capability_provider_snapshots_org_provider_id_unique')
    .on(t.org_id, t.provider_kind, t.provider_instance_id, t.id),
  uniqueIndex('capability_provider_snapshots_identity_digest_unique')
    .on(t.org_id, t.provider_kind, t.provider_instance_id, t.snapshot_digest),
  index('capability_provider_snapshots_provider_idx')
    .on(t.org_id, t.provider_kind, t.provider_instance_id, t.captured_at),
  check('capability_provider_snapshots_kind_check', sql`${t.provider_kind} IN ('mcp', 'app_runtime', 'native')`),
  check('capability_provider_snapshots_digest_check', sql`${t.snapshot_digest} ~ '^sha256:[a-f0-9]{64}$'`),
  check('capability_provider_snapshots_json_check', sql`jsonb_typeof(${t.safe_snapshot}) = 'object'`),
  check('capability_provider_snapshots_size_check', sql`octet_length(${t.safe_snapshot}::text) <= 1048576`),
]);

export const appRuns = pgTable('app_runs', {
  ...id(),
  org_id: text('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  contract_version: text('contract_version').$type<'deft.app_run.v1'>().notNull(),
  origin_kind: text('origin_kind').$type<'core' | 'legacy_connector' | 'app'>().notNull(),
  initiating_actor_type: text('initiating_actor_type')
    .$type<'human' | 'agent_employee' | 'system' | 'automation' | 'app_public'>()
    .notNull(),
  initiating_actor_id: text('initiating_actor_id').notNull(),
  execution_actor_type: text('execution_actor_type')
    .$type<'human' | 'agent_employee' | 'system' | 'automation'>()
    .notNull(),
  execution_actor_id: text('execution_actor_id').notNull(),
  provider_kind: text('provider_kind').$type<'mcp' | 'app_runtime' | 'native'>().notNull(),
  provider_instance_id: text('provider_instance_id').notNull(),
  operation_name: text('operation_name').notNull(),
  provider_snapshot_id: text('provider_snapshot_id').notNull(),
  origin_app_installation_id: text('origin_app_installation_id'),
  origin_app_version_id: text('origin_app_version_id'),
  origin_app_binding_key: text('origin_app_binding_key'),
  origin_runtime_binding_id: text('origin_runtime_binding_id'),
  origin_resource_binding_id: text('origin_resource_binding_id'),
  origin_native_binding_id: text('origin_native_binding_id'),
  origin_public_endpoint_id: text('origin_public_endpoint_id'),
  origin_public_ingress_id: text('origin_public_ingress_id'),
  origin_app_grant_snapshot_id: text('origin_app_grant_snapshot_id'),
  origin_app_automation_definition_id: text('origin_app_automation_definition_id'),
  origin_app_automation_fire_id: text('origin_app_automation_fire_id'),
  state: text('state').$type<
    | 'pending'
    | 'pending_approval'
    | 'running'
    | 'waiting_external'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'expired'
    | 'unknown_outcome'
  >().default('pending').notNull(),
  risk_class: text('risk_class')
    .$type<'read' | 'internal_write' | 'external_write' | 'destructive' | 'privileged'>()
    .notNull(),
  review_requirement: text('review_requirement').$type<'policy' | 'always'>().notNull(),
  review_scope: text('review_scope')
    .$type<'per_invocation' | 'immutable_batch' | 'approved_automation_definition' | 'forbidden_in_automation' | 'reviewed_resource_sync'>()
    .notNull(),
  retry_class: text('retry_class').$type<'safe' | 'idempotent_with_key' | 'unsafe_or_unknown'>().notNull(),
  retention_class: text('retention_class').$type<'ephemeral' | 'standard' | 'extended'>().notNull(),
  idempotency_key_version: text('idempotency_key_version').notNull(),
  idempotency_fingerprint: text('idempotency_fingerprint').notNull(),
  input_fingerprint_key_version: text('input_fingerprint_key_version').notNull(),
  input_fingerprint: text('input_fingerprint').notNull(),
  authorization_snapshot: jsonb('authorization_snapshot').$type<Record<string, unknown>>().notNull(),
  safe_preview: jsonb('safe_preview').$type<Record<string, unknown>>().notNull(),
  safe_outcome: jsonb('safe_outcome').$type<Record<string, unknown> | null>(),
  root_run_id: text('root_run_id').notNull(),
  parent_run_id: text('parent_run_id'),
  depth: integer('depth').default(0).notNull(),
  input_expires_at: timestamp('input_expires_at').notNull(),
  result_expires_at: timestamp('result_expires_at').notNull(),
  idempotency_expires_at: timestamp('idempotency_expires_at').notNull(),
  attempt_limit: integer('attempt_limit').notNull(),
  execution_release_kind: text('execution_release_kind')
    .$type<'policy_satisfied' | 'approved' | 'approved_automation_definition'>(),
  execution_released_at: timestamp('execution_released_at'),
  budget_reserved_at: timestamp('budget_reserved_at'),
  budget_reserved_count: integer('budget_reserved_count'),
  budget_limit_at_reservation: integer('budget_limit_at_reservation'),
  input_purged_at: timestamp('input_purged_at'),
  result_purged_at: timestamp('result_purged_at'),
  started_at: timestamp('started_at'),
  terminal_at: timestamp('terminal_at'),
  unknown_outcome_at: timestamp('unknown_outcome_at'),
  reconciled_at: timestamp('reconciled_at'),
  cancelled_at: timestamp('cancelled_at'),
  cancel_requested_at: timestamp('cancel_requested_at'),
  ...timestamps(),
}, (t) => [
  unique('app_runs_org_id_id_unique').on(t.org_id, t.id),
  unique('app_runs_resource_attempt_identity_unique').on(t.org_id, t.id, t.origin_resource_binding_id),
  unique('app_runs_sync_intent_identity_unique').on(t.org_id, t.id,
    t.origin_app_installation_id, t.origin_app_version_id,
    t.origin_app_grant_snapshot_id, t.origin_resource_binding_id,
    t.provider_snapshot_id),
  foreignKey({
    columns: [t.org_id, t.provider_snapshot_id],
    foreignColumns: [capabilityProviderSnapshots.org_id, capabilityProviderSnapshots.id],
    name: 'app_runs_org_provider_snapshot_fk',
  }).onDelete('no action'),
  foreignKey({
    columns: [t.org_id, t.root_run_id],
    foreignColumns: [t.org_id, t.id],
    name: 'app_runs_org_root_run_fk',
  }).onDelete('no action'),
  foreignKey({
    columns: [t.org_id, t.parent_run_id],
    foreignColumns: [t.org_id, t.id],
    name: 'app_runs_org_parent_run_fk',
  }).onDelete('no action'),
  foreignKey({
    columns: [t.org_id, t.origin_app_installation_id],
    foreignColumns: [appInstallations.org_id, appInstallations.id],
    name: 'app_runs_app_installation_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.org_id, t.origin_app_installation_id, t.origin_app_version_id],
    foreignColumns: [appVersions.org_id, appVersions.installation_id, appVersions.id],
    name: 'app_runs_app_version_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [
      t.org_id,
      t.origin_app_installation_id,
      t.origin_app_version_id,
      t.origin_app_grant_snapshot_id,
    ],
    foreignColumns: [
      appGrantSnapshots.org_id,
      appGrantSnapshots.app_installation_id,
      appGrantSnapshots.app_version_id,
      appGrantSnapshots.id,
    ],
    name: 'app_runs_app_grant_snapshot_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [
      t.org_id,
      t.origin_app_installation_id,
      t.origin_app_version_id,
      t.origin_app_grant_snapshot_id,
      t.origin_app_binding_key,
      t.provider_kind,
      t.provider_instance_id,
      t.operation_name,
      t.provider_snapshot_id,
    ],
    foreignColumns: [
      appActionBindings.org_id,
      appActionBindings.app_installation_id,
      appActionBindings.app_version_id,
      appActionBindings.grant_snapshot_id,
      appActionBindings.action_key,
      appActionBindings.provider_kind,
      appActionBindings.mcp_connection_id,
      appActionBindings.operation_name,
      appActionBindings.provider_snapshot_id,
    ],
    name: 'app_runs_app_action_binding_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.org_id, t.origin_app_installation_id, t.origin_app_version_id,
      t.origin_app_grant_snapshot_id, t.origin_runtime_binding_id, t.provider_kind,
      t.provider_instance_id, t.operation_name, t.provider_snapshot_id,
      t.risk_class, t.review_requirement, t.retry_class, t.retention_class],
    foreignColumns: [appRuntimeBindings.org_id, appRuntimeBindings.app_installation_id,
      appRuntimeBindings.app_version_id, appRuntimeBindings.grant_snapshot_id,
      appRuntimeBindings.id, appRuntimeBindings.provider_kind,
      appRuntimeBindings.provider_instance_id, appRuntimeBindings.operation_name,
      appRuntimeBindings.provider_snapshot_id, appRuntimeBindings.risk_class,
      appRuntimeBindings.review_requirement, appRuntimeBindings.retry_class,
      appRuntimeBindings.retention_class],
    name: 'app_runs_runtime_binding_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.org_id, t.origin_app_installation_id, t.origin_app_version_id,
      t.origin_app_grant_snapshot_id, t.origin_resource_binding_id, t.provider_kind,
      t.provider_instance_id, t.operation_name, t.provider_snapshot_id,
      t.risk_class, t.review_requirement, t.review_scope, t.retry_class, t.retention_class],
    foreignColumns: [appResourceBindings.org_id, appResourceBindings.app_installation_id,
      appResourceBindings.app_version_id, appResourceBindings.grant_snapshot_id,
      appResourceBindings.id, appResourceBindings.provider_kind,
      appResourceBindings.provider_instance_id, appResourceBindings.operation_name,
      appResourceBindings.provider_snapshot_id, appResourceBindings.risk_class,
      appResourceBindings.review_requirement, appResourceBindings.review_scope,
      appResourceBindings.retry_class, appResourceBindings.retention_class],
    name: 'app_runs_resource_binding_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.org_id, t.origin_app_installation_id, t.origin_app_version_id, t.origin_app_grant_snapshot_id,
      t.origin_native_binding_id, t.provider_kind, t.provider_instance_id, t.operation_name, t.provider_snapshot_id,
      t.execution_actor_id, t.risk_class, t.review_requirement, t.review_scope, t.retry_class, t.retention_class],
    foreignColumns: [appNativeBindings.org_id, appNativeBindings.app_installation_id, appNativeBindings.app_version_id,
      appNativeBindings.grant_snapshot_id, appNativeBindings.id, appNativeBindings.provider_kind,
      appNativeBindings.provider_instance_id, appNativeBindings.operation_name, appNativeBindings.provider_snapshot_id,
      appNativeBindings.owner_user_id, appNativeBindings.risk_class, appNativeBindings.review_requirement,
      appNativeBindings.review_scope, appNativeBindings.retry_class, appNativeBindings.retention_class],
    name: 'app_runs_native_binding_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.org_id, t.origin_app_automation_definition_id],
    foreignColumns: [appAutomationDefinitions.org_id, appAutomationDefinitions.id],
    name: 'app_runs_automation_definition_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.org_id, t.origin_public_endpoint_id, t.origin_public_ingress_id],
    foreignColumns: [appPublicIngress.org_id, appPublicIngress.endpoint_id, appPublicIngress.id],
    name: 'app_runs_public_ingress_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [
      t.org_id,
      t.origin_app_automation_definition_id,
      t.origin_app_automation_fire_id,
    ],
    foreignColumns: [
      appAutomationFires.org_id,
      appAutomationFires.definition_id,
      appAutomationFires.id,
    ],
    name: 'app_runs_automation_fire_fk',
  }).onDelete('restrict'),
  unique('app_runs_automation_lineage_unique').on(
    t.org_id,
    t.origin_app_automation_definition_id,
    t.origin_app_automation_fire_id,
    t.id,
  ),
  uniqueIndex('app_runs_automation_fire_unique')
    .on(t.org_id, t.origin_app_automation_definition_id, t.origin_app_automation_fire_id)
    .where(sql`${t.origin_app_automation_fire_id} IS NOT NULL`),
  uniqueIndex('app_runs_public_ingress_unique')
    .on(t.org_id, t.origin_public_endpoint_id, t.origin_public_ingress_id)
    .where(sql`${t.origin_public_ingress_id} IS NOT NULL`),
  index('app_runs_idempotency_lookup_idx').on(
    t.org_id,
    t.initiating_actor_type,
    t.initiating_actor_id,
    t.provider_kind,
    t.provider_instance_id,
    t.operation_name,
    t.idempotency_key_version,
    t.idempotency_fingerprint,
    t.idempotency_expires_at,
  ),
  index('app_runs_org_state_idx').on(t.org_id, t.state, t.created_at),
  index('app_runs_root_idx').on(t.org_id, t.root_run_id, t.created_at),
  index('app_runs_parent_idx').on(t.org_id, t.parent_run_id),
  index('app_runs_automation_lineage_idx').on(
    t.org_id,
    t.origin_app_automation_definition_id,
    t.origin_app_automation_fire_id,
  ),
  index('app_runs_secret_expiry_idx').on(t.state, t.input_expires_at, t.result_expires_at),
  index('app_runs_idempotency_expiry_idx').on(t.idempotency_expires_at),
  check('app_runs_origin_check', sql`${t.origin_kind} IN ('core', 'legacy_connector', 'app')`),
  check('app_runs_contract_version_check', sql`${t.contract_version} = 'deft.app_run.v1'`),
  // Database ancestry is exact; the API's independent feature flag remains
  // disabled by default until Phase 5 certification deliberately enables it.
  check('app_runs_app_origin_coherence_check', sql`
    (${t.origin_native_binding_id} IS NULL AND (
    (
      ${t.origin_kind} = 'app'
      AND ${t.origin_app_installation_id} IS NOT NULL
      AND ${t.origin_app_version_id} IS NOT NULL
      AND ${t.provider_kind} = 'mcp'
      AND ${t.origin_app_binding_key} IS NOT NULL
      AND ${t.origin_runtime_binding_id} IS NULL
      AND ${t.origin_resource_binding_id} IS NULL
      AND ${t.origin_public_endpoint_id} IS NULL
      AND ${t.origin_public_ingress_id} IS NULL
      AND ${t.origin_app_grant_snapshot_id} IS NOT NULL
      AND ${t.risk_class} = 'external_write'
      AND ${t.review_requirement} = 'always'
      AND ${t.retry_class} = 'idempotent_with_key'
      AND ${t.retention_class} = 'standard'
      AND (
        (
          ${t.review_scope} = 'per_invocation'
          AND ${t.origin_app_automation_definition_id} IS NULL
          AND ${t.origin_app_automation_fire_id} IS NULL
          AND ${t.initiating_actor_type} <> 'automation'
          AND ${t.initiating_actor_type} <> 'app_public'
          AND ${t.execution_actor_type} <> 'automation'
        ) OR (
          ${t.review_scope} = 'approved_automation_definition'
          AND ${t.origin_app_automation_definition_id} IS NOT NULL
          AND ${t.origin_app_automation_fire_id} IS NOT NULL
          AND ${t.initiating_actor_type} = 'human'
          AND ${t.execution_actor_type} = 'automation'
          AND ${t.execution_actor_id} = ${t.origin_app_automation_definition_id}
        )
      )
    ) OR (
      ${t.origin_kind} = 'app'
      AND ${t.provider_kind} = 'app_runtime'
      AND ${t.origin_app_installation_id} IS NOT NULL
      AND ${t.origin_app_version_id} IS NOT NULL
      AND ${t.origin_app_grant_snapshot_id} IS NOT NULL
      AND ${t.origin_app_binding_key} IS NULL
      AND ${t.origin_runtime_binding_id} IS NOT NULL
      AND ${t.origin_resource_binding_id} IS NULL
      AND ${t.origin_app_automation_definition_id} IS NULL
      AND ${t.origin_app_automation_fire_id} IS NULL
      AND (
        (${t.initiating_actor_type} = 'app_public'
          AND ${t.execution_actor_type} = 'human'
          AND ${t.initiating_actor_id} = ${t.origin_public_ingress_id}
          AND ${t.origin_public_endpoint_id} IS NOT NULL
          AND ${t.origin_public_ingress_id} IS NOT NULL)
        OR (${t.initiating_actor_type} <> 'automation'
          AND ${t.initiating_actor_type} <> 'app_public'
          AND ${t.execution_actor_type} <> 'automation'
          AND ${t.origin_public_endpoint_id} IS NULL
          AND ${t.origin_public_ingress_id} IS NULL)
      )
      AND ${t.review_scope} = 'per_invocation'
    ) OR (
      ${t.origin_kind} = 'app'
      AND ${t.provider_kind} = 'app_runtime'
      AND ${t.origin_app_installation_id} IS NOT NULL
      AND ${t.origin_app_version_id} IS NOT NULL
      AND ${t.origin_app_grant_snapshot_id} IS NOT NULL
      AND ${t.origin_resource_binding_id} IS NOT NULL
      AND ${t.origin_runtime_binding_id} IS NULL
      AND ${t.origin_app_binding_key} IS NULL
      AND ${t.origin_public_endpoint_id} IS NULL
      AND ${t.origin_public_ingress_id} IS NULL
      AND ${t.origin_app_automation_definition_id} IS NULL
      AND ${t.origin_app_automation_fire_id} IS NULL
      AND ${t.initiating_actor_type} = 'system'
      AND ${t.execution_actor_type} = 'system'
      AND ${t.initiating_actor_id} = ${t.origin_resource_binding_id}
      AND ${t.execution_actor_id} = ${t.origin_resource_binding_id}
      AND ${t.risk_class} = 'internal_write'
      AND ${t.review_requirement} = 'policy'
      AND ${t.review_scope} = 'reviewed_resource_sync'
      AND ${t.retry_class} = 'unsafe_or_unknown'
      AND ${t.retention_class} = 'standard'
    ) OR (
      ${t.origin_kind} <> 'app'
      AND ${t.provider_kind} = 'mcp'
      AND ${t.origin_app_installation_id} IS NULL
      AND ${t.origin_app_version_id} IS NULL
      AND ${t.origin_app_binding_key} IS NULL
      AND ${t.origin_runtime_binding_id} IS NULL
      AND ${t.origin_resource_binding_id} IS NULL
      AND ${t.origin_app_grant_snapshot_id} IS NULL
      AND ${t.origin_app_automation_definition_id} IS NULL
      AND ${t.origin_app_automation_fire_id} IS NULL
      AND ${t.origin_public_endpoint_id} IS NULL
      AND ${t.origin_public_ingress_id} IS NULL
      AND ${t.initiating_actor_type} <> 'automation'
      AND ${t.initiating_actor_type} <> 'app_public'
      AND ${t.execution_actor_type} <> 'automation'
    ))) OR (
      ${t.origin_kind} = 'app' AND ${t.provider_kind} = 'native'
      AND ${t.origin_app_installation_id} IS NOT NULL AND ${t.origin_app_version_id} IS NOT NULL
      AND ${t.origin_app_grant_snapshot_id} IS NOT NULL AND ${t.origin_native_binding_id} IS NOT NULL
      AND ${t.origin_app_binding_key} IS NULL AND ${t.origin_runtime_binding_id} IS NULL AND ${t.origin_resource_binding_id} IS NULL
      AND ${t.origin_app_automation_definition_id} IS NULL AND ${t.origin_app_automation_fire_id} IS NULL
      AND ${t.execution_actor_type} = 'human' AND ${t.review_scope} = 'per_invocation'
      AND ${t.risk_class} = 'internal_write' AND ${t.review_requirement} = 'always'
      AND ${t.retry_class} = 'idempotent_with_key' AND ${t.retention_class} = 'standard'
      AND ((${t.initiating_actor_type} = 'human' AND ${t.initiating_actor_id} = ${t.execution_actor_id}
        AND ${t.origin_public_endpoint_id} IS NULL AND ${t.origin_public_ingress_id} IS NULL)
        OR (${t.initiating_actor_type} = 'app_public' AND ${t.initiating_actor_id} = ${t.origin_public_ingress_id}
          AND ${t.origin_public_endpoint_id} IS NOT NULL AND ${t.origin_public_ingress_id} IS NOT NULL))
    )
  `),
  check('app_runs_app_binding_key_check', sql`
    ${t.origin_app_binding_key} IS NULL OR (
      ${t.origin_app_binding_key} ~ '^[a-z][a-z0-9_]{0,47}$'
      AND ${t.origin_app_binding_key} !~ '^(deft|core|system)(_|$)'
    )
  `),
  check('app_runs_actor_type_check', sql`
    ${t.initiating_actor_type} IN ('human', 'agent_employee', 'system', 'automation', 'app_public')
    AND ${t.execution_actor_type} IN ('human', 'agent_employee', 'system', 'automation')
  `),
  check('app_runs_provider_kind_check', sql`${t.provider_kind} IN ('mcp', 'app_runtime', 'native')`),
  check('app_runs_state_check', sql`${t.state} IN (
    'pending', 'pending_approval', 'running', 'waiting_external', 'succeeded',
    'failed', 'cancelled', 'expired', 'unknown_outcome'
  )`),
  check('app_runs_risk_check', sql`${t.risk_class} IN ('read', 'internal_write', 'external_write', 'destructive', 'privileged')`),
  check('app_runs_review_requirement_check', sql`${t.review_requirement} IN ('policy', 'always')`),
  check('app_runs_review_scope_check', sql`${t.review_scope} IN ('per_invocation', 'immutable_batch', 'approved_automation_definition', 'forbidden_in_automation', 'reviewed_resource_sync')`),
  check('app_runs_retry_class_check', sql`${t.retry_class} IN ('safe', 'idempotent_with_key', 'unsafe_or_unknown')`),
  check('app_runs_retention_class_check', sql`${t.retention_class} IN ('ephemeral', 'standard', 'extended')`),
  check('app_runs_fingerprint_check', sql`
    ${t.idempotency_fingerprint} ~ '^hmac-sha256:[a-f0-9]{64}$'
    AND ${t.input_fingerprint} ~ '^hmac-sha256:[a-f0-9]{64}$'
  `),
  check('app_runs_key_version_check', sql`
    ${t.idempotency_key_version} ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    AND ${t.input_fingerprint_key_version} ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  `),
  check('app_runs_json_check', sql`
    jsonb_typeof(${t.authorization_snapshot}) = 'object'
    AND jsonb_typeof(${t.safe_preview}) = 'object'
    AND (${t.safe_outcome} IS NULL OR jsonb_typeof(${t.safe_outcome}) = 'object')
  `),
  check('app_runs_json_size_check', sql`
    octet_length(${t.authorization_snapshot}::text) <= 65536
    AND octet_length(${t.safe_preview}::text) <= 16384
    AND (${t.safe_outcome} IS NULL OR octet_length(${t.safe_outcome}::text) <= 32768)
  `),
  check('app_runs_ancestry_check', sql`
    ${t.depth} >= 0 AND ${t.depth} <= 8
    AND (
      (${t.depth} = 0 AND ${t.parent_run_id} IS NULL AND ${t.root_run_id} = ${t.id})
      OR (${t.depth} > 0 AND ${t.parent_run_id} IS NOT NULL)
    )
  `),
  check('app_runs_expiry_check', sql`${t.result_expires_at} >= ${t.input_expires_at}`),
  check('app_runs_idempotency_expiry_check', sql`${t.idempotency_expires_at} >= ${t.result_expires_at}`),
  check('app_runs_attempt_limit_check', sql`${t.attempt_limit} BETWEEN 1 AND 10`),
  check('app_runs_execution_release_shape_check', sql`
    (${t.execution_release_kind} IS NULL AND ${t.execution_released_at} IS NULL)
    OR (
      ${t.execution_release_kind} IS NOT NULL
      AND ${t.execution_released_at} IS NOT NULL
      AND (
        (
          ${t.review_requirement} = 'always'
          AND ${t.review_scope} = 'per_invocation'
          AND ${t.execution_release_kind} = 'approved'
        )
        OR (
          ${t.review_requirement} = 'always'
          AND ${t.review_scope} = 'approved_automation_definition'
          AND ${t.execution_release_kind} = 'approved_automation_definition'
        )
        OR (${t.review_requirement} = 'policy' AND ${t.execution_release_kind} IN ('policy_satisfied', 'approved'))
      )
    )
  `),
  check('app_runs_budget_reservation_shape_check', sql`
    (${t.budget_reserved_at} IS NULL AND ${t.budget_reserved_count} IS NULL AND ${t.budget_limit_at_reservation} IS NULL)
    OR (
      ${t.budget_reserved_at} IS NOT NULL
      AND ${t.budget_reserved_count} BETWEEN 1 AND 1000000
      AND ${t.budget_limit_at_reservation} >= ${t.budget_reserved_count}
    )
  `),
  check('app_runs_cancel_request_check', sql`${t.cancel_requested_at} IS NULL OR ${t.started_at} IS NOT NULL`),
]);

export const appRunAttempts = pgTable('app_run_attempts', {
  ...id(),
  ...orgId(),
  run_id: text('run_id').notNull(),
  attempt_number: integer('attempt_number').notNull(),
  retry_of_attempt_id: text('retry_of_attempt_id'),
  state: text('state').$type<
    'pending' | 'claimed' | 'provider_call_started' | 'succeeded' | 'failed' | 'cancelled' | 'unknown_outcome'
  >().default('pending').notNull(),
  claim_owner: text('claim_owner'),
  claim_token: text('claim_token'),
  claimed_at: timestamp('claimed_at'),
  lease_expires_at: timestamp('lease_expires_at'),
  provider_call_started_at: timestamp('provider_call_started_at'),
  provider_call_finished_at: timestamp('provider_call_finished_at'),
  provider_idempotency_key_version: text('provider_idempotency_key_version'),
  provider_idempotency_fingerprint: text('provider_idempotency_fingerprint'),
  runtime_binding_id: text('runtime_binding_id'),
  resource_binding_id: text('resource_binding_id'),
  runtime_session_id: text('runtime_session_id'),
  runtime_session_epoch: integer('runtime_session_epoch'),
  runtime_epoch: integer('runtime_epoch'),
  runtime_sequence: integer('runtime_sequence'),
  runtime_result_hmac: text('runtime_result_hmac'),
  safe_outcome: jsonb('safe_outcome').$type<Record<string, unknown> | null>(),
  error_code: text('error_code'),
  ...timestamps(),
}, (t) => [
  foreignKey({
    columns: [t.org_id, t.run_id],
    foreignColumns: [appRuns.org_id, appRuns.id],
    name: 'app_run_attempts_org_run_fk',
  }).onDelete('cascade'),
  foreignKey({
    columns: [t.org_id, t.runtime_binding_id, t.runtime_session_id,
      t.runtime_session_epoch, t.runtime_epoch],
    foreignColumns: [appRuntimeSessions.org_id, appRuntimeSessions.runtime_binding_id,
      appRuntimeSessions.id, appRuntimeSessions.session_epoch,
      appRuntimeSessions.runtime_epoch],
    name: 'app_run_attempts_runtime_session_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.org_id, t.resource_binding_id, t.runtime_session_id,
      t.runtime_session_epoch, t.runtime_epoch],
    foreignColumns: [appRuntimeSessions.org_id, appRuntimeSessions.resource_binding_id,
      appRuntimeSessions.id, appRuntimeSessions.session_epoch,
      appRuntimeSessions.runtime_epoch],
    name: 'app_run_attempts_resource_session_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.org_id, t.run_id, t.resource_binding_id],
    foreignColumns: [appRuns.org_id, appRuns.id, appRuns.origin_resource_binding_id],
    name: 'app_run_attempts_resource_run_fk',
  }).onDelete('restrict'),
  unique('app_run_attempts_org_run_id_unique').on(t.org_id, t.run_id, t.id),
  uniqueIndex('app_run_attempts_number_unique').on(t.org_id, t.run_id, t.attempt_number),
  uniqueIndex('app_run_attempts_one_active_unique')
    .on(t.org_id, t.run_id)
    .where(sql`${t.state} IN ('pending', 'claimed', 'provider_call_started')`),
  index('app_run_attempts_lease_idx').on(t.state, t.lease_expires_at),
  check('app_run_attempts_number_check', sql`${t.attempt_number} >= 1`),
  check('app_run_attempts_retry_shape_check', sql`
    (${t.attempt_number} = 1 AND ${t.retry_of_attempt_id} IS NULL)
    OR (${t.attempt_number} > 1 AND ${t.retry_of_attempt_id} IS NOT NULL)
  `),
  check('app_run_attempts_state_check', sql`${t.state} IN ('pending', 'claimed', 'provider_call_started', 'succeeded', 'failed', 'cancelled', 'unknown_outcome')`),
  check('app_run_attempts_claim_shape_check', sql`
    (${t.claim_owner} IS NULL AND ${t.claim_token} IS NULL AND ${t.claimed_at} IS NULL AND ${t.lease_expires_at} IS NULL)
    OR (${t.claim_owner} IS NOT NULL AND ${t.claim_token} IS NOT NULL AND ${t.claimed_at} IS NOT NULL AND ${t.lease_expires_at} IS NOT NULL)
  `),
  check('app_run_attempts_provider_call_time_check', sql`
    ${t.provider_call_finished_at} IS NULL
    OR (${t.provider_call_started_at} IS NOT NULL AND ${t.provider_call_finished_at} >= ${t.provider_call_started_at})
  `),
  check('app_run_attempts_idempotency_shape_check', sql`
    (${t.provider_idempotency_key_version} IS NULL AND ${t.provider_idempotency_fingerprint} IS NULL)
    OR (
      ${t.provider_idempotency_key_version} ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
      AND ${t.provider_idempotency_fingerprint} ~ '^hmac-sha256:[a-f0-9]{64}$'
    )
  `),
  check('app_run_attempts_safe_outcome_check', sql`
    ${t.safe_outcome} IS NULL
    OR (jsonb_typeof(${t.safe_outcome}) = 'object' AND octet_length(${t.safe_outcome}::text) <= 32768)
  `),
  check('app_run_attempts_runtime_shape_check', sql`
    (${t.runtime_binding_id} IS NULL AND ${t.resource_binding_id} IS NULL
      AND ${t.runtime_session_id} IS NULL
      AND ${t.runtime_session_epoch} IS NULL AND ${t.runtime_epoch} IS NULL
      AND ${t.runtime_sequence} IS NULL AND ${t.runtime_result_hmac} IS NULL)
    OR (${t.runtime_binding_id} IS NOT NULL AND ${t.resource_binding_id} IS NULL
      AND ${t.runtime_session_id} IS NOT NULL
      AND ${t.runtime_session_epoch} IS NOT NULL AND ${t.runtime_session_epoch} >= 0
      AND ${t.runtime_epoch} IS NOT NULL AND ${t.runtime_epoch} >= 0
      AND ${t.runtime_sequence} IS NOT NULL AND ${t.runtime_sequence} >= 1)
    OR (${t.runtime_binding_id} IS NULL AND ${t.resource_binding_id} IS NOT NULL
      AND ${t.runtime_session_id} IS NOT NULL
      AND ${t.runtime_session_epoch} IS NOT NULL AND ${t.runtime_session_epoch} >= 0
      AND ${t.runtime_epoch} IS NOT NULL AND ${t.runtime_epoch} >= 0
      AND ${t.runtime_sequence} IS NOT NULL AND ${t.runtime_sequence} >= 1)
  `),
]);

export const appRunSecretPayloads = pgTable('app_run_secret_payloads', {
  ...id(),
  ...orgId(),
  run_id: text('run_id').notNull(),
  attempt_id: text('attempt_id'),
  payload_kind: text('payload_kind').$type<'input' | 'output'>().notNull(),
  envelope_version: text('envelope_version').notNull(),
  algorithm: text('algorithm').$type<'aes-256-gcm'>().notNull(),
  key_version: text('key_version').notNull(),
  nonce_b64: text('nonce_b64').notNull(),
  ciphertext_b64: text('ciphertext_b64').notNull(),
  auth_tag_b64: text('auth_tag_b64').notNull(),
  payload_bytes: integer('payload_bytes').notNull(),
  expires_at: timestamp('expires_at').notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  foreignKey({
    columns: [t.org_id, t.run_id],
    foreignColumns: [appRuns.org_id, appRuns.id],
    name: 'app_run_secret_payloads_org_run_fk',
  }).onDelete('cascade'),
  foreignKey({
    columns: [t.org_id, t.run_id, t.attempt_id],
    foreignColumns: [appRunAttempts.org_id, appRunAttempts.run_id, appRunAttempts.id],
    name: 'app_run_secret_payloads_org_attempt_fk',
  }).onDelete('cascade'),
  uniqueIndex('app_run_secret_payloads_input_unique')
    .on(t.org_id, t.run_id, t.payload_kind)
    .where(sql`${t.payload_kind} = 'input'`),
  uniqueIndex('app_run_secret_payloads_output_unique')
    .on(t.org_id, t.attempt_id, t.payload_kind)
    .where(sql`${t.payload_kind} = 'output'`),
  index('app_run_secret_payloads_expiry_idx').on(t.expires_at),
  check('app_run_secret_payloads_kind_shape_check', sql`
    (${t.payload_kind} = 'input' AND ${t.attempt_id} IS NULL AND ${t.payload_bytes} BETWEEN 1 AND 262144)
    OR (${t.payload_kind} = 'output' AND ${t.attempt_id} IS NOT NULL AND ${t.payload_bytes} BETWEEN 1 AND 1048576)
  `),
  check('app_run_secret_payloads_envelope_check', sql`
    ${t.envelope_version} = 'deft.secret.v1'
    AND ${t.algorithm} = 'aes-256-gcm'
    AND ${t.key_version} ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    AND ${t.nonce_b64} ~ '^[A-Za-z0-9+/]{16}$'
    AND ${t.auth_tag_b64} ~ '^[A-Za-z0-9+/]{22}==$'
    AND ${t.ciphertext_b64} ~ '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$'
  `),
  check('app_run_secret_payloads_size_check', sql`
    octet_length(decode(${t.ciphertext_b64}, 'base64')) = ${t.payload_bytes}
  `),
]);

export const appRunEvents = pgTable('app_run_events', {
  ...id(),
  ...orgId(),
  run_id: text('run_id').notNull(),
  event_version: text('event_version').$type<'deft.app_run_event.v1'>()
    .default('deft.app_run_event.v1').notNull(),
  sequence: integer('sequence').notNull(),
  event_type: text('event_type').notNull(),
  actor_type: text('actor_type'),
  actor_id: text('actor_id'),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  foreignKey({
    columns: [t.org_id, t.run_id],
    foreignColumns: [appRuns.org_id, appRuns.id],
    name: 'app_run_events_org_run_fk',
  }).onDelete('cascade'),
  uniqueIndex('app_run_events_sequence_unique').on(t.org_id, t.run_id, t.sequence),
  index('app_run_events_run_idx').on(t.org_id, t.run_id, t.created_at),
  check('app_run_events_sequence_check', sql`${t.sequence} >= 1`),
  check('app_run_events_version_check', sql`${t.event_version} = 'deft.app_run_event.v1'`),
  check('app_run_events_type_check', sql`${t.event_type} IN (
    'run_created', 'approval_requested', 'approval_resolved', 'attempt_created',
    'attempt_claimed', 'provider_call_started', 'cancellation_requested', 'attempt_terminal', 'run_transitioned',
    'secrets_purged', 'reconciliation_recorded', 'repair_gap'
  )`),
  check('app_run_events_actor_shape_check', sql`
    (${t.actor_type} IS NULL AND ${t.actor_id} IS NULL)
    OR (${t.actor_type} IN ('human', 'agent_employee', 'system', 'automation', 'app_public') AND ${t.actor_id} IS NOT NULL)
  `),
  check('app_run_events_payload_check', sql`jsonb_typeof(${t.payload}) = 'object' AND octet_length(${t.payload}::text) <= 32768`),
]);

export const appRunReceipts = pgTable('app_run_receipts', {
  ...id(),
  ...orgId(),
  run_id: text('run_id').notNull(),
  attempt_id: text('attempt_id'),
  receipt_version: text('receipt_version').$type<'deft.app_run_receipt.v1'>()
    .default('deft.app_run_receipt.v1').notNull(),
  receipt_key: text('receipt_key').notNull(),
  receipt_kind: text('receipt_kind').$type<'approval' | 'attempt_terminal' | 'reconciliation' | 'repair'>().notNull(),
  envelope: jsonb('envelope').$type<Record<string, unknown>>().notNull(),
  envelope_digest: text('envelope_digest').notNull(),
  signing_key_version: text('signing_key_version').notNull(),
  signature_hmac: text('signature_hmac').notNull(),
  signed_at: timestamp('signed_at').defaultNow().notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  foreignKey({
    columns: [t.org_id, t.run_id],
    foreignColumns: [appRuns.org_id, appRuns.id],
    name: 'app_run_receipts_org_run_fk',
  }).onDelete('cascade'),
  foreignKey({
    columns: [t.org_id, t.run_id, t.attempt_id],
    foreignColumns: [appRunAttempts.org_id, appRunAttempts.run_id, appRunAttempts.id],
    name: 'app_run_receipts_org_attempt_fk',
  }).onDelete('cascade'),
  uniqueIndex('app_run_receipts_key_unique').on(t.org_id, t.run_id, t.receipt_key),
  index('app_run_receipts_run_idx').on(t.org_id, t.run_id, t.signed_at),
  check('app_run_receipts_kind_check', sql`${t.receipt_kind} IN ('approval', 'attempt_terminal', 'reconciliation', 'repair')`),
  check('app_run_receipts_version_check', sql`${t.receipt_version} = 'deft.app_run_receipt.v1'`),
  check('app_run_receipts_envelope_check', sql`jsonb_typeof(${t.envelope}) = 'object' AND octet_length(${t.envelope}::text) <= 32768`),
  check('app_run_receipts_digest_check', sql`${t.envelope_digest} ~ '^sha256:[a-f0-9]{64}$'`),
  check('app_run_receipts_signature_check', sql`${t.signature_hmac} ~ '^hmac-sha256:[a-f0-9]{64}$'`),
  check('app_run_receipts_key_version_check', sql`${t.signing_key_version} ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'`),
]);

// ═══ AGENT: ACTIONS LOG ═══
// Note: agent_conversations and agent_messages were dropped in migration 0065
// (Phase 2 agent-chat unification). Conversation IDs are now space IDs in the
// spaces table; messages live in the unified messages table.
export const agentActions = pgTable('agent_actions', {
  ...id(),
  ...orgId(),
  user_id: text('user_id').notNull().references(() => users.id),
  conversation_id: text('conversation_id'), // now a space_id (FK dropped in 0065)
  message_id: text('message_id'),
  agent_employee_id: text('agent_employee_id'),
  tool_use_id: text('tool_use_id'), // Anthropic tool_use block id (toolu_*)
  source: text('source').default('native'),
  // Nullable compatibility link only. Governed Run submission owns the one
  // app_run_invoke row; the action is never the execution source of truth.
  app_run_id: text('app_run_id'),
  mcp_connection_id: text('mcp_connection_id'),
  plan_id: text('plan_id'),
  plan_step_id: text('plan_step_id'),
  channel_event_id: text('channel_event_id'),
  runtime_request_key: text('runtime_request_key'),
  action: text('action').notNull(), // 'create_task', 'update_task_status', 'post_message', etc.
  params: jsonb('params').notNull(),
  result: jsonb('result'),
  approval_tier: approvalTierEnum('approval_tier').notNull(),
  approval_status: approvalStatusEnum('approval_status').default('pending').notNull(),
  approved_at: timestamp('approved_at'),
  approved_by_user_id: text('approved_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  executed_at: timestamp('executed_at'),
  error: text('error'),
  before_state: jsonb('before_state'),
  after_state: jsonb('after_state'),
  undone_at: timestamp('undone_at'),
  ...timestamps(),
}, (t) => [
  foreignKey({
    columns: [t.org_id, t.app_run_id],
    foreignColumns: [appRuns.org_id, appRuns.id],
    name: 'agent_actions_org_app_run_fk',
  }).onDelete('restrict'),
  index('agent_action_org_idx').on(t.org_id),
  index('agent_action_user_idx').on(t.user_id),
  index('agent_action_runtime_request_idx').on(t.org_id, t.agent_employee_id, t.runtime_request_key),
  uniqueIndex('agent_action_app_run_unique')
    .on(t.org_id, t.app_run_id)
    .where(sql`${t.app_run_id} IS NOT NULL`),
  check('agent_actions_app_run_shape_check', sql`
    (${t.app_run_id} IS NULL AND ${t.action} <> 'app_run_invoke')
    OR (
      ${t.app_run_id} IS NOT NULL
      AND ${t.action} = 'app_run_invoke'
      AND jsonb_typeof(${t.params}) = 'object'
      AND ${t.params} ? 'run_id'
      AND jsonb_typeof(${t.params}->'run_id') = 'string'
      AND ${t.params}->>'run_id' = ${t.app_run_id}
      AND (${t.params} - ARRAY['run_id', 'capability_label', 'provider_label', 'resource_ids', 'safe_preview']::text[]) = '{}'::jsonb
      AND octet_length(${t.params}::text) <= 32768
    )
  `),
]);

// ═══ ATTENTION + DELIVERY ═══
// Durable user-facing attention is separate from legacy notifications. A
// single item may absorb many source events while retaining a complete event
// ledger and independent delivery attempts.
export const attentionItems = pgTable('attention_items', {
  ...id(),
  ...orgId(),
  user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  lane: text('lane').notNull(),
  priority: text('priority').default('normal').notNull(),
  state: text('state').default('open_unseen').notNull(),
  dedupe_key: text('dedupe_key').notNull(),
  source_type: text('source_type').notNull(),
  source_id: text('source_id').notNull(),
  source_event_id: text('source_event_id'),
  title: text('title').notNull(),
  body: text('body'),
  link: text('link'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  due_at: timestamp('due_at'),
  urgent_at: timestamp('urgent_at'),
  last_event_at: timestamp('last_event_at').defaultNow().notNull(),
  event_count: integer('event_count').default(1).notNull(),
  version: integer('version').default(1).notNull(),
  seen_at: timestamp('seen_at'),
  acknowledged_at: timestamp('acknowledged_at'),
  snoozed_until: timestamp('snoozed_until'),
  resolved_at: timestamp('resolved_at'),
  resolution: text('resolution'),
  ...timestamps(),
}, (t) => [
  uniqueIndex('attention_item_user_dedupe_unique').on(t.org_id, t.user_id, t.dedupe_key),
  index('attention_item_user_state_idx').on(t.org_id, t.user_id, t.state, t.last_event_at),
  index('attention_item_user_lane_idx').on(t.org_id, t.user_id, t.lane, t.last_event_at),
  index('attention_item_source_idx').on(t.org_id, t.source_type, t.source_id),
]);

export const attentionEvents = pgTable('attention_events', {
  ...id(),
  ...orgId(),
  attention_item_id: text('attention_item_id').notNull().references(() => attentionItems.id, { onDelete: 'cascade' }),
  user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  event_type: text('event_type').notNull(),
  source_event_id: text('source_event_id').notNull(),
  actor_user_id: text('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  index('attention_event_item_idx').on(t.attention_item_id, t.created_at),
  index('attention_event_user_idx').on(t.org_id, t.user_id, t.created_at),
  uniqueIndex('attention_event_source_unique').on(t.org_id, t.user_id, t.source_event_id, t.event_type),
]);

export const attentionDeliveries = pgTable('attention_deliveries', {
  ...id(),
  ...orgId(),
  attention_item_id: text('attention_item_id').notNull().references(() => attentionItems.id, { onDelete: 'cascade' }),
  user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  channel: text('channel').notNull(),
  status: text('status').default('queued').notNull(),
  delivery_version: integer('delivery_version').default(1).notNull(),
  attempt_count: integer('attempt_count').default(0).notNull(),
  provider_message_id: text('provider_message_id'),
  last_error: text('last_error'),
  next_attempt_at: timestamp('next_attempt_at'),
  sent_at: timestamp('sent_at'),
  delivered_at: timestamp('delivered_at'),
  ...timestamps(),
}, (t) => [
  uniqueIndex('attention_delivery_version_unique').on(t.attention_item_id, t.channel, t.delivery_version),
  index('attention_delivery_queue_idx').on(t.status, t.next_attempt_at),
  index('attention_delivery_user_idx').on(t.org_id, t.user_id, t.created_at),
]);

export const webPushSubscriptions = pgTable('web_push_subscriptions', {
  ...id(),
  ...orgId(),
  user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  endpoint: text('endpoint').notNull(),
  endpoint_hash: text('endpoint_hash').notNull(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  device_name: text('device_name'),
  user_agent: text('user_agent'),
  is_active: boolean('is_active').default(true).notNull(),
  failure_count: integer('failure_count').default(0).notNull(),
  last_used_at: timestamp('last_used_at'),
  ...timestamps(),
}, (t) => [
  uniqueIndex('web_push_subscription_endpoint_hash_unique').on(t.endpoint_hash),
  index('web_push_subscription_user_idx').on(t.org_id, t.user_id, t.is_active),
]);

export const agentActionApprovers = pgTable('agent_action_approvers', {
  ...id(),
  ...orgId(),
  action_id: text('action_id').notNull().references(() => agentActions.id, { onDelete: 'cascade' }),
  user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  decision: text('decision').default('pending').notNull(),
  decided_at: timestamp('decided_at'),
  ...timestamps(),
}, (t) => [
  uniqueIndex('agent_action_approver_unique').on(t.action_id, t.user_id),
  index('agent_action_approver_user_idx').on(t.org_id, t.user_id, t.decision),
]);

// ═══ WORK INTENTS ═══
// Canonical ledger for "Defty noticed possible work" events. Existing
// agent_actions rows remain the approval/execution surface; work_intents
// carry the source evidence and lifecycle so chat classification does not
// silently become task creation.
export const workIntents = pgTable('work_intents', {
  ...id(),
  org_id: text('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  space_id: text('space_id').references(() => spaces.id, { onDelete: 'set null' }),
  source_message_id: text('source_message_id').references(() => messages.id, { onDelete: 'set null' }),
  source_user_id: text('source_user_id').references(() => users.id, { onDelete: 'set null' }),
  agent_employee_id: text('agent_employee_id').references(() => agentEmployees.id, { onDelete: 'set null' }),
  kind: workIntentKindEnum('kind').notNull(),
  status: workIntentStatusEnum('status').default('proposed').notNull(),
  title: text('title').notNull(),
  summary: text('summary'),
  confidence: real('confidence'),
  proposed_action: text('proposed_action').default('task_create').notNull(),
  proposed_params: jsonb('proposed_params').$type<Record<string, unknown>>().notNull().default({}),
  dedupe_key: text('dedupe_key').notNull(),
  converted_action_id: text('converted_action_id'),
  converted_task_id: text('converted_task_id').references(() => tasks.id, { onDelete: 'set null' }),
  converted_by: text('converted_by').references(() => users.id, { onDelete: 'set null' }),
  converted_at: timestamp('converted_at'),
  dismissed_by: text('dismissed_by').references(() => users.id, { onDelete: 'set null' }),
  dismissed_at: timestamp('dismissed_at'),
  failure_reason: text('failure_reason'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  ...timestamps(),
}, (t) => [
  uniqueIndex('work_intent_dedupe_unique').on(t.org_id, t.dedupe_key),
  index('work_intent_org_status_idx').on(t.org_id, t.status, t.created_at),
  index('work_intent_source_message_idx').on(t.source_message_id),
  index('work_intent_space_idx').on(t.space_id),
  index('work_intent_converted_task_idx').on(t.converted_task_id),
]);

// Durable ledger for Defty's chat observation pipeline. A row here means a
// chat message was seen by the observation system even when it is ignored.
export const messageObservations = pgTable('message_observations', {
  ...id(),
  org_id: text('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  message_id: text('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
  space_id: text('space_id').references(() => spaces.id, { onDelete: 'set null' }),
  user_id: text('user_id').references(() => users.id, { onDelete: 'set null' }),
  observation_version: integer('observation_version').default(1).notNull(),
  status: messageObservationStatusEnum('status').default('queued').notNull(),
  ignored_reason: text('ignored_reason'),
  classifier_result: jsonb('classifier_result').$type<Record<string, unknown>>(),
  downstream_jobs: jsonb('downstream_jobs').$type<Array<Record<string, unknown>>>().notNull().default([]),
  capture_count: integer('capture_count').default(0).notNull(),
  last_error: text('last_error'),
  started_at: timestamp('started_at'),
  completed_at: timestamp('completed_at'),
  ...timestamps(),
}, (t) => [
  uniqueIndex('message_observation_message_version_unique').on(t.message_id, t.observation_version),
  index('message_observation_org_status_idx').on(t.org_id, t.status, t.created_at),
  index('message_observation_message_idx').on(t.message_id),
  index('message_observation_space_idx').on(t.space_id),
]);

// ═══ AGENT: SKILLS ═══
// Phase 4 — Unified skill primitive. A skill is a named bundle that can be
// attached to an agent (tools, capability packs, trigger subs, prompt adds)
// and/or a project (status vocab, priority vocab, board view, templates).
// `source` distinguishes bundled (first-party, org_id NULL), marketplace
// (third-party, org_id NULL), and org (custom per-tenant). See
// `apps/api/src/lib/skill-config.ts` for the jsonb shapes.
export const skills = pgTable('skills', {
  ...id(),
  // org_id is nullable: bundled + marketplace skills are cross-tenant.
  org_id: text('org_id'),
  name: text('name').notNull(),
  description: text('description'),
  slug: text('slug').notNull(), // /slug to invoke
  // `system_prompt` + `param_schema` retained for back-compat with pre-Phase-4
  // rows. Canonical home for both is now `agent_config` (see skill-config.ts).
  system_prompt: text('system_prompt'),
  param_schema: jsonb('param_schema'),
  source: text('source').$type<'bundled' | 'marketplace' | 'org'>().default('org').notNull(),
  version: text('version').default('1.0.0').notNull(),
  icon: text('icon'),
  agent_config: jsonb('agent_config').default({}).notNull(),
  source_url: text('source_url'),
  is_deleted: boolean('is_deleted').default(false).notNull(),
  default_agent_employee_id: text('default_agent_employee_id'),
  created_by: text('created_by').references(() => users.id),
  usage_count: integer('usage_count').default(0).notNull(),
  ...timestamps(),
}, (t) => [
  // Unique (source, org_id, slug) — partial on is_deleted=false. The raw SQL
  // migration uses COALESCE(org_id,'') so NULL orgs collide correctly; the
  // Drizzle introspector can't express that, so we keep the declarative
  // unique index simple and rely on the SQL file for production truth.
  uniqueIndex('skills_source_org_slug_idx').on(t.source, t.org_id, t.slug),
  index('skills_source_idx').on(t.source),
  index('skills_org_idx').on(t.org_id),
]);

// ═══ TASK TEMPLATES ═══
// First-class catalog. Not nested in skills. Bundled rows live cross-tenant
// (org_id NULL); org rows have a real org_id. Instantiated into a project
// via POST /api/projects/:id/apply-template.
export const taskTemplates = pgTable('task_templates', {
  ...id(),
  org_id: text('org_id'),
  name: text('name').notNull(),
  description: text('description'),
  icon: text('icon'),
  slug: text('slug').notNull(),
  source: text('source').$type<'bundled' | 'marketplace' | 'org'>().default('org').notNull(),
  version: text('version').default('1.0.0').notNull(),
  tasks: jsonb('tasks').notNull(),
  created_by: text('created_by').references(() => users.id),
  is_deleted: boolean('is_deleted').default(false).notNull(),
  usage_count: integer('usage_count').default(0).notNull(),
  ...timestamps(),
}, (t) => [
  uniqueIndex('task_templates_source_org_slug_idx').on(t.source, t.org_id, t.slug),
  index('task_templates_org_idx').on(t.org_id),
  index('task_templates_source_idx').on(t.source),
]);

// ═══ MODULES ═══
// Declarative workspace modules are intentionally separate from agent skills.
// An installation is the stable tenant-local identity, versions are immutable
// manifest artifacts underneath it, and records retain the version that last
// validated their data. Composite foreign keys make cross-tenant and
// cross-installation references impossible even when callers pass valid IDs.
export const moduleInstallations = pgTable('module_installations', {
  ...id(),
  org_id: text('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  module_id: text('module_id').notNull(),
  slug: text('slug').notNull(),
  source: text('source').$type<'bundled' | 'sideloaded' | 'registry'>().notNull(),
  is_enabled: boolean('is_enabled').default(true).notNull(),
  disabled_at: timestamp('disabled_at'),
  // Manifests never grant agent access. An org admin chooses this installation
  // policy independently; the service still applies principal trust/approval.
  agent_access: text('agent_access').$type<'none' | 'read' | 'write'>().default('none').notNull(),
  installed_by_user_id: text('installed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  installed_by_actor_type: text('installed_by_actor_type').notNull(),
  installed_by_actor_id: text('installed_by_actor_id').notNull(),
  updated_by_actor_type: text('updated_by_actor_type').notNull(),
  updated_by_actor_id: text('updated_by_actor_id').notNull(),
  is_deleted: boolean('is_deleted').default(false).notNull(),
  deleted_at: timestamp('deleted_at'),
  deleted_by_actor_type: text('deleted_by_actor_type'),
  deleted_by_actor_id: text('deleted_by_actor_id'),
  ...timestamps(),
}, (t) => [
  unique('module_installations_org_id_id_unique').on(t.org_id, t.id),
  uniqueIndex('module_installations_org_module_id_unique').on(t.org_id, t.module_id),
  uniqueIndex('module_installations_org_slug_unique').on(t.org_id, t.slug),
  index('module_installations_org_visibility_idx').on(t.org_id, t.is_enabled, t.is_deleted),
  check('module_installations_module_id_not_empty', sql`length(btrim(${t.module_id})) > 0`),
  check('module_installations_slug_not_empty', sql`length(btrim(${t.slug})) > 0`),
  check('module_installations_source_check', sql`${t.source} IN ('bundled', 'sideloaded', 'registry')`),
  check('module_installations_agent_access_check', sql`${t.agent_access} IN ('none', 'read', 'write')`),
  check(
    'module_installations_enabled_state_check',
    sql`(${t.is_enabled} AND ${t.disabled_at} IS NULL) OR (NOT ${t.is_enabled} AND ${t.disabled_at} IS NOT NULL)`,
  ),
  check(
    'module_installations_deleted_state_check',
    sql`(
      NOT ${t.is_deleted}
      AND ${t.deleted_at} IS NULL
      AND ${t.deleted_by_actor_type} IS NULL
      AND ${t.deleted_by_actor_id} IS NULL
    ) OR (
      ${t.is_deleted}
      AND ${t.deleted_at} IS NOT NULL
      AND ${t.deleted_by_actor_type} IS NOT NULL
      AND ${t.deleted_by_actor_id} IS NOT NULL
    )`,
  ),
]);

export const moduleVersions = pgTable('module_versions', {
  ...id(),
  ...orgId(),
  installation_id: text('installation_id').notNull(),
  version: text('version').notNull(),
  manifest: jsonb('manifest').$type<Record<string, unknown>>().notNull(),
  manifest_digest: text('manifest_digest').notNull(),
  is_active: boolean('is_active').default(false).notNull(),
  activated_at: timestamp('activated_at'),
  created_by_actor_type: text('created_by_actor_type').notNull(),
  created_by_actor_id: text('created_by_actor_id').notNull(),
  ...timestamps(),
}, (t) => [
  foreignKey({
    columns: [t.org_id, t.installation_id],
    foreignColumns: [moduleInstallations.org_id, moduleInstallations.id],
    name: 'module_versions_org_installation_fk',
  }).onDelete('restrict'),
  unique('module_versions_org_installation_id_unique').on(t.org_id, t.installation_id, t.id),
  uniqueIndex('module_versions_org_installation_version_unique').on(t.org_id, t.installation_id, t.version),
  uniqueIndex('module_versions_one_active_unique')
    .on(t.org_id, t.installation_id)
    .where(sql`${t.is_active} = true`),
  index('module_versions_installation_digest_idx').on(t.org_id, t.installation_id, t.manifest_digest),
  check(
    'module_versions_version_semver_check',
    sql`${t.version} ~ '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\\+[0-9A-Za-z.-]+)?$'`,
  ),
  check('module_versions_manifest_object_check', sql`jsonb_typeof(${t.manifest}) = 'object'`),
  check(
    'module_versions_manifest_digest_sha256_check',
    sql`${t.manifest_digest} ~ '^sha256:[a-f0-9]{64}$'`,
  ),
  check(
    'module_versions_active_state_check',
    sql`(NOT ${t.is_active}) OR ${t.activated_at} IS NOT NULL`,
  ),
]);

// ═══ APPS (DECLARATIVE AND CONNECTED APP PROTOCOLS) ═══
// Apps are tenant-local lifecycle owners for exact immutable Module versions.
// Protocol v1 may persist requested authority, but effective grants, execution,
// secrets, public ingress, automation, sync, and entitlement state remain gated.
export const appInstallations = pgTable('app_installations', {
  ...id(),
  org_id: text('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  app_id: text('app_id').notNull(),
  lineage_key: text('lineage_key').notNull(),
  lineage_authority_type: text('lineage_authority_type').$type<'local_user'>().notNull(),
  lineage_authority_id: text('lineage_authority_id').notNull(),
  source: text('source').$type<'local'>().default('local').notNull(),
  state: text('state').$type<'staged' | 'active' | 'disabled' | 'failed'>().default('staged').notNull(),
  active_version_id: text('active_version_id'),
  active_grant_snapshot_id: text('active_grant_snapshot_id'),
  active_grant_snapshot_kind: text('active_grant_snapshot_kind').$type<'effective'>(),
  lifecycle_epoch: integer('lifecycle_epoch').default(0).notNull(),
  grant_epoch: integer('grant_epoch').default(0).notNull(),
  installed_by_user_id: text('installed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  installed_by_actor_type: text('installed_by_actor_type').notNull(),
  installed_by_actor_id: text('installed_by_actor_id').notNull(),
  updated_by_actor_type: text('updated_by_actor_type').notNull(),
  updated_by_actor_id: text('updated_by_actor_id').notNull(),
  disabled_at: timestamp('disabled_at'),
  ...timestamps(),
}, (t) => [
  unique('app_installations_org_id_id_unique').on(t.org_id, t.id),
  unique('app_installations_org_id_app_id_unique').on(t.org_id, t.id, t.app_id),
  uniqueIndex('app_installations_org_app_id_unique').on(t.org_id, t.app_id),
  uniqueIndex('app_installations_org_lineage_unique').on(t.org_id, t.lineage_key),
  index('app_installations_org_state_idx').on(t.org_id, t.state),
  check('app_installations_source_check', sql`${t.source} = 'local'`),
  check('app_installations_lineage_authority_check', sql`${t.lineage_authority_type} = 'local_user'`),
  check('app_installations_state_check', sql`${t.state} IN ('staged', 'active', 'disabled', 'failed')`),
  check('app_installations_epoch_nonnegative_check', sql`${t.lifecycle_epoch} >= 0`),
  check('app_installations_grant_epoch_nonnegative_check', sql`${t.grant_epoch} >= 0`),
  check('app_installations_grant_pointer_shape_check', sql`
    (${t.active_grant_snapshot_id} IS NULL AND ${t.active_grant_snapshot_kind} IS NULL)
    OR (${t.active_grant_snapshot_id} IS NOT NULL AND ${t.active_grant_snapshot_kind} = 'effective')
  `),
  check(
    'app_installations_active_pointer_check',
    sql`(${t.state} = 'staged' AND ${t.active_version_id} IS NULL AND ${t.disabled_at} IS NULL)
      OR (${t.state} = 'active' AND ${t.active_version_id} IS NOT NULL AND ${t.disabled_at} IS NULL)
      OR (${t.state} = 'disabled' AND ${t.active_version_id} IS NOT NULL AND ${t.disabled_at} IS NOT NULL)
      OR (${t.state} = 'failed' AND ${t.active_version_id} IS NULL)`,
  ),
]);

export const appVersions = pgTable('app_versions', {
  ...id(),
  ...orgId(),
  installation_id: text('installation_id').notNull(),
  version: text('version').notNull(),
  protocol_version: text('protocol_version').notNull(),
  manifest: jsonb('manifest').$type<Record<string, unknown>>().notNull(),
  manifest_digest: text('manifest_digest').notNull(),
  package_digest: text('package_digest').notNull(),
  package: jsonb('package').$type<Record<string, unknown>>().notNull(),
  // Nullable preserves pre-.23 Protocol v0 rows. New v0/v1/v2 staging writes
  // an immutable compatibility/request projection; connected protocols require
  // the pointer.
  requested_grant_snapshot_id: text('requested_grant_snapshot_id'),
  provenance: jsonb('provenance').$type<Record<string, unknown> | null>(),
  state: text('state').$type<'staged' | 'active' | 'superseded' | 'failed'>().default('staged').notNull(),
  staged_at: timestamp('staged_at').defaultNow().notNull(),
  activated_at: timestamp('activated_at'),
  failed_at: timestamp('failed_at'),
  superseded_at: timestamp('superseded_at'),
  created_by_actor_type: text('created_by_actor_type').notNull(),
  created_by_actor_id: text('created_by_actor_id').notNull(),
  ...timestamps(),
}, (t) => [
  foreignKey({
    columns: [t.org_id, t.installation_id],
    foreignColumns: [appInstallations.org_id, appInstallations.id],
    name: 'app_versions_org_installation_fk',
  }).onDelete('restrict'),
  unique('app_versions_org_installation_id_unique').on(t.org_id, t.installation_id, t.id),
  unique('app_versions_org_installation_identity_unique')
    .on(t.org_id, t.installation_id, t.id, t.version, t.manifest_digest, t.package_digest),
  uniqueIndex('app_versions_org_installation_version_unique').on(t.org_id, t.installation_id, t.version),
  uniqueIndex('app_versions_package_digest_unique').on(t.org_id, t.installation_id, t.package_digest),
  uniqueIndex('app_versions_one_active_unique')
    .on(t.org_id, t.installation_id)
    .where(sql`${t.state} = 'active'`),
  check('app_versions_protocol_supported_check', sql`${t.protocol_version} IN ('0', '1', '2', '3', '4', '5', '6', '7')`),
  check('app_versions_connected_request_check', sql`
    ${t.protocol_version} = '0' OR ${t.requested_grant_snapshot_id} IS NOT NULL
  `),
  check('app_versions_state_check', sql`${t.state} IN ('staged', 'active', 'superseded', 'failed')`),
  check('app_versions_manifest_object_check', sql`jsonb_typeof(${t.manifest}) = 'object'`),
  check('app_versions_package_object_check', sql`jsonb_typeof(${t.package}) = 'object'`),
  check('app_versions_manifest_digest_check', sql`${t.manifest_digest} ~ '^sha256:[a-f0-9]{64}$'`),
  check('app_versions_package_digest_check', sql`${t.package_digest} ~ '^sha256:[a-f0-9]{64}$'`),
  check(
    'app_versions_lifecycle_check',
    sql`(${t.state} = 'staged' AND ${t.activated_at} IS NULL AND ${t.failed_at} IS NULL AND ${t.superseded_at} IS NULL)
      OR (${t.state} = 'active' AND ${t.activated_at} IS NOT NULL AND ${t.failed_at} IS NULL AND ${t.superseded_at} IS NULL)
      OR (${t.state} = 'superseded' AND ${t.activated_at} IS NOT NULL AND ${t.failed_at} IS NULL AND ${t.superseded_at} IS NOT NULL)
      OR (${t.state} = 'failed' AND ${t.activated_at} IS NULL AND ${t.failed_at} IS NOT NULL AND ${t.superseded_at} IS NULL)`,
  ),
]);

export const appModuleBindings = pgTable('app_module_bindings', {
  ...id(),
  ...orgId(),
  app_installation_id: text('app_installation_id').notNull(),
  app_version_id: text('app_version_id').notNull(),
  module_installation_id: text('module_installation_id').notNull(),
  module_version_id: text('module_version_id').notNull(),
  module_id: text('module_id').notNull(),
  ownership: text('ownership').$type<'app'>().default('app').notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  foreignKey({
    columns: [t.org_id, t.app_installation_id],
    foreignColumns: [appInstallations.org_id, appInstallations.id],
    name: 'app_module_bindings_app_installation_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.org_id, t.app_installation_id, t.app_version_id],
    foreignColumns: [appVersions.org_id, appVersions.installation_id, appVersions.id],
    name: 'app_module_bindings_app_version_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.org_id, t.module_installation_id],
    foreignColumns: [moduleInstallations.org_id, moduleInstallations.id],
    name: 'app_module_bindings_module_installation_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.org_id, t.module_installation_id, t.module_version_id],
    foreignColumns: [moduleVersions.org_id, moduleVersions.installation_id, moduleVersions.id],
    name: 'app_module_bindings_module_version_fk',
  }).onDelete('restrict'),
  uniqueIndex('app_module_bindings_app_module_unique').on(t.org_id, t.app_version_id, t.module_id),
  index('app_module_bindings_owner_idx').on(t.org_id, t.module_installation_id, t.app_installation_id),
  check('app_module_bindings_ownership_check', sql`${t.ownership} = 'app'`),
]);

// Immutable requested/effective authority snapshots. Staging writes only a
// requested row. Effective rows, dependency locks, provider bindings, and the
// active pointer remain absent until explicit review in the next lifecycle loop.
export const appGrantSnapshots = pgTable('app_grant_snapshots', {
  ...id(),
  ...orgId(),
  app_installation_id: text('app_installation_id').notNull(),
  app_version_id: text('app_version_id').notNull(),
  app_id: text('app_id').notNull(),
  app_version: text('app_version').notNull(),
  manifest_digest: text('manifest_digest').notNull(),
  package_digest: text('package_digest').notNull(),
  snapshot_kind: text('snapshot_kind').$type<'requested' | 'effective'>().notNull(),
  snapshot_version: text('snapshot_version').$type<'deft.app_grant_snapshot.v1'>().notNull(),
  requested_snapshot_id: text('requested_snapshot_id'),
  supersedes_snapshot_id: text('supersedes_snapshot_id'),
  resource_rights: jsonb('resource_rights').$type<unknown[]>().notNull(),
  classification: jsonb('classification').$type<Record<string, unknown>>().notNull(),
  canonical_snapshot: jsonb('canonical_snapshot').$type<Record<string, unknown>>().notNull(),
  snapshot_digest: text('snapshot_digest').notNull(),
  reviewed_by_actor_type: text('reviewed_by_actor_type'),
  // The upgrade trigger verifies this human is an active owner/admin in org_id
  // at insert time. It remains an immutable historical actor snapshot rather
  // than an FK that would prevent a former reviewer from leaving the workspace.
  reviewed_by_actor_id: text('reviewed_by_actor_id'),
  reviewed_at: timestamp('reviewed_at'),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  foreignKey({
    columns: [t.org_id, t.app_installation_id, t.app_id],
    foreignColumns: [appInstallations.org_id, appInstallations.id, appInstallations.app_id],
    name: 'app_grant_snapshots_app_installation_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [
      t.org_id,
      t.app_installation_id,
      t.app_version_id,
      t.app_version,
      t.manifest_digest,
      t.package_digest,
    ],
    foreignColumns: [
      appVersions.org_id,
      appVersions.installation_id,
      appVersions.id,
      appVersions.version,
      appVersions.manifest_digest,
      appVersions.package_digest,
    ],
    name: 'app_grant_snapshots_app_version_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.org_id, t.app_installation_id, t.app_version_id, t.requested_snapshot_id],
    foreignColumns: [t.org_id, t.app_installation_id, t.app_version_id, t.id],
    name: 'app_grant_snapshots_requested_snapshot_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.org_id, t.app_installation_id, t.supersedes_snapshot_id],
    foreignColumns: [t.org_id, t.app_installation_id, t.id],
    name: 'app_grant_snapshots_supersedes_snapshot_fk',
  }).onDelete('restrict'),
  unique('app_grant_snapshots_org_installation_id_unique')
    .on(t.org_id, t.app_installation_id, t.id),
  unique('app_grant_snapshots_org_version_id_unique')
    .on(t.org_id, t.app_installation_id, t.app_version_id, t.id),
  unique('app_grant_snapshots_org_version_kind_id_unique')
    .on(t.org_id, t.app_installation_id, t.app_version_id, t.id, t.snapshot_kind),
  uniqueIndex('app_grant_snapshots_one_requested_unique')
    .on(t.org_id, t.app_version_id)
    .where(sql`${t.snapshot_kind} = 'requested'`),
  uniqueIndex('app_grant_snapshots_one_successor_unique')
    .on(t.org_id, t.app_installation_id, t.supersedes_snapshot_id)
    .where(sql`${t.supersedes_snapshot_id} IS NOT NULL`),
  uniqueIndex('app_grant_snapshots_one_root_unique')
    .on(t.org_id, t.app_installation_id)
    .where(sql`${t.snapshot_kind} = 'effective' AND ${t.supersedes_snapshot_id} IS NULL`),
  index('app_grant_snapshots_app_version_idx')
    .on(t.org_id, t.app_installation_id, t.app_version_id, t.created_at),
  check('app_grant_snapshots_kind_check', sql`${t.snapshot_kind} IN ('requested', 'effective')`),
  check('app_grant_snapshots_version_check', sql`${t.snapshot_version} = 'deft.app_grant_snapshot.v1'`),
  check('app_grant_snapshots_app_id_check', sql`
    ${t.app_id} ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*(\\.[a-z][a-z0-9]*(-[a-z0-9]+)*)+$'
  `),
  check('app_grant_snapshots_digest_check', sql`
    ${t.manifest_digest} ~ '^sha256:[a-f0-9]{64}$'
    AND ${t.package_digest} ~ '^sha256:[a-f0-9]{64}$'
    AND ${t.snapshot_digest} ~ '^sha256:[a-f0-9]{64}$'
  `),
  check('app_grant_snapshots_json_check', sql`
    jsonb_typeof(${t.resource_rights}) = 'array'
    AND jsonb_typeof(${t.classification}) = 'object'
    AND jsonb_typeof(${t.canonical_snapshot}) = 'object'
  `),
  check('app_grant_snapshots_json_size_check', sql`
    octet_length(${t.resource_rights}::text) <= 65536
    AND octet_length(${t.classification}::text) <= 32768
    AND octet_length(${t.canonical_snapshot}::text) <= 262144
  `),
  check('app_grant_snapshots_review_shape_check', sql`
    (
      ${t.snapshot_kind} = 'requested'
      AND ${t.requested_snapshot_id} IS NULL
      AND ${t.supersedes_snapshot_id} IS NULL
      AND ${t.reviewed_by_actor_type} IS NULL
      AND ${t.reviewed_by_actor_id} IS NULL
      AND ${t.reviewed_at} IS NULL
    ) OR (
      ${t.snapshot_kind} = 'effective'
      AND ${t.requested_snapshot_id} IS NOT NULL
      AND ${t.reviewed_by_actor_type} = 'human'
      AND ${t.reviewed_by_actor_id} IS NOT NULL
      AND ${t.reviewed_at} IS NOT NULL
    )
  `),
  check('app_grant_snapshots_supersedes_self_check', sql`
    ${t.supersedes_snapshot_id} IS NULL OR ${t.supersedes_snapshot_id} <> ${t.id}
  `),
]);

export const appDependencyLocks = pgTable('app_dependency_locks', {
  ...id(),
  ...orgId(),
  app_installation_id: text('app_installation_id').notNull(),
  app_version_id: text('app_version_id').notNull(),
  grant_snapshot_id: text('grant_snapshot_id').notNull(),
  grant_snapshot_kind: text('grant_snapshot_kind').$type<'effective'>().default('effective').notNull(),
  dependency_key: text('dependency_key').notNull(),
  required_app_id: text('required_app_id').notNull(),
  required_version: text('required_version').notNull(),
  dependency_installation_id: text('dependency_installation_id').notNull(),
  dependency_version_id: text('dependency_version_id').notNull(),
  dependency_manifest_digest: text('dependency_manifest_digest').notNull(),
  dependency_package_digest: text('dependency_package_digest').notNull(),
  dependency_lifecycle_epoch: integer('dependency_lifecycle_epoch').notNull(),
  ownership: text('ownership').$type<'preexisting'>().notNull(),
  canonical_lock: jsonb('canonical_lock').$type<Record<string, unknown>>().notNull(),
  lock_digest: text('lock_digest').notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  foreignKey({
    columns: [t.org_id, t.app_installation_id, t.app_version_id],
    foreignColumns: [appVersions.org_id, appVersions.installation_id, appVersions.id],
    name: 'app_dependency_locks_app_version_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [
      t.org_id,
      t.app_installation_id,
      t.app_version_id,
      t.grant_snapshot_id,
      t.grant_snapshot_kind,
    ],
    foreignColumns: [
      appGrantSnapshots.org_id,
      appGrantSnapshots.app_installation_id,
      appGrantSnapshots.app_version_id,
      appGrantSnapshots.id,
      appGrantSnapshots.snapshot_kind,
    ],
    name: 'app_dependency_locks_grant_snapshot_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.org_id, t.dependency_installation_id, t.required_app_id],
    foreignColumns: [appInstallations.org_id, appInstallations.id, appInstallations.app_id],
    name: 'app_dependency_locks_dependency_app_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [
      t.org_id,
      t.dependency_installation_id,
      t.dependency_version_id,
      t.required_version,
      t.dependency_manifest_digest,
      t.dependency_package_digest,
    ],
    foreignColumns: [
      appVersions.org_id,
      appVersions.installation_id,
      appVersions.id,
      appVersions.version,
      appVersions.manifest_digest,
      appVersions.package_digest,
    ],
    name: 'app_dependency_locks_dependency_version_fk',
  }).onDelete('restrict'),
  uniqueIndex('app_dependency_locks_grant_key_unique')
    .on(t.org_id, t.grant_snapshot_id, t.dependency_key),
  uniqueIndex('app_dependency_locks_grant_installation_unique')
    .on(t.org_id, t.grant_snapshot_id, t.dependency_installation_id),
  index('app_dependency_locks_dependency_idx')
    .on(t.org_id, t.dependency_installation_id, t.dependency_version_id),
  check('app_dependency_locks_key_check', sql`
    ${t.dependency_key} ~ '^[a-z][a-z0-9_]{0,47}$'
    AND ${t.dependency_key} !~ '^(deft|core|system)(_|$)'
  `),
  check('app_dependency_locks_app_id_check', sql`
    ${t.required_app_id} ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*(\\.[a-z][a-z0-9]*(-[a-z0-9]+)*)+$'
  `),
  check('app_dependency_locks_self_check', sql`${t.dependency_installation_id} <> ${t.app_installation_id}`),
  check('app_dependency_locks_epoch_check', sql`${t.dependency_lifecycle_epoch} >= 0`),
  check('app_dependency_locks_ownership_check', sql`
    ${t.ownership} = 'preexisting'
  `),
  check('app_dependency_locks_grant_kind_check', sql`${t.grant_snapshot_kind} = 'effective'`),
  check('app_dependency_locks_digest_check', sql`
    ${t.dependency_manifest_digest} ~ '^sha256:[a-f0-9]{64}$'
    AND ${t.dependency_package_digest} ~ '^sha256:[a-f0-9]{64}$'
    AND ${t.lock_digest} ~ '^sha256:[a-f0-9]{64}$'
  `),
  check('app_dependency_locks_json_check', sql`
    jsonb_typeof(${t.canonical_lock}) = 'object'
    AND octet_length(${t.canonical_lock}::text) <= 65536
  `),
]);

export const appActionBindings = pgTable('app_action_bindings', {
  ...id(),
  ...orgId(),
  app_installation_id: text('app_installation_id').notNull(),
  app_version_id: text('app_version_id').notNull(),
  grant_snapshot_id: text('grant_snapshot_id').notNull(),
  grant_snapshot_kind: text('grant_snapshot_kind').$type<'effective'>().default('effective').notNull(),
  action_key: text('action_key').notNull(),
  capability_requirement_key: text('capability_requirement_key').notNull(),
  connector_requirement_key: text('connector_requirement_key').notNull(),
  interface_identity: text('interface_identity').notNull(),
  provider_kind: text('provider_kind').$type<'mcp'>().notNull(),
  mcp_connection_id: text('mcp_connection_id').notNull(),
  provider_snapshot_id: text('provider_snapshot_id').notNull(),
  operation_name: text('operation_name').notNull(),
  operation_schema_digest: text('operation_schema_digest').notNull(),
  connector_authorization_version: integer('connector_authorization_version').notNull(),
  risk_class: text('risk_class').$type<'external_write'>().notNull(),
  review_requirement: text('review_requirement').$type<'always'>().notNull(),
  review_scope: text('review_scope').$type<'per_invocation'>().notNull(),
  egress_class: text('egress_class').$type<'email'>().notNull(),
  retry_class: text('retry_class').$type<'idempotent_with_key'>().notNull(),
  retention_class: text('retention_class').$type<'standard'>().notNull(),
  automation_eligibility: text('automation_eligibility').$type<'forbidden'>().notNull(),
  provider_idempotency_key_required: boolean('provider_idempotency_key_required').notNull(),
  canonical_binding: jsonb('canonical_binding').$type<Record<string, unknown>>().notNull(),
  binding_digest: text('binding_digest').notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  foreignKey({
    columns: [t.org_id, t.app_installation_id, t.app_version_id],
    foreignColumns: [appVersions.org_id, appVersions.installation_id, appVersions.id],
    name: 'app_action_bindings_app_version_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [
      t.org_id,
      t.app_installation_id,
      t.app_version_id,
      t.grant_snapshot_id,
      t.grant_snapshot_kind,
    ],
    foreignColumns: [
      appGrantSnapshots.org_id,
      appGrantSnapshots.app_installation_id,
      appGrantSnapshots.app_version_id,
      appGrantSnapshots.id,
      appGrantSnapshots.snapshot_kind,
    ],
    name: 'app_action_bindings_grant_snapshot_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.org_id, t.mcp_connection_id],
    foreignColumns: [mcpConnections.org_id, mcpConnections.id],
    name: 'app_action_bindings_mcp_connection_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.org_id, t.provider_kind, t.mcp_connection_id, t.provider_snapshot_id],
    foreignColumns: [
      capabilityProviderSnapshots.org_id,
      capabilityProviderSnapshots.provider_kind,
      capabilityProviderSnapshots.provider_instance_id,
      capabilityProviderSnapshots.id,
    ],
    name: 'app_action_bindings_provider_snapshot_fk',
  }).onDelete('restrict'),
  unique('app_action_bindings_grant_action_unique')
    .on(t.org_id, t.grant_snapshot_id, t.action_key),
  unique('app_action_bindings_automation_identity_unique').on(
    t.org_id,
    t.app_installation_id,
    t.app_version_id,
    t.grant_snapshot_id,
    t.action_key,
    t.id,
  ),
  unique('app_action_bindings_run_identity_unique').on(
    t.org_id,
    t.app_installation_id,
    t.app_version_id,
    t.grant_snapshot_id,
    t.action_key,
    t.provider_kind,
    t.mcp_connection_id,
    t.operation_name,
    t.provider_snapshot_id,
  ),
  index('app_action_bindings_provider_idx')
    .on(t.org_id, t.mcp_connection_id, t.provider_snapshot_id),
  check('app_action_bindings_key_check', sql`
    ${t.action_key} ~ '^[a-z][a-z0-9_]{0,47}$'
    AND ${t.capability_requirement_key} ~ '^[a-z][a-z0-9_]{0,47}$'
    AND ${t.connector_requirement_key} ~ '^[a-z][a-z0-9_]{0,47}$'
    AND ${t.action_key} !~ '^(deft|core|system)(_|$)'
    AND ${t.capability_requirement_key} !~ '^(deft|core|system)(_|$)'
    AND ${t.connector_requirement_key} !~ '^(deft|core|system)(_|$)'
  `),
  check('app_action_bindings_interface_check', sql`
    ${t.interface_identity} =
      'deft.private.v1:' || lower(${t.org_id}) || ':' || lower(${t.app_installation_id}) ||
      ':sandbox_email_send:v1'
  `),
  check('app_action_bindings_provider_check', sql`${t.provider_kind} = 'mcp'`),
  check('app_action_bindings_grant_kind_check', sql`${t.grant_snapshot_kind} = 'effective'`),
  check('app_action_bindings_policy_check', sql`
    ${t.risk_class} = 'external_write'
    AND ${t.review_requirement} = 'always'
    AND ${t.review_scope} = 'per_invocation'
    AND ${t.egress_class} = 'email'
    AND ${t.retry_class} = 'idempotent_with_key'
    AND ${t.retention_class} = 'standard'
    AND ${t.automation_eligibility} = 'forbidden'
    AND ${t.provider_idempotency_key_required} = true
    AND ${t.connector_authorization_version} >= 1
  `),
  check('app_action_bindings_operation_check', sql`
    octet_length(${t.operation_name}) BETWEEN 1 AND 512
    AND ${t.operation_name} !~ '[[:cntrl:]]'
  `),
  check('app_action_bindings_digest_check', sql`
    ${t.operation_schema_digest} ~ '^sha256:[a-f0-9]{64}$'
    AND ${t.binding_digest} ~ '^sha256:[a-f0-9]{64}$'
  `),
  check('app_action_bindings_json_check', sql`
    jsonb_typeof(${t.canonical_binding}) = 'object'
    AND octet_length(${t.canonical_binding}::text) <= 65536
  `),
]);

// Reviewed runtime ownership is separate from released App Kit v0-v2 actions.
// Registrations and bindings are dormant until a host-reviewed contract is
// explicitly activated. These rows are not another Run or scheduling ledger.
export const appRuntimeRegistrations = pgTable('app_runtime_registrations', {
  ...id(),
  ...orgId(),
  app_installation_id: text('app_installation_id').notNull(),
  app_version_id: text('app_version_id').notNull(),
  grant_snapshot_id: text('grant_snapshot_id').notNull(),
  grant_snapshot_kind: text('grant_snapshot_kind').$type<'effective'>().default('effective').notNull(),
  operator_user_id: text('operator_user_id').notNull(),
  contract_version: text('contract_version').notNull(),
  state: text('state').$type<'disabled' | 'active' | 'revoked'>().default('disabled').notNull(),
  runtime_epoch: integer('runtime_epoch').default(0).notNull(),
  reviewed_by_user_id: text('reviewed_by_user_id'),
  reviewed_at: timestamp('reviewed_at'),
  ...timestamps(),
}, (t) => [
  foreignKey({ columns: [t.org_id, t.app_installation_id, t.app_version_id],
    foreignColumns: [appVersions.org_id, appVersions.installation_id, appVersions.id],
    name: 'app_runtime_registrations_version_fk' }).onDelete('restrict'),
  foreignKey({ columns: [t.org_id, t.app_installation_id, t.app_version_id,
    t.grant_snapshot_id, t.grant_snapshot_kind],
    foreignColumns: [appGrantSnapshots.org_id, appGrantSnapshots.app_installation_id,
      appGrantSnapshots.app_version_id, appGrantSnapshots.id, appGrantSnapshots.snapshot_kind],
    name: 'app_runtime_registrations_grant_fk' }).onDelete('restrict'),
  foreignKey({ columns: [t.org_id, t.operator_user_id],
    foreignColumns: [orgMembers.org_id, orgMembers.user_id],
    name: 'app_runtime_registrations_operator_fk' }).onDelete('restrict'),
  unique('app_runtime_registrations_org_id_id_unique').on(t.org_id, t.id),
  unique('app_runtime_registrations_ancestry_unique').on(t.org_id, t.app_installation_id,
    t.app_version_id, t.grant_snapshot_id, t.id),
  unique('app_runtime_registrations_contract_ancestry_unique').on(t.org_id,
    t.app_installation_id, t.app_version_id, t.grant_snapshot_id, t.id, t.contract_version),
  check('app_runtime_registrations_state_check', sql`${t.state} IN ('disabled','active','revoked')`),
  check('app_runtime_registrations_kind_check', sql`${t.grant_snapshot_kind} = 'effective'`),
  check('app_runtime_registrations_contract_check', sql`${t.contract_version} IN ('deft.app_runtime_channel.v1', 'deft.app_runtime_channel.v2', 'deft.app_runtime_channel.v3')`),
  check('app_runtime_registrations_epoch_check', sql`${t.runtime_epoch} >= 0`),
  check('app_runtime_registrations_review_check', sql`
    (${t.state} = 'disabled' AND ${t.reviewed_at} IS NULL AND ${t.reviewed_by_user_id} IS NULL)
    OR (${t.state} <> 'disabled' AND ${t.reviewed_at} IS NOT NULL AND ${t.reviewed_by_user_id} IS NOT NULL)
  `),
]);

export const appRuntimeBindings = pgTable('app_runtime_bindings', {
  ...id(),
  ...orgId(),
  app_installation_id: text('app_installation_id').notNull(),
  app_version_id: text('app_version_id').notNull(),
  grant_snapshot_id: text('grant_snapshot_id').notNull(),
  runtime_registration_id: text('runtime_registration_id').notNull(),
  registration_contract_version: text('registration_contract_version')
    .$type<'deft.app_runtime_channel.v1'>().default('deft.app_runtime_channel.v1').notNull(),
  action_key: text('action_key').notNull(),
  interface_identity: text('interface_identity').notNull(),
  provider_kind: text('provider_kind').$type<'app_runtime'>().default('app_runtime').notNull(),
  provider_instance_id: text('provider_instance_id').notNull(),
  provider_snapshot_id: text('provider_snapshot_id').notNull(),
  operation_name: text('operation_name').notNull(),
  risk_class: text('risk_class').$type<'read' | 'internal_write' | 'external_write' | 'destructive' | 'privileged'>().notNull(),
  review_requirement: text('review_requirement').$type<'policy' | 'always'>().notNull(),
  retry_class: text('retry_class').$type<'safe' | 'idempotent_with_key' | 'unsafe_or_unknown'>().notNull(),
  retention_class: text('retention_class').$type<'ephemeral' | 'standard' | 'extended'>().notNull(),
  state: text('state').$type<'disabled' | 'active' | 'revoked'>().default('disabled').notNull(),
  reviewed_by_user_id: text('reviewed_by_user_id'),
  reviewed_at: timestamp('reviewed_at'),
  ...timestamps(),
}, (t) => [
  foreignKey({ columns: [t.org_id, t.app_installation_id, t.app_version_id,
    t.grant_snapshot_id, t.runtime_registration_id, t.registration_contract_version],
    foreignColumns: [appRuntimeRegistrations.org_id, appRuntimeRegistrations.app_installation_id,
      appRuntimeRegistrations.app_version_id, appRuntimeRegistrations.grant_snapshot_id,
      appRuntimeRegistrations.id, appRuntimeRegistrations.contract_version],
    name: 'app_runtime_bindings_registration_fk' }).onDelete('restrict'),
  foreignKey({ columns: [t.org_id, t.provider_kind, t.provider_instance_id, t.provider_snapshot_id],
    foreignColumns: [capabilityProviderSnapshots.org_id, capabilityProviderSnapshots.provider_kind,
      capabilityProviderSnapshots.provider_instance_id, capabilityProviderSnapshots.id],
    name: 'app_runtime_bindings_provider_fk' }).onDelete('restrict'),
  unique('app_runtime_bindings_org_id_id_unique').on(t.org_id, t.id),
  unique('app_runtime_bindings_run_identity_unique').on(t.org_id, t.app_installation_id,
    t.app_version_id, t.grant_snapshot_id, t.id, t.provider_kind,
    t.provider_instance_id, t.operation_name, t.provider_snapshot_id,
    t.risk_class, t.review_requirement, t.retry_class, t.retention_class),
  unique('app_runtime_bindings_registration_identity_unique').on(t.org_id, t.runtime_registration_id, t.id),
  check('app_runtime_bindings_kind_check', sql`${t.provider_kind} = 'app_runtime'`),
  check('app_runtime_bindings_registration_contract_check', sql`${t.registration_contract_version} = 'deft.app_runtime_channel.v1'`),
  check('app_runtime_bindings_identity_check', sql`
    ${t.provider_instance_id} = ${t.runtime_registration_id}
    AND ${t.action_key} ~ '^[a-z][a-z0-9_]{0,47}$'
    AND ${t.action_key} !~ '^(deft|core|system)(_|$)'
    AND ${t.interface_identity} = 'deft.runtime.v1:' || lower(${t.org_id}) || ':' ||
      lower(${t.app_installation_id}) || ':' || ${t.action_key}
  `),
  check('app_runtime_bindings_state_check', sql`${t.state} IN ('disabled','active','revoked')`),
  check('app_runtime_bindings_review_check', sql`
    (${t.state} = 'disabled' AND ${t.reviewed_at} IS NULL AND ${t.reviewed_by_user_id} IS NULL)
    OR (${t.state} <> 'disabled' AND ${t.reviewed_at} IS NOT NULL AND ${t.reviewed_by_user_id} IS NOT NULL)
  `),
]);

// Host-reviewed resource sync authority is distinct from v1 action bindings.
// Cursor state and provider records live in separate tables below.
export const appNativeBindings = pgTable('app_native_bindings', {
  ...id(), ...orgId(),
  app_installation_id: text('app_installation_id').notNull(), app_version_id: text('app_version_id').notNull(),
  grant_snapshot_id: text('grant_snapshot_id').notNull(),
  grant_snapshot_kind: text('grant_snapshot_kind').$type<'effective'>().default('effective').notNull(),
  action_key: text('action_key').notNull(), operation_name: text('operation_name')
    .$type<'calendar.events.create.v1' | 'calendar.events.cancel.v1'>().notNull(),
  provider_kind: text('provider_kind').$type<'native'>().default('native').notNull(),
  provider_instance_id: text('provider_instance_id').notNull(), provider_snapshot_id: text('provider_snapshot_id').notNull(),
  owner_user_id: text('owner_user_id').notNull(), stage_manager_user_id: text('stage_manager_user_id').notNull(),
  stage_manager_authorization_version: integer('stage_manager_authorization_version').notNull(),
  owner_authorization_version: integer('owner_authorization_version').notNull(),
  installation_lifecycle_epoch: integer('installation_lifecycle_epoch').notNull(),
  installation_grant_epoch: integer('installation_grant_epoch').notNull(),
  package_digest: text('package_digest').notNull(), grant_snapshot_digest: text('grant_snapshot_digest').notNull(),
  target: jsonb('target').$type<Record<string, unknown>>().notNull(),
  proposal_digest: text('proposal_digest').notNull(), consent_digest: text('consent_digest'),
  reviewed_contract_digest: text('reviewed_contract_digest').notNull(),
  risk_class: text('risk_class').$type<'internal_write'>().default('internal_write').notNull(),
  review_requirement: text('review_requirement').$type<'always'>().default('always').notNull(),
  review_scope: text('review_scope').$type<'per_invocation'>().default('per_invocation').notNull(),
  retry_class: text('retry_class').$type<'idempotent_with_key'>().default('idempotent_with_key').notNull(),
  retention_class: text('retention_class').$type<'standard'>().default('standard').notNull(),
  state: text('state').$type<'staged' | 'active' | 'revoked'>().default('staged').notNull(),
  reviewed_at: timestamp('reviewed_at'), ...timestamps(),
}, (t) => [
  foreignKey({ columns: [t.org_id, t.app_installation_id, t.app_version_id, t.grant_snapshot_id, t.grant_snapshot_kind],
    foreignColumns: [appGrantSnapshots.org_id, appGrantSnapshots.app_installation_id, appGrantSnapshots.app_version_id,
      appGrantSnapshots.id, appGrantSnapshots.snapshot_kind], name: 'app_native_bindings_grant_fk' }).onDelete('restrict'),
  foreignKey({ columns: [t.org_id, t.provider_kind, t.provider_instance_id, t.provider_snapshot_id],
    foreignColumns: [capabilityProviderSnapshots.org_id, capabilityProviderSnapshots.provider_kind,
      capabilityProviderSnapshots.provider_instance_id, capabilityProviderSnapshots.id], name: 'app_native_bindings_provider_fk' }).onDelete('restrict'),
  foreignKey({ columns: [t.org_id, t.owner_user_id], foreignColumns: [orgMembers.org_id, orgMembers.user_id],
    name: 'app_native_bindings_owner_fk' }).onDelete('restrict'),
  foreignKey({ columns: [t.org_id, t.stage_manager_user_id], foreignColumns: [orgMembers.org_id, orgMembers.user_id],
    name: 'app_native_bindings_manager_fk' }).onDelete('restrict'),
  unique('app_native_bindings_org_id_id_unique').on(t.org_id, t.id),
  unique('app_native_bindings_owner_identity_unique').on(t.org_id, t.app_installation_id, t.app_version_id,
    t.grant_snapshot_id, t.id, t.owner_user_id),
  unique('app_native_bindings_run_identity_unique').on(t.org_id, t.app_installation_id, t.app_version_id,
    t.grant_snapshot_id, t.id, t.provider_kind, t.provider_instance_id, t.operation_name, t.provider_snapshot_id,
    t.owner_user_id, t.risk_class, t.review_requirement, t.review_scope, t.retry_class, t.retention_class),
  uniqueIndex('app_native_bindings_current_action_unique').on(t.org_id, t.app_installation_id, t.app_version_id,
    t.grant_snapshot_id, t.action_key).where(sql`${t.state} <> 'revoked'`),
  check('app_native_bindings_identity_check', sql`${t.provider_kind} = 'native' AND ${t.grant_snapshot_kind} = 'effective'
    AND ${t.provider_instance_id} = 'calendar:' || ${t.owner_user_id}
    AND ${t.operation_name} IN ('calendar.events.create.v1', 'calendar.events.cancel.v1')
    AND ${t.action_key} ~ '^[a-z][a-z0-9_]{0,47}$' AND ${t.action_key} !~ '^(deft|core|system)(_|$)'`),
  check('app_native_bindings_policy_check', sql`${t.risk_class} = 'internal_write' AND ${t.review_requirement} = 'always'
    AND ${t.review_scope} = 'per_invocation' AND ${t.retry_class} = 'idempotent_with_key' AND ${t.retention_class} = 'standard'`),
  check('app_native_bindings_epoch_check', sql`${t.installation_lifecycle_epoch} >= 0 AND ${t.installation_grant_epoch} >= 1
    AND ${t.stage_manager_authorization_version} >= 1 AND ${t.owner_authorization_version} >= 1`),
  check('app_native_bindings_digest_check', sql`${t.proposal_digest} ~ '^sha256:[a-f0-9]{64}$'
    AND ${t.reviewed_contract_digest} ~ '^sha256:[a-f0-9]{64}$' AND ${t.package_digest} ~ '^sha256:[a-f0-9]{64}$'
    AND ${t.grant_snapshot_digest} ~ '^sha256:[a-f0-9]{64}$'`),
  check('app_native_bindings_state_check', sql`${t.state} IN ('staged', 'active', 'revoked')
    AND ((${t.consent_digest} IS NULL AND ${t.reviewed_at} IS NULL AND ${t.state} <> 'active')
      OR (${t.consent_digest} IS NOT NULL AND ${t.consent_digest} ~ '^sha256:[a-f0-9]{64}$' AND ${t.reviewed_at} IS NOT NULL AND ${t.state} <> 'staged'))`),
  check('app_native_bindings_target_check', sql`jsonb_typeof(${t.target}) = 'object' AND octet_length(${t.target}::text) <= 1024`),
]);

export const appResourceBindings = pgTable('app_resource_bindings', {
  ...id(),
  ...orgId(),
  app_installation_id: text('app_installation_id').notNull(),
  app_version_id: text('app_version_id').notNull(),
  grant_snapshot_id: text('grant_snapshot_id').notNull(),
  grant_snapshot_kind: text('grant_snapshot_kind').$type<'effective'>().default('effective').notNull(),
  runtime_registration_id: text('runtime_registration_id').notNull(),
  registration_contract_version: text('registration_contract_version')
    .$type<'deft.app_runtime_channel.v2' | 'deft.app_runtime_channel.v3'>().default('deft.app_runtime_channel.v2').notNull(),
  provider_kind: text('provider_kind').$type<'app_runtime'>().default('app_runtime').notNull(),
  provider_instance_id: text('provider_instance_id').notNull(),
  provider_snapshot_id: text('provider_snapshot_id').notNull(),
  resource_key: text('resource_key').notNull(),
  resource_family: text('resource_family').notNull(),
  operation_name: text('operation_name').notNull(),
  interface_identity: text('interface_identity').notNull(),
  reviewed_descriptor: jsonb('reviewed_descriptor').$type<Record<string, unknown>>().notNull(),
  descriptor_digest: text('descriptor_digest').notNull(),
  attachment_policy: jsonb('attachment_policy').$type<Record<string, unknown>>(),
  attachment_consent_digest: text('attachment_consent_digest'),
  owner_user_id: text('owner_user_id').notNull(),
  owner_scope: text('owner_scope').$type<'private_user'>().default('private_user').notNull(),
  risk_class: text('risk_class').$type<'internal_write'>().default('internal_write').notNull(),
  review_requirement: text('review_requirement').$type<'policy'>().default('policy').notNull(),
  review_scope: text('review_scope').$type<'reviewed_resource_sync'>().default('reviewed_resource_sync').notNull(),
  retry_class: text('retry_class').$type<'unsafe_or_unknown'>().default('unsafe_or_unknown').notNull(),
  retention_class: text('retention_class').$type<'standard'>().default('standard').notNull(),
  max_records_per_page: integer('max_records_per_page').notNull(),
  max_page_bytes: integer('max_page_bytes').notNull(),
  max_retained_records: integer('max_retained_records').notNull(),
  max_retained_bytes: integer('max_retained_bytes').notNull(),
  min_interval_seconds: integer('min_interval_seconds').notNull(),
  consent_expires_at: timestamp('consent_expires_at'),
  state: text('state').$type<'disabled' | 'active' | 'revoked'>().default('disabled').notNull(),
  reviewed_by_user_id: text('reviewed_by_user_id'),
  reviewed_at: timestamp('reviewed_at'),
  ...timestamps(),
}, (t) => [
  foreignKey({ columns: [t.org_id, t.app_installation_id, t.app_version_id,
    t.grant_snapshot_id, t.grant_snapshot_kind],
    foreignColumns: [appGrantSnapshots.org_id, appGrantSnapshots.app_installation_id,
      appGrantSnapshots.app_version_id, appGrantSnapshots.id, appGrantSnapshots.snapshot_kind],
    name: 'app_resource_bindings_grant_fk' }).onDelete('restrict'),
  foreignKey({ columns: [t.org_id, t.app_installation_id, t.app_version_id,
    t.grant_snapshot_id, t.runtime_registration_id, t.registration_contract_version],
    foreignColumns: [appRuntimeRegistrations.org_id, appRuntimeRegistrations.app_installation_id,
      appRuntimeRegistrations.app_version_id, appRuntimeRegistrations.grant_snapshot_id,
      appRuntimeRegistrations.id, appRuntimeRegistrations.contract_version],
    name: 'app_resource_bindings_registration_fk' }).onDelete('restrict'),
  foreignKey({ columns: [t.org_id, t.provider_kind, t.provider_instance_id, t.provider_snapshot_id],
    foreignColumns: [capabilityProviderSnapshots.org_id, capabilityProviderSnapshots.provider_kind,
      capabilityProviderSnapshots.provider_instance_id, capabilityProviderSnapshots.id],
    name: 'app_resource_bindings_provider_fk' }).onDelete('restrict'),
  foreignKey({ columns: [t.org_id, t.owner_user_id],
    foreignColumns: [orgMembers.org_id, orgMembers.user_id],
    name: 'app_resource_bindings_owner_fk' }).onDelete('restrict'),
  foreignKey({ columns: [t.org_id, t.reviewed_by_user_id],
    foreignColumns: [orgMembers.org_id, orgMembers.user_id],
    name: 'app_resource_bindings_reviewer_fk' }).onDelete('restrict'),
  unique('app_resource_bindings_org_id_id_unique').on(t.org_id, t.id),
  unique('app_resource_bindings_registration_identity_unique').on(t.org_id, t.runtime_registration_id, t.id),
  unique('app_resource_bindings_owner_identity_unique').on(t.org_id, t.id, t.owner_user_id),
  unique('app_resource_bindings_descriptor_identity_unique').on(t.org_id, t.id,
    t.owner_user_id, t.descriptor_digest),
  unique('app_resource_bindings_run_identity_unique').on(t.org_id, t.app_installation_id,
    t.app_version_id, t.grant_snapshot_id, t.id, t.provider_kind,
    t.provider_instance_id, t.operation_name, t.provider_snapshot_id,
    t.risk_class, t.review_requirement, t.review_scope, t.retry_class, t.retention_class),
  index('app_resource_bindings_owner_idx').on(t.org_id, t.owner_user_id, t.state),
  uniqueIndex('app_resource_bindings_one_current_consent_unique')
    .on(t.org_id, t.app_installation_id, t.grant_snapshot_id, t.owner_user_id, t.resource_key)
    .where(sql`${t.state} <> 'revoked'`),
  check('app_resource_bindings_identity_check', sql`
    ${t.grant_snapshot_kind} = 'effective'
    AND ${t.registration_contract_version} IN ('deft.app_runtime_channel.v2', 'deft.app_runtime_channel.v3')
    AND ${t.provider_kind} = 'app_runtime'
    AND ${t.provider_instance_id} = ${t.runtime_registration_id}
    AND ${t.owner_scope} = 'private_user'
    AND ${t.resource_key} ~ '^[a-z][a-z0-9_]{0,47}$'
    AND ${t.resource_family} ~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
    AND octet_length(${t.resource_family}) <= 64
    AND ${t.operation_name} = 'sync_' || ${t.resource_key}
    AND ((${t.registration_contract_version} = 'deft.app_runtime_channel.v2'
      AND ${t.interface_identity} = 'deft.resource_sync.v2:' || lower(${t.org_id}) || ':' || lower(${t.app_installation_id}) || ':' || ${t.resource_key})
      OR (${t.registration_contract_version} = 'deft.app_runtime_channel.v3'
      AND ${t.interface_identity} = 'deft.resource_sync.v3:' || lower(${t.org_id}) || ':' || lower(${t.app_installation_id}) || ':' || ${t.resource_key}))
    AND ${t.descriptor_digest} ~ '^sha256:[a-f0-9]{64}$'
  `),
  check('app_resource_bindings_descriptor_check', sql`
    jsonb_typeof(${t.reviewed_descriptor}) = 'object'
    AND coalesce(jsonb_typeof(${t.reviewed_descriptor}->'schema_version'), '') = 'string'
    AND ((${t.registration_contract_version} = 'deft.app_runtime_channel.v2'
      AND coalesce(${t.reviewed_descriptor}->>'schema_version', '') = 'deft.app_sync_descriptor.v1')
      OR (${t.registration_contract_version} = 'deft.app_runtime_channel.v3'
      AND coalesce(${t.reviewed_descriptor}->>'schema_version', '') = 'deft.app_sync_descriptor.v2'
      AND jsonb_typeof(${t.reviewed_descriptor}->'attachments') = 'object'))
    AND octet_length(${t.reviewed_descriptor}::text) <= 65536
  `),
  check('app_resource_bindings_attachment_policy_check', sql`
    (${t.registration_contract_version} = 'deft.app_runtime_channel.v2'
      AND ${t.attachment_policy} IS NULL AND ${t.attachment_consent_digest} IS NULL)
    OR (${t.registration_contract_version} = 'deft.app_runtime_channel.v3'
      AND ${t.attachment_policy} IS NOT NULL AND ${t.attachment_consent_digest} IS NOT NULL
      AND ${t.attachment_consent_digest} ~ '^sha256:[a-f0-9]{64}$'
      AND coalesce((jsonb_typeof(${t.attachment_policy}) = 'object'
      AND ${t.attachment_policy} ?& ARRAY['max_attachment_bytes','max_attachments_per_record','max_attachments_per_run','max_attachment_bytes_per_run','retention_days','allowed_media_types']
      AND ${t.attachment_policy} - ARRAY['max_attachment_bytes','max_attachments_per_record','max_attachments_per_run','max_attachment_bytes_per_run','retention_days','allowed_media_types'] = '{}'::jsonb
      AND jsonb_typeof(${t.attachment_policy}->'max_attachment_bytes') = 'number'
      AND (${t.attachment_policy}->>'max_attachment_bytes')::numeric BETWEEN 1 AND 2097152
      AND (${t.attachment_policy}->>'max_attachment_bytes')::numeric = trunc((${t.attachment_policy}->>'max_attachment_bytes')::numeric)
      AND (${t.attachment_policy}->>'max_attachment_bytes')::numeric <= ((${t.reviewed_descriptor}->'attachments')->>'max_attachment_bytes')::numeric
      AND jsonb_typeof(${t.attachment_policy}->'max_attachments_per_record') = 'number'
      AND (${t.attachment_policy}->>'max_attachments_per_record')::numeric BETWEEN 1 AND 8
      AND (${t.attachment_policy}->>'max_attachments_per_record')::numeric = trunc((${t.attachment_policy}->>'max_attachments_per_record')::numeric)
      AND (${t.attachment_policy}->>'max_attachments_per_record')::numeric <= ((${t.reviewed_descriptor}->'attachments')->>'max_attachments_per_record')::numeric
      AND jsonb_typeof(${t.attachment_policy}->'max_attachments_per_run') = 'number'
      AND (${t.attachment_policy}->>'max_attachments_per_run')::numeric BETWEEN 1 AND 32
      AND (${t.attachment_policy}->>'max_attachments_per_run')::numeric = trunc((${t.attachment_policy}->>'max_attachments_per_run')::numeric)
      AND (${t.attachment_policy}->>'max_attachments_per_run')::numeric <= ((${t.reviewed_descriptor}->'attachments')->>'max_attachments_per_run')::numeric
      AND jsonb_typeof(${t.attachment_policy}->'max_attachment_bytes_per_run') = 'number'
      AND (${t.attachment_policy}->>'max_attachment_bytes_per_run')::numeric BETWEEN 1 AND 8388608
      AND (${t.attachment_policy}->>'max_attachment_bytes_per_run')::numeric = trunc((${t.attachment_policy}->>'max_attachment_bytes_per_run')::numeric)
      AND (${t.attachment_policy}->>'max_attachment_bytes_per_run')::numeric <= ((${t.reviewed_descriptor}->'attachments')->>'max_attachment_bytes_per_run')::numeric
      AND jsonb_typeof(${t.attachment_policy}->'retention_days') = 'number'
      AND (${t.attachment_policy}->>'retention_days')::numeric BETWEEN 1 AND 30
      AND (${t.attachment_policy}->>'retention_days')::numeric = trunc((${t.attachment_policy}->>'retention_days')::numeric)
      AND (${t.attachment_policy}->>'retention_days')::numeric <= ((${t.reviewed_descriptor}->'attachments')->>'retention_days')::numeric
      AND jsonb_typeof((${t.attachment_policy}->'allowed_media_types')) = 'array'
      AND jsonb_array_length((${t.attachment_policy}->'allowed_media_types')) BETWEEN 1 AND 7
      AND (${t.attachment_policy}->'allowed_media_types') <@ '["text/plain","text/csv","application/json","image/png","image/jpeg","image/gif","image/webp"]'::jsonb
      AND (${t.attachment_policy}->'allowed_media_types') <@ ((${t.reviewed_descriptor}->'attachments')->'allowed_media_types')
      AND jsonb_array_length((${t.attachment_policy}->'allowed_media_types')) = (((${t.attachment_policy}->'allowed_media_types') @> '["text/plain"]'::jsonb)::integer + ((${t.attachment_policy}->'allowed_media_types') @> '["text/csv"]'::jsonb)::integer + ((${t.attachment_policy}->'allowed_media_types') @> '["application/json"]'::jsonb)::integer + ((${t.attachment_policy}->'allowed_media_types') @> '["image/png"]'::jsonb)::integer + ((${t.attachment_policy}->'allowed_media_types') @> '["image/jpeg"]'::jsonb)::integer + ((${t.attachment_policy}->'allowed_media_types') @> '["image/gif"]'::jsonb)::integer + ((${t.attachment_policy}->'allowed_media_types') @> '["image/webp"]'::jsonb)::integer)), false))
  `),
  check('app_resource_bindings_policy_check', sql`
    ${t.risk_class} = 'internal_write' AND ${t.review_requirement} = 'policy'
    AND ${t.review_scope} = 'reviewed_resource_sync'
    AND ${t.retry_class} = 'unsafe_or_unknown' AND ${t.retention_class} = 'standard'
  `),
  check('app_resource_bindings_limits_check', sql`
    ${t.max_records_per_page} BETWEEN 1 AND 100
    AND ${t.max_page_bytes} BETWEEN 1 AND 524288
    AND ${t.max_retained_records} BETWEEN 1 AND 100000
    AND ${t.max_retained_bytes} BETWEEN 1 AND 1073741824
    AND ${t.min_interval_seconds} BETWEEN 60 AND 86400
  `),
  check('app_resource_bindings_review_check', sql`
    (${t.state} = 'disabled' AND ${t.reviewed_by_user_id} IS NULL
      AND ${t.reviewed_at} IS NULL AND ${t.consent_expires_at} IS NULL)
    OR (${t.state} IN ('active','revoked') AND ${t.reviewed_by_user_id} IS NOT NULL
      AND ${t.reviewed_by_user_id} = ${t.owner_user_id}
      AND ${t.reviewed_at} IS NOT NULL AND ${t.consent_expires_at} IS NOT NULL
      AND ${t.consent_expires_at} > ${t.reviewed_at}
      AND ${t.consent_expires_at} <= ${t.reviewed_at} + interval '90 days')
  `),
]);

export const appRuntimeSessions = pgTable('app_runtime_sessions', {
  ...id(),
  ...orgId(),
  runtime_registration_id: text('runtime_registration_id').notNull(),
  runtime_binding_id: text('runtime_binding_id'),
  resource_binding_id: text('resource_binding_id'),
  operator_user_id: text('operator_user_id').notNull(),
  token_hash: text('token_hash').notNull(),
  audience: text('audience').$type<'app_runtime' | 'app_resource_sync'>().default('app_runtime').notNull(),
  session_epoch: integer('session_epoch').default(0).notNull(),
  runtime_epoch: integer('runtime_epoch').notNull(),
  lifecycle_epoch: integer('lifecycle_epoch').notNull(),
  grant_epoch: integer('grant_epoch').notNull(),
  next_sequence: integer('next_sequence').default(1).notNull(),
  expires_at: timestamp('expires_at').notNull(),
  revoked_at: timestamp('revoked_at'),
  ...timestamps(),
}, (t) => [
  foreignKey({ columns: [t.org_id, t.runtime_registration_id, t.runtime_binding_id],
    foreignColumns: [appRuntimeBindings.org_id, appRuntimeBindings.runtime_registration_id,
      appRuntimeBindings.id], name: 'app_runtime_sessions_binding_fk' }).onDelete('restrict'),
  foreignKey({ columns: [t.org_id, t.runtime_registration_id, t.resource_binding_id],
    foreignColumns: [appResourceBindings.org_id, appResourceBindings.runtime_registration_id,
      appResourceBindings.id], name: 'app_runtime_sessions_resource_binding_fk' }).onDelete('restrict'),
  foreignKey({ columns: [t.org_id, t.operator_user_id],
    foreignColumns: [orgMembers.org_id, orgMembers.user_id],
    name: 'app_runtime_sessions_operator_fk' }).onDelete('restrict'),
  unique('app_runtime_sessions_attempt_identity_unique').on(t.org_id, t.runtime_binding_id,
    t.id, t.session_epoch, t.runtime_epoch),
  unique('app_runtime_sessions_resource_attempt_identity_unique').on(t.org_id, t.resource_binding_id,
    t.id, t.session_epoch, t.runtime_epoch),
  unique('app_runtime_sessions_token_hash_unique').on(t.token_hash),
  check('app_runtime_sessions_audience_check', sql`
    (${t.audience} = 'app_runtime' AND ${t.runtime_binding_id} IS NOT NULL
      AND ${t.resource_binding_id} IS NULL)
    OR (${t.audience} = 'app_resource_sync' AND ${t.runtime_binding_id} IS NULL
      AND ${t.resource_binding_id} IS NOT NULL)
  `),
  check('app_runtime_sessions_epoch_check', sql`${t.session_epoch} >= 0 AND ${t.runtime_epoch} >= 0 AND ${t.lifecycle_epoch} >= 0 AND ${t.grant_epoch} >= 0 AND ${t.next_sequence} >= 1`),
  check('app_runtime_sessions_token_check', sql`${t.token_hash} ~ '^sha256:[a-f0-9]{64}$'`),
]);

// ═══ APP AUTOMATION FOUNDATION (DORMANT TRACK A) ═══
// Definitions are host-authored review records, not executable schedules.
// Only their lifecycle state and epoch may change after creation. Fires are a
// durable identity/claim ledger for the later scheduler cutover; this package
// does not enqueue or execute them.
export const appSyncCheckpoints = pgTable('app_sync_checkpoints', {
  ...id(),
  ...orgId(),
  resource_binding_id: text('resource_binding_id').notNull(),
  generation: integer('generation').default(1).notNull(),
  state: text('state').$type<'active' | 'paused'>().default('active').notNull(),
  cursor_sequence: integer('cursor_sequence').default(0).notNull(),
  cursor_hmac_key_version: text('cursor_hmac_key_version').notNull(),
  cursor_hmac: text('cursor_hmac').notNull(),
  cursor_state: text('cursor_state').$type<'empty' | 'value'>().default('empty').notNull(),
  cursor_envelope_version: text('cursor_envelope_version'),
  cursor_algorithm: text('cursor_algorithm'),
  cursor_key_version: text('cursor_key_version'),
  cursor_nonce_b64: text('cursor_nonce_b64'),
  cursor_ciphertext_b64: text('cursor_ciphertext_b64'),
  cursor_auth_tag_b64: text('cursor_auth_tag_b64'),
  cursor_bytes: integer('cursor_bytes').default(0).notNull(),
  retained_record_count: integer('retained_record_count').default(0).notNull(),
  retained_bytes: integer('retained_bytes').default(0).notNull(),
  last_applied_run_id: text('last_applied_run_id'),
  last_applied_page_digest: text('last_applied_page_digest'),
  last_applied_at: timestamp('last_applied_at'),
  last_checked_at: timestamp('last_checked_at'),
  fresh_until: timestamp('fresh_until'),
  ...timestamps(),
}, (t) => [
  foreignKey({ columns: [t.org_id, t.resource_binding_id],
    foreignColumns: [appResourceBindings.org_id, appResourceBindings.id],
    name: 'app_sync_checkpoints_binding_fk' }).onDelete('restrict'),
  // The reverse last-applied-intent FK is installed by preview.37/apply-extras;
  // declaring both directions here creates a Drizzle TypeScript initialization cycle.
  unique('app_sync_checkpoints_org_id_id_unique').on(t.org_id, t.id),
  unique('app_sync_checkpoints_binding_unique').on(t.org_id, t.resource_binding_id),
  unique('app_sync_checkpoints_intent_identity_unique').on(t.org_id, t.id, t.resource_binding_id),
  index('app_sync_checkpoints_freshness_idx').on(t.org_id, t.state, t.fresh_until),
  check('app_sync_checkpoints_state_check', sql`${t.state} IN ('active','paused')`),
  check('app_sync_checkpoints_counters_check', sql`
    ${t.generation} >= 1 AND ${t.cursor_sequence} >= 0
    AND ${t.retained_record_count} BETWEEN 0 AND 100000
    AND ${t.retained_bytes} BETWEEN 0 AND 1073741824
    AND ${t.cursor_bytes} BETWEEN 0 AND 16384
  `),
  check('app_sync_checkpoints_hmac_check', sql`
    ${t.cursor_hmac_key_version} ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    AND ${t.cursor_hmac} ~ '^hmac-sha256:[a-f0-9]{64}$'
  `),
  check('app_sync_checkpoints_cursor_envelope_check', sql`
    (${t.cursor_state} = 'empty' AND ${t.cursor_bytes} = 0
      AND ${t.cursor_envelope_version} IS NULL AND ${t.cursor_algorithm} IS NULL
      AND ${t.cursor_key_version} IS NULL AND ${t.cursor_nonce_b64} IS NULL
      AND ${t.cursor_ciphertext_b64} IS NULL AND ${t.cursor_auth_tag_b64} IS NULL)
    OR (${t.cursor_state} = 'value' AND ${t.cursor_bytes} BETWEEN 1 AND 16384
      AND ${t.cursor_envelope_version} IS NOT NULL AND ${t.cursor_algorithm} IS NOT NULL
      AND ${t.cursor_key_version} IS NOT NULL AND ${t.cursor_nonce_b64} IS NOT NULL
      AND ${t.cursor_ciphertext_b64} IS NOT NULL AND ${t.cursor_auth_tag_b64} IS NOT NULL
      AND ${t.cursor_envelope_version} = 'deft.secret.v1'
      AND ${t.cursor_algorithm} = 'aes-256-gcm'
      AND ${t.cursor_key_version} ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
      AND ${t.cursor_nonce_b64} ~ '^[A-Za-z0-9+/]{16}$'
      AND ${t.cursor_auth_tag_b64} ~ '^[A-Za-z0-9+/]{22}==$'
      AND ${t.cursor_ciphertext_b64} ~ '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$'
      AND octet_length(decode(${t.cursor_ciphertext_b64}, 'base64')) = ${t.cursor_bytes})
  `),
  check('app_sync_checkpoints_application_check', sql`
    (${t.cursor_sequence} = 0 AND ${t.last_applied_run_id} IS NULL
      AND ${t.last_applied_page_digest} IS NULL AND ${t.last_applied_at} IS NULL)
    OR (${t.cursor_sequence} > 0 AND ${t.last_applied_run_id} IS NOT NULL
      AND ${t.last_applied_page_digest} IS NOT NULL
      AND ${t.last_applied_page_digest} ~ '^sha256:[a-f0-9]{64}$'
      AND ${t.last_applied_at} IS NOT NULL)
  `),
]);

export const appSyncIntents = pgTable('app_sync_intents', {
  ...id(),
  ...orgId(),
  run_id: text('run_id').notNull(),
  resource_binding_id: text('resource_binding_id').notNull(),
  checkpoint_id: text('checkpoint_id').notNull(),
  app_installation_id: text('app_installation_id').notNull(),
  app_version_id: text('app_version_id').notNull(),
  grant_snapshot_id: text('grant_snapshot_id').notNull(),
  provider_snapshot_id: text('provider_snapshot_id').notNull(),
  owner_user_id: text('owner_user_id').notNull(),
  descriptor_digest: text('descriptor_digest').notNull(),
  generation: integer('generation').notNull(),
  expected_cursor_sequence: integer('expected_cursor_sequence').notNull(),
  expected_cursor_hmac_key_version: text('expected_cursor_hmac_key_version').notNull(),
  expected_cursor_hmac: text('expected_cursor_hmac').notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  foreignKey({ columns: [t.org_id, t.run_id, t.app_installation_id,
    t.app_version_id, t.grant_snapshot_id, t.resource_binding_id, t.provider_snapshot_id],
    foreignColumns: [appRuns.org_id, appRuns.id, appRuns.origin_app_installation_id,
      appRuns.origin_app_version_id, appRuns.origin_app_grant_snapshot_id,
      appRuns.origin_resource_binding_id, appRuns.provider_snapshot_id],
    name: 'app_sync_intents_run_fk' }).onDelete('restrict'),
  foreignKey({ columns: [t.org_id, t.checkpoint_id, t.resource_binding_id],
    foreignColumns: [appSyncCheckpoints.org_id, appSyncCheckpoints.id,
      appSyncCheckpoints.resource_binding_id],
    name: 'app_sync_intents_checkpoint_fk' }).onDelete('restrict'),
  foreignKey({ columns: [t.org_id, t.resource_binding_id, t.owner_user_id],
    foreignColumns: [appResourceBindings.org_id, appResourceBindings.id,
      appResourceBindings.owner_user_id],
    name: 'app_sync_intents_owner_fk' }).onDelete('restrict'),
  foreignKey({ columns: [t.org_id, t.resource_binding_id, t.owner_user_id,
    t.descriptor_digest],
    foreignColumns: [appResourceBindings.org_id, appResourceBindings.id,
      appResourceBindings.owner_user_id, appResourceBindings.descriptor_digest],
    name: 'app_sync_intents_descriptor_fk' }).onDelete('restrict'),
  unique('app_sync_intents_org_run_unique').on(t.org_id, t.run_id),
  unique('app_sync_intents_checkpoint_run_unique').on(t.org_id, t.run_id,
    t.resource_binding_id, t.checkpoint_id),
  index('app_sync_intents_binding_idx').on(t.org_id, t.resource_binding_id, t.created_at),
  check('app_sync_intents_start_check', sql`
    ${t.generation} >= 1 AND ${t.expected_cursor_sequence} >= 0
    AND ${t.expected_cursor_hmac_key_version} ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    AND ${t.expected_cursor_hmac} ~ '^hmac-sha256:[a-f0-9]{64}$'
    AND ${t.descriptor_digest} ~ '^sha256:[a-f0-9]{64}$'
  `),
]);

export const appResourceProjections = pgTable('app_resource_projections', {
  ...id(),
  ...orgId(),
  resource_binding_id: text('resource_binding_id').notNull(),
  checkpoint_id: text('checkpoint_id').notNull(),
  generation: integer('generation').notNull(),
  resource_id_hmac_key_version: text('resource_id_hmac_key_version').notNull(),
  resource_id_hmac: text('resource_id_hmac').notNull(),
  provider_id_envelope_version: text('provider_id_envelope_version').notNull(),
  provider_id_algorithm: text('provider_id_algorithm').$type<'aes-256-gcm'>().notNull(),
  provider_id_key_version: text('provider_id_key_version').notNull(),
  provider_id_nonce_b64: text('provider_id_nonce_b64').notNull(),
  provider_id_ciphertext_b64: text('provider_id_ciphertext_b64').notNull(),
  provider_id_auth_tag_b64: text('provider_id_auth_tag_b64').notNull(),
  provider_id_bytes: integer('provider_id_bytes').notNull(),
  body_envelope_version: text('body_envelope_version'),
  body_algorithm: text('body_algorithm').$type<'aes-256-gcm'>(),
  body_key_version: text('body_key_version'),
  body_nonce_b64: text('body_nonce_b64'),
  body_ciphertext_b64: text('body_ciphertext_b64'),
  body_auth_tag_b64: text('body_auth_tag_b64'),
  body_bytes: integer('body_bytes').default(0).notNull(),
  state: text('state').$type<'live' | 'tombstone'>().notNull(),
  applied_sequence: integer('applied_sequence').notNull(),
  first_seen_at: timestamp('first_seen_at').notNull(),
  last_seen_at: timestamp('last_seen_at').notNull(),
  source_updated_at: timestamp('source_updated_at'),
  fresh_until: timestamp('fresh_until'),
  tombstoned_at: timestamp('tombstoned_at'),
  ...timestamps(),
}, (t) => [
  foreignKey({ columns: [t.org_id, t.checkpoint_id, t.resource_binding_id],
    foreignColumns: [appSyncCheckpoints.org_id, appSyncCheckpoints.id,
      appSyncCheckpoints.resource_binding_id],
    name: 'app_resource_projections_checkpoint_fk' }).onDelete('restrict'),
  unique('app_resource_projections_org_id_id_unique').on(t.org_id, t.id),
  unique('app_resource_projections_attachment_identity_unique').on(t.org_id, t.id, t.checkpoint_id, t.resource_binding_id),
  unique('app_resource_projections_locator_unique').on(t.org_id, t.checkpoint_id,
    t.resource_id_hmac_key_version, t.resource_id_hmac),
  index('app_resource_projections_binding_state_idx').on(t.org_id, t.resource_binding_id,
    t.state, t.fresh_until),
  check('app_resource_projections_lineage_check', sql`
    ${t.generation} >= 1 AND ${t.applied_sequence} >= 1
    AND ${t.first_seen_at} <= ${t.last_seen_at}
    AND ${t.resource_id_hmac_key_version} ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    AND ${t.resource_id_hmac} ~ '^hmac-sha256:[a-f0-9]{64}$'
  `),
  check('app_resource_projections_provider_envelope_check', sql`
    ${t.provider_id_envelope_version} = 'deft.secret.v1'
    AND ${t.provider_id_algorithm} = 'aes-256-gcm'
    AND ${t.provider_id_key_version} ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    AND ${t.provider_id_nonce_b64} ~ '^[A-Za-z0-9+/]{16}$'
    AND ${t.provider_id_auth_tag_b64} ~ '^[A-Za-z0-9+/]{22}==$'
    AND ${t.provider_id_ciphertext_b64} ~ '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$'
    AND ${t.provider_id_bytes} BETWEEN 1 AND 512
    AND octet_length(decode(${t.provider_id_ciphertext_b64}, 'base64')) = ${t.provider_id_bytes}
  `),
  check('app_resource_projections_body_check', sql`
    (${t.state} = 'tombstone' AND ${t.tombstoned_at} IS NOT NULL
      AND ${t.body_bytes} = 0 AND ${t.body_envelope_version} IS NULL
      AND ${t.body_algorithm} IS NULL AND ${t.body_key_version} IS NULL
      AND ${t.body_nonce_b64} IS NULL AND ${t.body_ciphertext_b64} IS NULL
      AND ${t.body_auth_tag_b64} IS NULL)
    OR (${t.state} = 'live' AND ${t.tombstoned_at} IS NULL
      AND ${t.body_envelope_version} IS NOT NULL AND ${t.body_algorithm} IS NOT NULL
      AND ${t.body_key_version} IS NOT NULL AND ${t.body_nonce_b64} IS NOT NULL
      AND ${t.body_ciphertext_b64} IS NOT NULL AND ${t.body_auth_tag_b64} IS NOT NULL
      AND ${t.body_envelope_version} = 'deft.secret.v1'
      AND ${t.body_algorithm} = 'aes-256-gcm'
      AND ${t.body_key_version} = ${t.provider_id_key_version}
      AND ${t.body_key_version} ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
      AND ${t.body_nonce_b64} ~ '^[A-Za-z0-9+/]{16}$'
      AND ${t.body_auth_tag_b64} ~ '^[A-Za-z0-9+/]{22}==$'
      AND ${t.body_ciphertext_b64} ~ '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$'
      AND ${t.body_bytes} BETWEEN 1 AND 524288
      AND octet_length(decode(${t.body_ciphertext_b64}, 'base64')) = ${t.body_bytes})
  `),
]);

/** Quarantine custody only. A stage ID never grants parent or binary access. */
export const appAttachmentStages = pgTable('app_attachment_stages', {
  ...id(), ...orgId(),
  resource_binding_id: text('resource_binding_id').notNull(), checkpoint_id: text('checkpoint_id').notNull(),
  generation: integer('generation').notNull(), run_id: text('run_id').notNull(), attempt_id: text('attempt_id').notNull(),
  claim_token: text('claim_token').notNull(), reservation_sequence: integer('reservation_sequence').notNull(),
  fingerprint_key_version: text('fingerprint_key_version').notNull(),
  parent_locator_hmac: text('parent_locator_hmac').notNull(), parent_revision_hmac: text('parent_revision_hmac').notNull(),
  attachment_key_hmac: text('attachment_key_hmac').notNull(), content_hmac: text('content_hmac'),
  declared_size_bytes: integer('declared_size_bytes').notNull(),
  metadata_envelope: jsonb('metadata_envelope').$type<Record<string, unknown>>(),
  binary_key_version: text('binary_key_version'), binary_nonce_b64: text('binary_nonce_b64'), binary_auth_tag_b64: text('binary_auth_tag_b64'),
  object_id: text('object_id'),
  state: text('state').$type<'uploading' | 'ready' | 'blocked' | 'linked' | 'linked_blocked' | 'retired' | 'purged'>().default('uploading').notNull(),
  stage_expires_at: timestamp('stage_expires_at').notNull(), linked_expires_at: timestamp('linked_expires_at'),
  projection_id: text('projection_id'), parent_body_hmac: text('parent_body_hmac'), accepted_at: timestamp('accepted_at'),
  retired_at: timestamp('retired_at'), purged_at: timestamp('purged_at'), ...timestamps(),
}, t => [
  unique('app_attachment_stages_org_id_id_unique').on(t.org_id, t.id),
  unique('app_attachment_stages_retry_unique').on(t.org_id, t.run_id, t.attempt_id, t.checkpoint_id, t.generation,
    t.fingerprint_key_version, t.parent_locator_hmac, t.parent_revision_hmac, t.attachment_key_hmac),
  foreignKey({ columns: [t.org_id, t.checkpoint_id, t.resource_binding_id],
    foreignColumns: [appSyncCheckpoints.org_id, appSyncCheckpoints.id, appSyncCheckpoints.resource_binding_id],
    name: 'app_attachment_stages_checkpoint_fk' }).onDelete('restrict'),
  foreignKey({ columns: [t.org_id, t.run_id, t.attempt_id],
    foreignColumns: [appRunAttempts.org_id, appRunAttempts.run_id, appRunAttempts.id],
    name: 'app_attachment_stages_attempt_fk' }).onDelete('restrict'),
  foreignKey({ columns: [t.org_id, t.projection_id, t.checkpoint_id, t.resource_binding_id],
    foreignColumns: [appResourceProjections.org_id, appResourceProjections.id, appResourceProjections.checkpoint_id, appResourceProjections.resource_binding_id],
    name: 'app_attachment_stages_projection_fk' }).onDelete('restrict'),
  index('app_attachment_stages_cleanup_idx').on(t.state, t.stage_expires_at, t.id),
  index('app_attachment_stages_parent_idx').on(t.org_id, t.resource_binding_id, t.projection_id, t.state),
  check('app_attachment_stages_identity_check', sql`${t.generation} >= 1 AND ${t.reservation_sequence} >= 1
    AND ${t.fingerprint_key_version} ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    AND ${t.parent_locator_hmac} ~ '^[a-f0-9]{64}$' AND ${t.parent_revision_hmac} ~ '^[a-f0-9]{64}$'
    AND ${t.attachment_key_hmac} ~ '^[a-f0-9]{64}$'
    AND (${t.content_hmac} IS NULL OR ${t.content_hmac} ~ '^[a-f0-9]{64}$')
    AND (${t.parent_body_hmac} IS NULL OR ${t.parent_body_hmac} ~ '^[a-f0-9]{64}$')
    AND ${t.declared_size_bytes} BETWEEN 0 AND 2097152
    AND ${t.stage_expires_at} > ${t.created_at} AND ${t.stage_expires_at} <= ${t.created_at} + interval '1 hour'`),
  check('app_attachment_stages_metadata_check', sql`(${t.state} = 'purged' AND ${t.metadata_envelope} IS NULL)
    OR (${t.state} <> 'purged' AND ${t.metadata_envelope} IS NOT NULL AND jsonb_typeof(${t.metadata_envelope}) = 'object'
    AND octet_length(${t.metadata_envelope}::text) <= 16384)`),
  check('app_attachment_stages_state_check', sql`${t.state} IN ('uploading','ready','blocked','linked','linked_blocked','retired','purged')
    AND ((${t.state} IN ('linked','linked_blocked') AND ${t.projection_id} IS NOT NULL AND ${t.parent_body_hmac} IS NOT NULL
      AND ${t.accepted_at} IS NOT NULL AND ${t.linked_expires_at} IS NOT NULL AND ${t.linked_expires_at} > ${t.accepted_at}
      AND ${t.linked_expires_at} <= ${t.accepted_at} + interval '30 days') OR ${t.state} NOT IN ('linked','linked_blocked'))
    AND (${t.state} NOT IN ('ready','blocked','linked','linked_blocked') OR ${t.content_hmac} IS NOT NULL)
    AND (${t.state} NOT IN ('blocked','linked_blocked','purged') OR (${t.object_id} IS NULL AND ${t.binary_key_version} IS NULL
      AND ${t.binary_nonce_b64} IS NULL AND ${t.binary_auth_tag_b64} IS NULL))
    AND (${t.state} NOT IN ('ready','linked') OR (${t.object_id} IS NOT NULL AND ${t.binary_key_version} IS NOT NULL
      AND ${t.binary_nonce_b64} IS NOT NULL AND ${t.binary_auth_tag_b64} IS NOT NULL
      AND ${t.binary_key_version} ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
      AND ${t.binary_nonce_b64} ~ '^[A-Za-z0-9+/]{16}$' AND ${t.binary_auth_tag_b64} ~ '^[A-Za-z0-9+/]{22}==$'))
    AND (${t.state} <> 'retired' OR ${t.retired_at} IS NOT NULL)
    AND (${t.state} <> 'purged' OR (${t.retired_at} IS NOT NULL AND ${t.purged_at} IS NOT NULL))`),
]);

export const appAutomationDefinitions = pgTable('app_automation_definitions', {
  ...id(),
  ...orgId(),
  app_installation_id: text('app_installation_id').notNull(),
  app_version_id: text('app_version_id').notNull(),
  app_manifest_digest: text('app_manifest_digest').notNull(),
  app_package_digest: text('app_package_digest').notNull(),
  grant_snapshot_id: text('grant_snapshot_id').notNull(),
  grant_snapshot_kind: text('grant_snapshot_kind').$type<'effective'>().default('effective').notNull(),
  grant_snapshot_digest: text('grant_snapshot_digest').notNull(),
  action_binding_id: text('action_binding_id').notNull(),
  action_key: text('action_key').notNull(),
  interface_identity: text('interface_identity').notNull(),
  automation_request_key: text('automation_request_key').notNull(),
  automation_request_digest: text('automation_request_digest').notNull(),
  installation_lifecycle_epoch: integer('installation_lifecycle_epoch').notNull(),
  installation_grant_epoch: integer('installation_grant_epoch').notNull(),
  provider_kind: text('provider_kind').$type<'mcp'>().notNull(),
  mcp_connection_id: text('mcp_connection_id').notNull(),
  provider_snapshot_id: text('provider_snapshot_id').notNull(),
  provider_snapshot_digest: text('provider_snapshot_digest').notNull(),
  operation_name: text('operation_name').notNull(),
  operation_schema_digest: text('operation_schema_digest').notNull(),
  binding_digest: text('binding_digest').notNull(),
  connector_authorization_version: integer('connector_authorization_version').notNull(),
  placement_resource_ref: jsonb('placement_resource_ref').$type<Record<string, unknown>>().notNull(),
  placement_resource_revision: text('placement_resource_revision').notNull(),
  placement_content_digest: text('placement_content_digest').notNull(),
  selected_resource_ref: jsonb('selected_resource_ref').$type<Record<string, unknown>>().notNull(),
  selected_resource_revision: text('selected_resource_revision').notNull(),
  selected_content_digest: text('selected_content_digest').notNull(),
  selected_relation_input_key: text('selected_relation_input_key').notNull(),
  selected_relation_key: text('selected_relation_key').notNull(),
  selected_relation_revision: integer('selected_relation_revision').notNull(),
  schedule_kind: text('schedule_kind').$type<'daily_local_time'>().notNull(),
  local_time: text('local_time').notNull(),
  timezone: text('timezone').notNull(),
  misfire_policy: text('misfire_policy').$type<'catch_up_within_15m'>().notNull(),
  catch_up_window_minutes: integer('catch_up_window_minutes').default(15).notNull(),
  max_actions_per_fire: integer('max_actions_per_fire').default(1).notNull(),
  max_org_runs_per_utc_day: integer('max_org_runs_per_utc_day').default(100).notNull(),
  max_pending_org_fires: integer('max_pending_org_fires').default(25).notNull(),
  valid_from: timestamp('valid_from').notNull(),
  valid_until: timestamp('valid_until').notNull(),
  policy_version: text('policy_version').$type<'1'>().notNull(),
  policy_digest: text('policy_digest').notNull(),
  authorization_vector: jsonb('authorization_vector').$type<Record<string, unknown>>().notNull(),
  authorization_digest: text('authorization_digest').notNull(),
  canonical_definition: jsonb('canonical_definition').$type<Record<string, unknown>>().notNull(),
  definition_digest: text('definition_digest').notNull(),
  state: text('state')
    .$type<'active' | 'paused' | 'revoked' | 'expired'>()
    .default('active')
    .notNull(),
  definition_epoch: integer('definition_epoch').default(1).notNull(),
  created_by_user_id: text('created_by_user_id').notNull(),
  approved_by_user_id: text('approved_by_user_id').notNull(),
  approver_authorization_version: integer('approver_authorization_version').notNull(),
  approved_at: timestamp('approved_at').notNull(),
  state_changed_at: timestamp('state_changed_at').defaultNow().notNull(),
  revoked_at: timestamp('revoked_at'),
  expired_at: timestamp('expired_at'),
  ...timestamps(),
}, (t) => [
  unique('app_automation_definitions_org_id_id_unique').on(t.org_id, t.id),
  foreignKey({
    columns: [t.org_id, t.app_installation_id],
    foreignColumns: [appInstallations.org_id, appInstallations.id],
    name: 'app_automation_definitions_app_installation_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.org_id, t.app_installation_id, t.app_version_id],
    foreignColumns: [appVersions.org_id, appVersions.installation_id, appVersions.id],
    name: 'app_automation_definitions_app_version_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [
      t.org_id,
      t.app_installation_id,
      t.app_version_id,
      t.grant_snapshot_id,
      t.grant_snapshot_kind,
    ],
    foreignColumns: [
      appGrantSnapshots.org_id,
      appGrantSnapshots.app_installation_id,
      appGrantSnapshots.app_version_id,
      appGrantSnapshots.id,
      appGrantSnapshots.snapshot_kind,
    ],
    name: 'app_automation_definitions_grant_snapshot_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [
      t.org_id,
      t.app_installation_id,
      t.app_version_id,
      t.grant_snapshot_id,
      t.action_key,
      t.action_binding_id,
    ],
    foreignColumns: [
      appActionBindings.org_id,
      appActionBindings.app_installation_id,
      appActionBindings.app_version_id,
      appActionBindings.grant_snapshot_id,
      appActionBindings.action_key,
      appActionBindings.id,
    ],
    name: 'app_automation_definitions_action_binding_fk',
  }).onDelete('restrict'),
  uniqueIndex('app_automation_definitions_digest_unique').on(t.org_id, t.definition_digest),
  index('app_automation_definitions_app_request_idx').on(
    t.org_id,
    t.app_installation_id,
    t.app_version_id,
    t.automation_request_key,
  ),
  index('app_automation_definitions_eligibility_idx').on(t.org_id, t.state, t.valid_until),
  check('app_automation_definitions_key_check', sql`
    ${t.action_key} ~ '^[a-z][a-z0-9_]{0,47}$'
    AND ${t.automation_request_key} ~ '^[a-z][a-z0-9_]{0,47}$'
    AND ${t.selected_relation_input_key} ~ '^[a-z][a-z0-9_]{0,47}$'
    AND ${t.selected_relation_key} ~ '^[a-z][a-z0-9_]{0,47}$'
    AND ${t.action_key} !~ '^(deft|core|system)(_|$)'
    AND ${t.automation_request_key} !~ '^(deft|core|system)(_|$)'
    AND ${t.selected_relation_input_key} !~ '^(deft|core|system)(_|$)'
    AND ${t.selected_relation_key} !~ '^(deft|core|system)(_|$)'
  `),
  check('app_automation_definitions_provider_check', sql`${t.provider_kind} = 'mcp'`),
  check('app_automation_definitions_grant_kind_check', sql`${t.grant_snapshot_kind} = 'effective'`),
  check('app_automation_definitions_schedule_check', sql`
    ${t.schedule_kind} = 'daily_local_time'
    AND ${t.local_time} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    AND octet_length(${t.timezone}) BETWEEN 1 AND 128
    AND ${t.timezone} !~ '[[:cntrl:]]'
    AND ${t.misfire_policy} = 'catch_up_within_15m'
    AND ${t.catch_up_window_minutes} = 15
  `),
  check('app_automation_definitions_budget_check', sql`
    ${t.max_actions_per_fire} = 1
    AND ${t.max_org_runs_per_utc_day} BETWEEN 1 AND 100
    AND ${t.max_pending_org_fires} BETWEEN 1 AND 25
  `),
  check('app_automation_definitions_validity_check', sql`
    ${t.valid_from} = ${t.approved_at}
    AND ${t.valid_until} > ${t.valid_from}
    AND ${t.valid_until} <= ${t.approved_at} + interval '30 days'
  `),
  check('app_automation_definitions_epoch_check', sql`${t.definition_epoch} >= 1`),
  check('app_automation_definitions_state_check', sql`
    ${t.state} IN ('active', 'paused', 'revoked', 'expired')
  `),
  check('app_automation_definitions_approval_shape_check', sql`
    (
      ${t.state} IN ('active', 'paused')
      AND ${t.definition_epoch} >= 1
      AND ${t.revoked_at} IS NULL
      AND ${t.expired_at} IS NULL
    ) OR (
      ${t.state} = 'revoked'
      AND ${t.definition_epoch} >= 2
      AND ${t.revoked_at} IS NOT NULL
      AND ${t.expired_at} IS NULL
    ) OR (
      ${t.state} = 'expired'
      AND ${t.definition_epoch} >= 2
      AND ${t.revoked_at} IS NULL
      AND ${t.expired_at} IS NOT NULL
    )
  `),
  check('app_automation_definitions_digest_check', sql`
    ${t.automation_request_digest} ~ '^sha256:[a-f0-9]{64}$'
    AND ${t.app_manifest_digest} ~ '^sha256:[a-f0-9]{64}$'
    AND ${t.app_package_digest} ~ '^sha256:[a-f0-9]{64}$'
    AND ${t.grant_snapshot_digest} ~ '^sha256:[a-f0-9]{64}$'
    AND ${t.operation_schema_digest} ~ '^sha256:[a-f0-9]{64}$'
    AND ${t.binding_digest} ~ '^sha256:[a-f0-9]{64}$'
    AND ${t.provider_snapshot_digest} ~ '^sha256:[a-f0-9]{64}$'
    AND ${t.placement_content_digest} ~ '^sha256:[a-f0-9]{64}$'
    AND ${t.selected_content_digest} ~ '^sha256:[a-f0-9]{64}$'
    AND ${t.policy_digest} ~ '^sha256:[a-f0-9]{64}$'
    AND ${t.authorization_digest} ~ '^sha256:[a-f0-9]{64}$'
    AND ${t.definition_digest} ~ '^sha256:[a-f0-9]{64}$'
  `),
  check('app_automation_definitions_resource_revision_check', sql`
    octet_length(${t.placement_resource_revision}) BETWEEN 1 AND 128
    AND ${t.placement_resource_revision} !~ '[[:cntrl:]]'
    AND octet_length(${t.selected_resource_revision}) BETWEEN 1 AND 128
    AND ${t.selected_resource_revision} !~ '[[:cntrl:]]'
  `),
  check('app_automation_definitions_policy_check', sql`
    ${t.policy_version} = '1'
    AND ${t.connector_authorization_version} >= 1
    AND ${t.approver_authorization_version} >= 1
    AND ${t.installation_lifecycle_epoch} >= 0
    AND ${t.installation_grant_epoch} >= 1
    AND ${t.selected_relation_revision} >= 0
  `),
  check('app_automation_definitions_json_check', sql`
    jsonb_typeof(${t.placement_resource_ref}) = 'object'
    AND jsonb_typeof(${t.selected_resource_ref}) = 'object'
    AND jsonb_typeof(${t.authorization_vector}) = 'object'
    AND jsonb_typeof(${t.canonical_definition}) = 'object'
    AND ${t.placement_resource_ref}->>'schema_version' = 'deft.resource_ref.v1'
    AND ${t.placement_resource_ref}#>>'{provider,kind}' = 'module'
    AND ${t.selected_resource_ref}->>'schema_version' = 'deft.resource_ref.v1'
    AND ${t.selected_resource_ref}#>>'{provider,kind}' = 'module'
  `),
  check('app_automation_definitions_json_size_check', sql`
    octet_length(${t.placement_resource_ref}::text) <= 4096
    AND octet_length(${t.selected_resource_ref}::text) <= 4096
    AND octet_length(${t.authorization_vector}::text) <= 65536
    AND octet_length(${t.canonical_definition}::text) <= 131072
  `),
]);

export const appAutomationFires = pgTable('app_automation_fires', {
  ...id(),
  ...orgId(),
  definition_id: text('definition_id').notNull(),
  definition_epoch: integer('definition_epoch').notNull(),
  logical_local_date: text('logical_local_date').notNull(),
  local_time: text('local_time').notNull(),
  timezone: text('timezone').notNull(),
  resolved_at_utc: timestamp('resolved_at_utc'),
  fire_identity: text('fire_identity').notNull(),
  state: text('state')
    .$type<'pending' | 'claimed' | 'run_created' | 'skipped' | 'dead_letter'>()
    .default('pending')
    .notNull(),
  attempt_count: integer('attempt_count').default(0).notNull(),
  claim_owner: text('claim_owner'),
  claim_token: text('claim_token'),
  claimed_at: timestamp('claimed_at'),
  lease_expires_at: timestamp('lease_expires_at'),
  app_run_id: text('app_run_id'),
  terminal_reason: text('terminal_reason')
    .$type<'run_created' | 'dst_gap' | 'misfire_skipped' | 'attempts_exhausted' | 'definition_ineligible'>(),
  terminal_at: timestamp('terminal_at'),
  ...timestamps(),
}, (t) => [
  unique('app_automation_fires_org_definition_id_unique').on(t.org_id, t.definition_id, t.id),
  foreignKey({
    columns: [t.org_id, t.definition_id],
    foreignColumns: [appAutomationDefinitions.org_id, appAutomationDefinitions.id],
    name: 'app_automation_fires_definition_fk',
  }).onDelete('restrict'),
  // The reverse fire -> Run FK is installed by .26/apply-extras. Keeping the
  // circular half out of Drizzle avoids an inference cycle while deployed
  // schemas still enforce the exact org/definition/fire/run tuple.
  uniqueIndex('app_automation_fires_identity_unique').on(t.org_id, t.fire_identity),
  uniqueIndex('app_automation_fires_occurrence_unique').on(
    t.org_id,
    t.definition_id,
    t.definition_epoch,
    t.logical_local_date,
    t.local_time,
    t.timezone,
  ),
  uniqueIndex('app_automation_fires_definition_day_unique').on(
    t.org_id,
    t.definition_id,
    t.logical_local_date,
  ),
  uniqueIndex('app_automation_fires_one_active_unique')
    .on(t.org_id, t.definition_id)
    .where(sql`${t.state} IN ('pending', 'claimed')`),
  index('app_automation_fires_claim_idx').on(t.state, t.resolved_at_utc, t.lease_expires_at),
  index('app_automation_fires_org_state_idx').on(t.org_id, t.state, t.created_at),
  check('app_automation_fires_epoch_check', sql`${t.definition_epoch} >= 1`),
  check('app_automation_fires_occurrence_check', sql`
    ${t.logical_local_date} ~ '^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])$'
    AND ${t.local_time} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    AND octet_length(${t.timezone}) BETWEEN 1 AND 128
    AND ${t.timezone} !~ '[[:cntrl:]]'
  `),
  check('app_automation_fires_identity_check', sql`${t.fire_identity} ~ '^sha256:[a-f0-9]{64}$'`),
  check('app_automation_fires_resolution_check', sql`
    (
      ${t.state} = 'skipped'
      AND ${t.terminal_reason} = 'dst_gap'
      AND ${t.resolved_at_utc} IS NULL
    ) OR (
      (${t.state} <> 'skipped' OR ${t.terminal_reason} IS DISTINCT FROM 'dst_gap')
      AND ${t.resolved_at_utc} IS NOT NULL
    )
  `),
  check('app_automation_fires_attempt_check', sql`${t.attempt_count} BETWEEN 0 AND 3`),
  check('app_automation_fires_state_check', sql`
    ${t.state} IN ('pending', 'claimed', 'run_created', 'skipped', 'dead_letter')
  `),
  check('app_automation_fires_claim_shape_check', sql`
    (
      ${t.state} = 'pending'
      AND ${t.claim_owner} IS NULL
      AND ${t.claim_token} IS NULL
      AND ${t.claimed_at} IS NULL
      AND ${t.lease_expires_at} IS NULL
      AND ${t.app_run_id} IS NULL
      AND ${t.terminal_reason} IS NULL
      AND ${t.terminal_at} IS NULL
    ) OR (
      ${t.state} = 'claimed'
      AND ${t.attempt_count} BETWEEN 1 AND 3
      AND ${t.claim_owner} IS NOT NULL
      AND ${t.claim_token} IS NOT NULL
      AND ${t.claimed_at} IS NOT NULL
      AND ${t.lease_expires_at} > ${t.claimed_at}
      AND ${t.app_run_id} IS NULL
      AND ${t.terminal_reason} IS NULL
      AND ${t.terminal_at} IS NULL
    ) OR (
      ${t.state} = 'run_created'
      AND ${t.attempt_count} BETWEEN 1 AND 3
      AND ${t.app_run_id} IS NOT NULL
      AND ${t.terminal_reason} = 'run_created'
      AND ${t.terminal_at} IS NOT NULL
    ) OR (
      ${t.state} = 'skipped'
      AND ${t.app_run_id} IS NULL
      AND ${t.terminal_reason} IN ('dst_gap', 'misfire_skipped', 'definition_ineligible')
      AND ${t.terminal_at} IS NOT NULL
    ) OR (
      ${t.state} = 'dead_letter'
      AND ${t.attempt_count} = 3
      AND ${t.app_run_id} IS NULL
      AND ${t.terminal_reason} = 'attempts_exhausted'
      AND ${t.terminal_at} IS NOT NULL
    )
  `),
  check('app_automation_fires_claim_text_check', sql`
    (${t.claim_owner} IS NULL OR (octet_length(${t.claim_owner}) BETWEEN 1 AND 128 AND ${t.claim_owner} !~ '[[:cntrl:]]'))
    AND (${t.claim_token} IS NULL OR (octet_length(${t.claim_token}) BETWEEN 1 AND 128 AND ${t.claim_token} !~ '[[:cntrl:]]'))
  `),
]);

export const appDeveloperPairings = pgTable('app_developer_pairings', {
  ...id(),
  ...orgId(),
  code_hash: text('code_hash').notNull(),
  created_by_user_id: text('created_by_user_id').notNull(),
  expires_at: timestamp('expires_at').notNull(),
  consumed_at: timestamp('consumed_at'),
  revoked_at: timestamp('revoked_at'),
  session_token_hash: text('session_token_hash'),
  session_expires_at: timestamp('session_expires_at'),
  install_used_at: timestamp('install_used_at'),
  ...timestamps(),
}, (t) => [
  foreignKey({
    columns: [t.org_id, t.created_by_user_id],
    foreignColumns: [orgMembers.org_id, orgMembers.user_id],
    name: 'app_developer_pairings_creator_member_fk',
  }).onDelete('restrict'),
  uniqueIndex('app_developer_pairings_code_hash_unique').on(t.code_hash),
  uniqueIndex('app_developer_pairings_session_hash_unique')
    .on(t.session_token_hash)
    .where(sql`${t.session_token_hash} IS NOT NULL`),
  index('app_developer_pairings_org_idx').on(t.org_id, t.created_at),
  check('app_developer_pairings_code_hash_check', sql`${t.code_hash} ~ '^sha256:[a-f0-9]{64}$'`),
  check('app_developer_pairings_session_hash_check', sql`${t.session_token_hash} IS NULL OR ${t.session_token_hash} ~ '^sha256:[a-f0-9]{64}$'`),
  check(
    'app_developer_pairings_exchange_state_check',
    sql`(${t.consumed_at} IS NULL AND ${t.session_token_hash} IS NULL AND ${t.session_expires_at} IS NULL)
      OR (${t.consumed_at} IS NOT NULL AND ${t.session_token_hash} IS NOT NULL AND ${t.session_expires_at} IS NOT NULL)`,
  ),
]);

export const moduleRecords = pgTable('module_records', {
  ...id(),
  ...orgId(),
  installation_id: text('installation_id').notNull(),
  collection_key: text('collection_key').notNull(),
  validated_version_id: text('validated_version_id').notNull(),
  data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
  revision: integer('revision').default(1).notNull(),
  // Durable create dedupe. Update/archive safety is provided by revision CAS;
  // storing only a mutable "last request" key would make old retries unsafe.
  create_idempotency_key: text('create_idempotency_key'),
  // Only manifest-declared fields are projected into these columns by the
  // module service. Source JSON remains untouched and is never blanket-indexed.
  search_title: text('search_title').notNull(),
  search_subtitle: text('search_subtitle'),
  search_text: text('search_text').notNull().default(''),
  search_vector: tsvector('search_vector').generatedAlwaysAs(sql`
    setweight(to_tsvector('simple'::regconfig, COALESCE("search_title", '')), 'A') ||
    setweight(to_tsvector('simple'::regconfig, COALESCE("search_subtitle", '')), 'B') ||
    setweight(to_tsvector('simple'::regconfig, COALESCE("search_text", '')), 'C')
  `),
  created_by_actor_type: text('created_by_actor_type').notNull(),
  created_by_actor_id: text('created_by_actor_id').notNull(),
  updated_by_actor_type: text('updated_by_actor_type').notNull(),
  updated_by_actor_id: text('updated_by_actor_id').notNull(),
  is_deleted: boolean('is_deleted').default(false).notNull(),
  deleted_at: timestamp('deleted_at'),
  deleted_by_actor_type: text('deleted_by_actor_type'),
  deleted_by_actor_id: text('deleted_by_actor_id'),
  ...timestamps(),
}, (t) => [
  foreignKey({
    columns: [t.org_id, t.installation_id],
    foreignColumns: [moduleInstallations.org_id, moduleInstallations.id],
    name: 'module_records_org_installation_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.org_id, t.installation_id, t.validated_version_id],
    foreignColumns: [moduleVersions.org_id, moduleVersions.installation_id, moduleVersions.id],
    name: 'module_records_validated_version_fk',
  }).onDelete('restrict'),
  unique('module_records_org_installation_id_unique').on(t.org_id, t.installation_id, t.id),
  uniqueIndex('module_records_create_idempotency_unique')
    .on(
      t.org_id,
      t.installation_id,
      t.created_by_actor_type,
      t.created_by_actor_id,
      t.create_idempotency_key,
    )
    .where(sql`${t.create_idempotency_key} IS NOT NULL`),
  index('module_records_org_collection_idx').on(
    t.org_id,
    t.installation_id,
    t.collection_key,
    t.is_deleted,
    t.updated_at,
  ),
  index('module_records_validated_version_idx').on(t.org_id, t.installation_id, t.validated_version_id),
  index('module_records_search_idx').using('gin', t.search_vector),
  check('module_records_collection_key_not_empty', sql`length(btrim(${t.collection_key})) > 0`),
  check('module_records_data_object_check', sql`jsonb_typeof(${t.data}) = 'object'`),
  check('module_records_revision_positive_check', sql`${t.revision} >= 1`),
  check(
    'module_records_create_idempotency_digest_check',
    sql`${t.create_idempotency_key} IS NULL OR ${t.create_idempotency_key} ~ '^sha256:[a-f0-9]{64}$'`,
  ),
  check(
    'module_records_deleted_state_check',
    sql`(
      NOT ${t.is_deleted}
      AND ${t.deleted_at} IS NULL
      AND ${t.deleted_by_actor_type} IS NULL
      AND ${t.deleted_by_actor_id} IS NULL
    ) OR (
      ${t.is_deleted}
      AND ${t.deleted_at} IS NOT NULL
      AND ${t.deleted_by_actor_type} IS NOT NULL
      AND ${t.deleted_by_actor_id} IS NOT NULL
    )`,
  ),
]);

// Relation values are normalized rather than embedded in record JSON. Both
// ends carry the same org + installation composite key, so cross-tenant and
// cross-module edges are rejected by PostgreSQL even if a caller supplies
// otherwise-valid record IDs.
export const moduleRecordRelations = pgTable('module_record_relations', {
  ...id(),
  ...orgId(),
  installation_id: text('installation_id').notNull(),
  field_key: text('field_key').notNull(),
  source_record_id: text('source_record_id').notNull(),
  target_record_id: text('target_record_id').notNull(),
  position: integer('position').default(0).notNull(),
  created_by_actor_type: text('created_by_actor_type').notNull(),
  created_by_actor_id: text('created_by_actor_id').notNull(),
  updated_by_actor_type: text('updated_by_actor_type').notNull(),
  updated_by_actor_id: text('updated_by_actor_id').notNull(),
  is_deleted: boolean('is_deleted').default(false).notNull(),
  deleted_at: timestamp('deleted_at'),
  deleted_by_actor_type: text('deleted_by_actor_type'),
  deleted_by_actor_id: text('deleted_by_actor_id'),
  ...timestamps(),
}, (t) => [
  foreignKey({
    columns: [t.org_id, t.installation_id],
    foreignColumns: [moduleInstallations.org_id, moduleInstallations.id],
    name: 'module_record_relations_org_installation_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.org_id, t.installation_id, t.source_record_id],
    foreignColumns: [moduleRecords.org_id, moduleRecords.installation_id, moduleRecords.id],
    name: 'module_record_relations_source_record_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.org_id, t.installation_id, t.target_record_id],
    foreignColumns: [moduleRecords.org_id, moduleRecords.installation_id, moduleRecords.id],
    name: 'module_record_relations_target_record_fk',
  }).onDelete('restrict'),
  uniqueIndex('module_record_relations_active_unique')
    .on(t.org_id, t.installation_id, t.source_record_id, t.field_key, t.target_record_id)
    .where(sql`${t.is_deleted} = false`),
  index('module_record_relations_source_idx').on(
    t.org_id,
    t.installation_id,
    t.source_record_id,
    t.field_key,
    t.is_deleted,
    t.position,
  ),
  index('module_record_relations_target_idx').on(
    t.org_id,
    t.installation_id,
    t.target_record_id,
    t.is_deleted,
  ),
  check('module_record_relations_field_key_not_empty', sql`length(btrim(${t.field_key})) > 0`),
  check('module_record_relations_position_nonnegative', sql`${t.position} >= 0`),
  check(
    'module_record_relations_deleted_state_check',
    sql`(
      NOT ${t.is_deleted}
      AND ${t.deleted_at} IS NULL
      AND ${t.deleted_by_actor_type} IS NULL
      AND ${t.deleted_by_actor_id} IS NULL
    ) OR (
      ${t.is_deleted}
      AND ${t.deleted_at} IS NOT NULL
      AND ${t.deleted_by_actor_type} IS NOT NULL
      AND ${t.deleted_by_actor_id} IS NOT NULL
    )`,
  ),
]);

// Immutable merge provenance; values inherit Module access, never general audit visibility.
export const moduleRecordMerges = pgTable('module_record_merges', {
  ...id(), ...orgId(),
  installation_id: text('installation_id').notNull(),
  source_record_id: text('source_record_id').notNull(),
  target_record_id: text('target_record_id').notNull(),
  source_revision: integer('source_revision').notNull(),
  target_revision: integer('target_revision').notNull(),
  source_data: jsonb('source_data').$type<Record<string, unknown>>().notNull(),
  target_data: jsonb('target_data').$type<Record<string, unknown>>().notNull(),
  link_snapshot: jsonb('link_snapshot').$type<Record<string, unknown>>().notNull(),
  choices: jsonb('choices').$type<Record<string, unknown>>().notNull(),
  created_by: text('created_by').notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  foreignKey({ columns: [t.org_id, t.installation_id, t.source_record_id], foreignColumns: [moduleRecords.org_id, moduleRecords.installation_id, moduleRecords.id], name: 'module_record_merges_source_fk' }).onDelete('restrict'),
  foreignKey({ columns: [t.org_id, t.installation_id, t.target_record_id], foreignColumns: [moduleRecords.org_id, moduleRecords.installation_id, moduleRecords.id], name: 'module_record_merges_target_fk' }).onDelete('restrict'),
  check('module_record_merges_distinct_check', sql`${t.source_record_id} <> ${t.target_record_id}`),
  check('module_record_merges_revision_check', sql`${t.source_revision} > 0 AND ${t.target_revision} > 0`),
  check('module_record_merges_snapshot_check', sql`jsonb_typeof(${t.source_data}) = 'object' AND jsonb_typeof(${t.target_data}) = 'object' AND jsonb_typeof(${t.link_snapshot}) = 'object' AND jsonb_typeof(${t.choices}) = 'object'`),
  index('module_record_merges_target_idx').on(t.org_id, t.installation_id, t.target_record_id, t.created_at),
  index('module_record_merges_source_idx').on(t.org_id, t.installation_id, t.source_record_id),
]);

// Saved views are personal in v1. The owner is mandatory and the service only
// exposes a row back to that user. The config is declarative query metadata;
// it cannot contain executable code or URLs because the shared schema is
// strict and revalidated on every read/write.
export const moduleSavedViews = pgTable('module_saved_views', {
  ...id(),
  ...orgId(),
  installation_id: text('installation_id').notNull(),
  collection_key: text('collection_key').notNull(),
  owner_user_id: text('owner_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  view_type: text('view_type').$type<'table' | 'board' | 'timeline'>().notNull(),
  config: jsonb('config').$type<Record<string, unknown>>().notNull(),
  is_deleted: boolean('is_deleted').default(false).notNull(),
  deleted_at: timestamp('deleted_at'),
  ...timestamps(),
}, (t) => [
  foreignKey({
    columns: [t.org_id, t.installation_id],
    foreignColumns: [moduleInstallations.org_id, moduleInstallations.id],
    name: 'module_saved_views_org_installation_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.org_id, t.owner_user_id],
    foreignColumns: [orgMembers.org_id, orgMembers.user_id],
    name: 'module_saved_views_owner_member_fk',
  }).onDelete('cascade'),
  uniqueIndex('module_saved_views_active_name_unique')
    .on(t.org_id, t.installation_id, t.collection_key, t.owner_user_id, t.name)
    .where(sql`${t.is_deleted} = false`),
  index('module_saved_views_owner_idx').on(
    t.org_id,
    t.owner_user_id,
    t.installation_id,
    t.collection_key,
    t.is_deleted,
    t.updated_at,
  ),
  check('module_saved_views_collection_key_not_empty', sql`length(btrim(${t.collection_key})) > 0`),
  check('module_saved_views_name_not_empty', sql`length(btrim(${t.name})) > 0`),
  check('module_saved_views_type_check', sql`${t.view_type} IN ('table', 'board', 'timeline')`),
  check('module_saved_views_config_object_check', sql`jsonb_typeof(${t.config}) = 'object'`),
  check(
    'module_saved_views_config_type_check',
    sql`${t.config}->>'type' = ${t.view_type}`,
  ),
  check(
    'module_saved_views_deleted_state_check',
    sql`(${t.is_deleted} AND ${t.deleted_at} IS NOT NULL)
      OR (NOT ${t.is_deleted} AND ${t.deleted_at} IS NULL)`,
  ),
]);

// PII-free replay ledger for module writes. A completed mutation can be
// replayed after a lost MCP response without retaining record values or raw
// request/result JSON. The input digest proves whether a reused key represents
// the same request; changed_fields contains names only.
export const moduleMutationReceipts = pgTable('module_mutation_receipts', {
  ...id(),
  ...orgId(),
  installation_id: text('installation_id').notNull(),
  agent_action_id: text('agent_action_id').references(() => agentActions.id, { onDelete: 'restrict' }),
  actor_type: text('actor_type').$type<'human' | 'defty' | 'agent_employee' | 'system'>().notNull(),
  actor_id: text('actor_id').notNull(),
  operation: text('operation').$type<'create' | 'update' | 'archive'>().notNull(),
  idempotency_key: text('idempotency_key').notNull(),
  input_digest: text('input_digest').notNull(),
  record_id: text('record_id').notNull(),
  result_revision: integer('result_revision').notNull(),
  result_manifest_digest: text('result_manifest_digest').notNull(),
  result_archived: boolean('result_archived').notNull(),
  changed_fields: text('changed_fields').array().notNull().default(sql`ARRAY[]::text[]`),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  foreignKey({
    columns: [t.org_id, t.installation_id],
    foreignColumns: [moduleInstallations.org_id, moduleInstallations.id],
    name: 'module_mutation_receipts_org_installation_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.org_id, t.installation_id, t.record_id],
    foreignColumns: [moduleRecords.org_id, moduleRecords.installation_id, moduleRecords.id],
    name: 'module_mutation_receipts_record_fk',
  }).onDelete('restrict'),
  uniqueIndex('module_mutation_receipts_idempotency_unique').on(
    t.org_id,
    t.actor_type,
    t.actor_id,
    t.operation,
    t.idempotency_key,
  ),
  uniqueIndex('module_mutation_receipts_agent_action_unique')
    .on(t.org_id, t.agent_action_id)
    .where(sql`${t.agent_action_id} IS NOT NULL`),
  index('module_mutation_receipts_record_idx').on(
    t.org_id,
    t.installation_id,
    t.record_id,
    t.created_at,
  ),
  check(
    'module_mutation_receipts_actor_type_check',
    sql`${t.actor_type} IN ('human', 'defty', 'agent_employee', 'system')`,
  ),
  check('module_mutation_receipts_actor_id_not_empty', sql`length(btrim(${t.actor_id})) > 0`),
  check(
    'module_mutation_receipts_operation_check',
    sql`${t.operation} IN ('create', 'update', 'archive')`,
  ),
  check(
    'module_mutation_receipts_idempotency_key_digest_check',
    sql`${t.idempotency_key} ~ '^sha256:[a-f0-9]{64}$'`,
  ),
  check(
    'module_mutation_receipts_input_digest_check',
    sql`${t.input_digest} ~ '^sha256:[a-f0-9]{64}$'`,
  ),
  check('module_mutation_receipts_result_revision_check', sql`${t.result_revision} >= 1`),
  check(
    'module_mutation_receipts_result_manifest_digest_check',
    sql`${t.result_manifest_digest} ~ '^sha256:[a-f0-9]{64}$'`,
  ),
  check(
    'module_mutation_receipts_result_state_check',
    sql`(${t.operation} = 'archive' AND ${t.result_archived})
      OR (${t.operation} IN ('create', 'update') AND NOT ${t.result_archived})`,
  ),
]);

// Generic, host-owned resource relations. Resource tuples are opaque
// addresses, never authority: every read/write must re-resolve endpoints via
// the owning service. Sets retain a revision even when empty so replace/unlink
// has a durable optimistic-concurrency boundary.
export const resourceRelationSets = pgTable('resource_relation_sets', {
  ...id(),
  org_id: text('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  source_provider_kind: text('source_provider_kind').$type<'module' | 'core'>().notNull(),
  source_provider_instance_id: text('source_provider_instance_id').notNull(),
  source_resource_type: text('source_resource_type').notNull(),
  source_resource_id: text('source_resource_id').notNull(),
  relation_key: text('relation_key').notNull(),
  revision: integer('revision').default(0).notNull(),
  updated_by_actor_type: text('updated_by_actor_type').$type<'human' | 'defty' | 'agent_employee' | 'system'>().notNull(),
  updated_by_actor_id: text('updated_by_actor_id').notNull(),
  ...timestamps(),
}, (t) => [
  unique('resource_relation_sets_org_id_id_unique').on(t.org_id, t.id),
  uniqueIndex('resource_relation_sets_identity_unique').on(
    t.org_id,
    t.source_provider_kind,
    t.source_provider_instance_id,
    t.source_resource_type,
    t.source_resource_id,
    t.relation_key,
  ),
  index('resource_relation_sets_source_idx').on(
    t.org_id,
    t.source_provider_kind,
    t.source_provider_instance_id,
    t.source_resource_type,
    t.source_resource_id,
  ),
  check('resource_relation_sets_provider_check', sql`(
    ${t.source_provider_kind} = 'module'
    OR (
      ${t.source_provider_kind} = 'core'
      AND ${t.source_provider_instance_id} = 'tasks'
      AND ${t.source_resource_type} = 'task'
    )
  )`),
  check('resource_relation_sets_revision_check', sql`${t.revision} >= 0`),
  check('resource_relation_sets_relation_key_check', sql`${t.relation_key} ~ '^[a-z][a-z0-9_]{0,47}$'`),
  check('resource_relation_sets_actor_check', sql`${t.updated_by_actor_type} IN ('human', 'defty', 'agent_employee', 'system')`),
]);

export const resourceRelationEdges = pgTable('resource_relation_edges', {
  ...id(),
  ...orgId(),
  relation_set_id: text('relation_set_id').notNull(),
  target_provider_kind: text('target_provider_kind').$type<'module' | 'core'>().notNull(),
  target_provider_instance_id: text('target_provider_instance_id').notNull(),
  target_resource_type: text('target_resource_type').notNull(),
  target_resource_id: text('target_resource_id').notNull(),
  position: integer('position').notNull(),
  created_by_actor_type: text('created_by_actor_type').$type<'human' | 'defty' | 'agent_employee' | 'system'>().notNull(),
  created_by_actor_id: text('created_by_actor_id').notNull(),
  is_deleted: boolean('is_deleted').default(false).notNull(),
  deleted_at: timestamp('deleted_at'),
  ...timestamps(),
}, (t) => [
  foreignKey({
    columns: [t.org_id, t.relation_set_id],
    foreignColumns: [resourceRelationSets.org_id, resourceRelationSets.id],
    name: 'resource_relation_edges_org_set_fk',
  }).onDelete('restrict'),
  uniqueIndex('resource_relation_edges_active_target_unique').on(
    t.org_id,
    t.relation_set_id,
    t.target_provider_kind,
    t.target_provider_instance_id,
    t.target_resource_type,
    t.target_resource_id,
  ).where(sql`${t.is_deleted} = false`),
  uniqueIndex('resource_relation_edges_active_position_unique').on(
    t.org_id,
    t.relation_set_id,
    t.position,
  ).where(sql`${t.is_deleted} = false`),
  index('resource_relation_edges_target_idx').on(
    t.org_id,
    t.target_provider_kind,
    t.target_provider_instance_id,
    t.target_resource_type,
    t.target_resource_id,
    t.is_deleted,
  ),
  check('resource_relation_edges_provider_check', sql`(
    ${t.target_provider_kind} = 'module'
    OR (
      ${t.target_provider_kind} = 'core'
      AND ${t.target_provider_instance_id} = 'tasks'
      AND ${t.target_resource_type} = 'task'
    )
  )`),
  check('resource_relation_edges_position_check', sql`${t.position} >= 0`),
  check('resource_relation_edges_actor_check', sql`${t.created_by_actor_type} IN ('human', 'defty', 'agent_employee', 'system')`),
  check('resource_relation_edges_deleted_state_check', sql`(
    ${t.is_deleted} AND ${t.deleted_at} IS NOT NULL
  ) OR (
    NOT ${t.is_deleted} AND ${t.deleted_at} IS NULL
  )`),
]);

export const resourceRelationReceipts = pgTable('resource_relation_receipts', {
  ...id(),
  ...orgId(),
  relation_set_id: text('relation_set_id').notNull(),
  actor_type: text('actor_type').$type<'human' | 'defty' | 'agent_employee' | 'system'>().notNull(),
  actor_id: text('actor_id').notNull(),
  operation: text('operation').$type<'replace'>().default('replace').notNull(),
  idempotency_key: text('idempotency_key').notNull(),
  input_digest: text('input_digest').notNull(),
  result_revision: integer('result_revision').notNull(),
  result_refs: jsonb('result_refs').$type<unknown[]>().notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  foreignKey({
    columns: [t.org_id, t.relation_set_id],
    foreignColumns: [resourceRelationSets.org_id, resourceRelationSets.id],
    name: 'resource_relation_receipts_org_set_fk',
  }).onDelete('restrict'),
  uniqueIndex('resource_relation_receipts_idempotency_unique').on(
    t.org_id,
    t.actor_type,
    t.actor_id,
    t.operation,
    t.idempotency_key,
  ),
  check('resource_relation_receipts_actor_check', sql`${t.actor_type} IN ('human', 'defty', 'agent_employee', 'system')`),
  check('resource_relation_receipts_operation_check', sql`${t.operation} = 'replace'`),
  check('resource_relation_receipts_idempotency_check', sql`${t.idempotency_key} ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'`),
  check('resource_relation_receipts_digest_check', sql`${t.input_digest} ~ '^sha256:[a-f0-9]{64}$'`),
  check('resource_relation_receipts_revision_check', sql`${t.result_revision} >= 1`),
  check('resource_relation_receipts_refs_check', sql`jsonb_typeof(${t.result_refs}) = 'array'`),
]);

// org_spend_caps + clawhub_allowlist retired in self-hosted v1 delete
// sweep (migration 0053). Self-hosted runs on operator-owned API keys
// and the ClawHub surface is gone.

// Block 3.3 — per-agent webhook URLs. An agent-employee can expose an
// HMAC-signed URL that accepts POST payloads from external systems.
// The dispatcher enqueues an employee-trigger with trigger_kind='webhook'
// so the agent runs its playbook over the incoming payload.
export const agentWebhooks = pgTable('agent_webhooks', {
  ...id(),
  org_id: text('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  agent_employee_id: text('agent_employee_id').notNull().references(() => agentEmployees.id, { onDelete: 'cascade' }),
  slug: text('slug').notNull().unique(),
  secret_hash: text('secret_hash').notNull(),
  // Per-webhook AES-encrypted HMAC key (fix #7). New webhooks issue this
  // alongside the legacy scrypt secret so callers can sign with HMAC-SHA256
  // (`x-deft-webhook-signature: sha256=<hex>`) instead of shipping the raw
  // secret. Pre-existing rows have NULL until they're rotated.
  hmac_key_encrypted: text('hmac_key_encrypted'),
  label: text('label'),
  enabled: boolean('enabled').default(true).notNull(),
  last_fired_at: timestamp('last_fired_at'),
  fire_count: integer('fire_count').default(0).notNull(),
  created_by: text('created_by').references(() => users.id),
  ...timestamps(),
}, (t) => [
  index('agent_webhooks_org_idx').on(t.org_id),
  index('agent_webhooks_employee_idx').on(t.agent_employee_id),
]);

// skill_secrets retired alongside the pre-deploy install flow in self-hosted
// v1 (migration 0053).

// ═══ AGENT: TOOL REGISTRY ═══
export const tools = pgTable('tools', {
  ...id(),
  name: text('name').notNull().unique(),
  description: text('description').notNull(),
  category: text('category').notNull(), // 'native', 'google_calendar', 'github'
  params_schema: jsonb('params_schema').notNull(),
  approval_tier: approvalTierEnum('approval_tier').default('quick').notNull(),
  is_active: boolean('is_active').default(true).notNull(),
  ...timestamps(),
});

// ═══ AGENT: TRIGGERS ═══
export const triggers = pgTable('triggers', {
  ...id(),
  ...orgId(),
  name: text('name').notNull(),
  event_type: text('event_type').notNull(), // 'task_overdue', 'pr_merged', 'meeting_soon', 'task_stalled', 'cron'
  condition: jsonb('condition'), // optional filter
  actions: jsonb('actions').notNull(), // [{ tool, params }]
  is_active: boolean('is_active').default(true).notNull(),
  schedule: text('schedule'), // cron expression for scheduled triggers
  agent_employee_id: text('agent_employee_id'),
  last_fired_at: timestamp('last_fired_at'),
  fire_count: integer('fire_count').default(0).notNull(),
  created_by: text('created_by').notNull().references(() => users.id),
  ...timestamps(),
});

// ═══ CONNECTED ACCOUNTS (OAUTH) ═══
export const connectedAccounts = pgTable('connected_accounts', {
  ...id(),
  ...orgId(),
  user_id: text('user_id').notNull().references(() => users.id),
  provider: text('provider').notNull(), // 'google_calendar', 'github'
  provider_account_id: text('provider_account_id'),
  access_token_encrypted: text('access_token_encrypted').notNull(),
  refresh_token_encrypted: text('refresh_token_encrypted'),
  token_expires_at: timestamp('token_expires_at'),
  scopes: text('scopes'),
  metadata: jsonb('metadata'), // provider-specific data (github org, calendar metadata, etc.)
  last_sync_at: timestamp('last_sync_at'),
  sync_error: text('sync_error'),
  ...timestamps(),
}, (t) => [
  uniqueIndex('connected_account_unique').on(t.user_id, t.provider),
]);

// ═══ UNIFIED EVENTS TABLE (CONNECTED TOOL DATA) ═══
export const events = pgTable('events', {
  ...id(),
  ...orgId(),
  source: eventSourceEnum('source').notNull(),
  event_type: text('event_type').notNull(), // 'calendar_event', 'pr_opened', 'pr_merged'
  external_id: text('external_id'), // ID in the source system
  title: text('title'),
  body: text('body'),
  url: text('url'), // deep link back to source
  actor: text('actor'), // who did it (name or email)
  timestamp: timestamp('timestamp').notNull(),
  metadata: jsonb('metadata').notNull(), // full payload from source
  user_id: text('user_id').references(() => users.id), // which of our users this belongs to
  connected_account_id: text('connected_account_id').references(() => connectedAccounts.id),
  ...timestamps(),
}, (t) => [
  index('event_org_idx').on(t.org_id),
  index('event_source_idx').on(t.source),
  index('event_timestamp_idx').on(t.timestamp),
  index('event_type_idx').on(t.event_type),
  uniqueIndex('event_external_unique').on(t.source, t.external_id),
]);

// ═══ ICS CALENDAR SUBSCRIPTIONS ═══
// Inbound: a user pastes their secret ICS feed URL (Google "Secret address",
// iCloud public URL, Outlook ICS) and the worker polls every
// sync_interval_min, upserting events with source='ics'. See migration 0062.
export const icsSubscriptions = pgTable('ics_subscriptions', {
  ...id(),
  ...orgId(),
  user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  ics_url: text('ics_url').notNull(),
  label: text('label'),
  sync_interval_min: integer('sync_interval_min').notNull().default(15),
  is_active: boolean('is_active').notNull().default(true),
  last_synced_at: timestamp('last_synced_at'),
  last_error: text('last_error'),
  last_event_count: integer('last_event_count'),
  ...timestamps(),
}, (t) => [
  index('ics_subscriptions_user_idx').on(t.user_id),
  index('ics_subscriptions_org_idx').on(t.org_id),
]);

// ═══ REMINDERS ═══
export const reminders = pgTable('reminders', {
  ...id(),
  ...orgId(),
  user_id: text('user_id').notNull().references(() => users.id),
  message: text('message').notNull(),
  remind_at: timestamp('remind_at').notNull(),
  source_message_id: text('source_message_id').references(() => messages.id),
  is_sent: boolean('is_sent').default(false).notNull(),
  ...timestamps(),
});

// ═══ PINNED MESSAGES ═══
export const pinnedMessages = pgTable('pinned_messages', {
  ...id(),
  message_id: text('message_id').notNull().references(() => messages.id),
  space_id: text('space_id').notNull().references(() => spaces.id),
  pinned_by: text('pinned_by').notNull().references(() => users.id),
  pinned_at: timestamp('pinned_at').defaultNow().notNull(),
}, (t) => [
  uniqueIndex('pinned_message_unique').on(t.message_id, t.space_id),
]);

// ═══ SCHEDULED MESSAGES ═══
export const scheduledMessages = pgTable('scheduled_messages', {
  ...id(),
  ...orgId(),
  user_id: text('user_id').notNull().references(() => users.id),
  space_id: text('space_id').notNull().references(() => spaces.id),
  content: text('content').notNull(),
  scheduled_for: timestamp('scheduled_for').notNull(),
  status: text('status').default('pending').notNull(), // 'pending', 'sending', 'sent', 'cancelled'
  sent_at: timestamp('sent_at'),
  ...timestamps(),
});

// ═══ CANVASES ═══
export const canvases = pgTable('canvases', {
  ...id(),
  ...orgId(),
  space_id: text('space_id').notNull().references(() => spaces.id).unique(),
  title: text('title').default('Canvas').notNull(),
  content: jsonb('content'), // TipTap JSON document
  last_edited_by: text('last_edited_by').references(() => users.id),
  last_edited_at: timestamp('last_edited_at'),
  ...timestamps(),
});

// ═══ MESSAGE BOOKMARKS (Saved Messages) ═══
export const messageBookmarks = pgTable('message_bookmarks', {
  ...id(),
  ...orgId(),
  user_id: text('user_id').notNull().references(() => users.id),
  message_id: text('message_id').notNull().references(() => messages.id),
  space_id: text('space_id').notNull().references(() => spaces.id),
  ...timestamps(),
}, (table) => [
  uniqueIndex('message_bookmarks_user_message_idx').on(table.user_id, table.message_id),
]);

// ═══ USER GROUPS ═══
export const userGroups = pgTable('user_groups', {
  ...id(),
  ...orgId(),
  name: text('name').notNull(),
  handle: text('handle').notNull(),
  description: text('description'),
  created_by: text('created_by').notNull().references(() => users.id),
  ...timestamps(),
}, (t) => [
  uniqueIndex('user_group_handle_unique').on(t.org_id, t.handle),
]);

export const userGroupMembers = pgTable('user_group_members', {
  ...id(),
  group_id: text('group_id').notNull().references(() => userGroups.id),
  user_id: text('user_id').notNull().references(() => users.id),
}, (t) => [
  uniqueIndex('user_group_member_unique').on(t.group_id, t.user_id),
]);

// Teams are first-class work units. They intentionally do not replace
// user_groups, which remain lightweight @mention/access lists.
export const teams = pgTable('teams', {
  ...id(),
  ...orgId(),
  name: text('name').notNull(),
  handle: text('handle').notNull(),
  description: text('description'),
  type: text('type').default('functional').notNull(),
  visibility: teamVisibilityEnum('visibility').default('org').notNull(),
  avatar_url: text('avatar_url'),
  color: text('color'),
  lead_user_id: text('lead_user_id').references(() => users.id, { onDelete: 'set null' }),
  default_space_id: text('default_space_id').references(() => spaces.id, { onDelete: 'set null' }),
  is_archived: boolean('is_archived').default(false).notNull(),
  created_by: text('created_by').references(() => users.id, { onDelete: 'set null' }),
  ...timestamps(),
}, (t) => [
  uniqueIndex('teams_org_handle_unique').on(t.org_id, t.handle),
  index('teams_org_idx').on(t.org_id),
  index('teams_org_archived_idx').on(t.org_id, t.is_archived),
  index('teams_lead_idx').on(t.lead_user_id),
]);

export const teamMembers = pgTable('team_members', {
  ...id(),
  ...orgId(),
  team_id: text('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: teamRoleEnum('role').default('member').notNull(),
  joined_at: timestamp('joined_at').defaultNow().notNull(),
  ...timestamps(),
}, (t) => [
  uniqueIndex('team_members_unique').on(t.team_id, t.user_id),
  index('team_members_org_idx').on(t.org_id),
  index('team_members_team_idx').on(t.team_id),
  index('team_members_user_idx').on(t.user_id),
]);

export const teamResources = pgTable('team_resources', {
  ...id(),
  ...orgId(),
  team_id: text('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  resource_type: teamResourceTypeEnum('resource_type').notNull(),
  resource_id: text('resource_id').notNull(),
  label: text('label'),
  created_by: text('created_by').references(() => users.id, { onDelete: 'set null' }),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  uniqueIndex('team_resources_unique').on(t.team_id, t.resource_type, t.resource_id),
  index('team_resources_org_idx').on(t.org_id),
  index('team_resources_team_idx').on(t.team_id),
  index('team_resources_resource_idx').on(t.resource_type, t.resource_id),
]);

export const teamDashboardSnapshots = pgTable('team_dashboard_snapshots', {
  ...id(),
  ...orgId(),
  team_id: text('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  snapshot_type: text('snapshot_type').notNull(),
  payload_json: jsonb('payload_json').notNull(),
  generated_at: timestamp('generated_at').defaultNow().notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  index('team_snapshots_org_idx').on(t.org_id),
  index('team_snapshots_team_type_idx').on(t.team_id, t.snapshot_type, t.generated_at),
]);

// ═══ CUSTOM EMOJI ═══
export const customEmoji = pgTable('custom_emoji', {
  ...id(),
  ...orgId(),
  name: text('name').notNull(),
  image_url: text('image_url').notNull(),
  uploaded_by: text('uploaded_by').notNull().references(() => users.id),
  ...timestamps(),
}, (t) => [
  uniqueIndex('custom_emoji_name_unique').on(t.org_id, t.name),
]);

// ═══ WORKFLOW RULES ═══
export const workflowRules = pgTable('workflow_rules', {
  ...id(),
  ...orgId(),
  name: text('name').notNull(),
  trigger_type: text('trigger_type').notNull(), // 'keyword_in_message', 'new_member_joins', 'reaction_added'
  trigger_config: jsonb('trigger_config').notNull(),
  action_type: text('action_type').notNull(), // 'create_task', 'send_message', 'notify_user'
  action_config: jsonb('action_config').notNull(),
  created_by: text('created_by').notNull().references(() => users.id),
  is_active: boolean('is_active').default(true).notNull(),
  ...timestamps(),
});

export const workflowRuns = pgTable('workflow_runs', {
  ...id(),
  rule_id: text('rule_id').notNull().references(() => workflowRules.id),
  triggered_by_message_id: text('triggered_by_message_id').references(() => messages.id),
  triggered_by_user_id: text('triggered_by_user_id').references(() => users.id),
  result: jsonb('result'),
  status: text('status').notNull(), // 'success', 'failed'
  executed_at: timestamp('executed_at').defaultNow().notNull(),
});

// Durable orchestration ledger for scheduled product automations. Code owns
// scheduling, permissions, retries, and delivery; agents may own synthesis.
export const automationRuns = pgTable('automation_runs', {
  ...id(),
  ...orgId(),
  kind: text('kind').notNull(), // 'standup' | 'meeting_prep'
  subject_id: text('subject_id'), // event id, local date, or another stable subject
  user_id: text('user_id').references(() => users.id, { onDelete: 'set null' }),
  agent_employee_id: text('agent_employee_id'),
  idempotency_key: text('idempotency_key').notNull(),
  scheduled_for: timestamp('scheduled_for').notNull(),
  status: text('status').default('scheduled').notNull(),
  generator: text('generator').default('native').notNull(), // native | agent | fallback
  context: jsonb('context').$type<Record<string, unknown>>().notNull().default({}),
  output: jsonb('output').$type<Record<string, unknown>>(),
  result_entity_id: text('result_entity_id'),
  error: text('error'),
  started_at: timestamp('started_at'),
  completed_at: timestamp('completed_at'),
  ...timestamps(),
}, (t) => [
  uniqueIndex('automation_runs_idempotency_unique').on(t.org_id, t.idempotency_key),
  index('automation_runs_org_kind_status_idx').on(t.org_id, t.kind, t.status),
  index('automation_runs_scheduled_idx').on(t.scheduled_for),
]);

// ═══ ONBOARDING STATE ═══
export const onboardingState = pgTable('onboarding_state', {
  ...id(),
  user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }).unique(),
  org_created: boolean('org_created').default(false),
  profile_set: boolean('profile_set').default(false),
  first_space_created: boolean('first_space_created').default(false),
  first_message_sent: boolean('first_message_sent').default(false),
  first_invite_sent: boolean('first_invite_sent').default(false),
  first_task_created: boolean('first_task_created').default(false),
  agent_tried: boolean('agent_tried').default(false),
  completed: boolean('completed').default(false),
  ...timestamps(),
});

// ═══ STANDUPS ═══
export const standups = pgTable('standups', {
  ...id(),
  ...orgId(),
  date: timestamp('date').notNull(),
  generated_by: text('generated_by').notNull(), // user_id or 'system'
  summary: text('summary').notNull(),
  raw_data: jsonb('raw_data'),
  ...timestamps(),
});

// ═══ AGENT: MEMORY ═══
/**
 * @deprecated Migrated to wikiPages in feat/phase2-4-mcp-agents-plans (2026-04-16).
 * Writes stopped in Phase 2 (Tasks 2.2 and 2.3). Reads migrated.
 * Safe to drop after 30 days (2026-05-16) if the deprecation-warning cron
 * continues to report zero new rows. Conversation-scoped agentMemory rows
 * from the native `remember` tool still use this table legitimately.
 */
export const agentMemory = pgTable('agent_memory', {
  ...id(),
  ...orgId(),
  user_id: text('user_id').notNull().references(() => users.id),
  conversation_id: text('conversation_id'), // now a space_id (FK dropped in 0065)
  scope: text('scope').notNull(), // 'conversation' | 'user' | 'org'
  key: text('key').notNull(),
  value: text('value').notNull(),
  ...timestamps(),
}, (t) => [
  uniqueIndex('agent_memory_upsert_unique').on(t.user_id, t.conversation_id, t.key),
]);

// ═══ CROSS REFERENCES ═══
export const crossReferences = pgTable('cross_references', {
  ...id(),
  ...orgId(),
  source_type: text('source_type').notNull(), // 'message' | 'task' | 'event'
  source_id: text('source_id').notNull(),
  target_type: text('target_type').notNull(), // 'message' | 'task' | 'event'
  target_id: text('target_id').notNull(),
  context: text('context'), // why they're linked
  created_by: text('created_by').notNull().references(() => users.id),
  ...timestamps(),
}, (t) => [
  index('cross_ref_source_idx').on(t.source_type, t.source_id),
  index('cross_ref_target_idx').on(t.target_type, t.target_id),
  uniqueIndex('cross_ref_unique_edge').on(t.source_type, t.source_id, t.target_type, t.target_id),
]);

// ═══ DUPLICATE FLAGS ═══
/**
 * Dedup table for duplicate-detect worker. The pair (task_a_id, task_b_id)
 * is stored in lexicographic order (task_a_id < task_b_id) so a single
 * unique constraint covers both orderings. Insert with onConflictDoNothing
 * to atomically claim a flag — the "no row returned" signal tells the
 * worker the pair was already flagged and to skip the notification.
 */
export const duplicateFlags = pgTable('duplicate_flags', {
  ...id(),
  org_id: text('org_id').notNull().references(() => orgs.id),
  task_a_id: text('task_a_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  task_b_id: text('task_b_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  similarity: numeric('similarity'),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  uniqueIndex('duplicate_flags_pair_unique').on(t.task_a_id, t.task_b_id),
  index('duplicate_flags_org_idx').on(t.org_id),
  check('duplicate_flags_order_check', sql`${t.task_a_id} < ${t.task_b_id}`),
]);

// ═══ AUDIT LOG ═══
export const auditLog = pgTable('audit_log', {
  ...id(),
  ...orgId(),
  actor_type: text('actor_type').notNull(), // 'user' | 'agent'
  actor_id: text('actor_id').notNull(),
  action: text('action').notNull(),
  entity_type: text('entity_type').notNull(),
  entity_id: text('entity_id').notNull(),
  before_state: jsonb('before_state'),
  after_state: jsonb('after_state'),
  metadata: jsonb('metadata'),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  index('audit_log_entity_idx').on(t.entity_type, t.entity_id),
  index('audit_log_actor_idx').on(t.actor_id),
]);

// ═══ AGENT: NUDGES ═══
export const agentNudges = pgTable('agent_nudges', {
  ...id(),
  ...orgId(),
  user_id: text('user_id').notNull().references(() => users.id),
  task_id: text('task_id').notNull().references(() => tasks.id),
  nudge_type: text('nudge_type').notNull(), // 'stalled' | 'overdue' | 'unassigned'
  message: text('message').notNull(),
  is_dismissed: boolean('is_dismissed').default(false).notNull(),
  ...timestamps(),
});

// ═══ JOB QUEUE (Postgres-based background jobs) ═══
export const jobQueue = pgTable('job_queue', {
  ...id(),
  // System-wide jobs (for example cron scans) intentionally have no org.
  // Product jobs should set this so queue health and dedupe remain tenant-aware.
  org_id: text('org_id'),
  queue: text('queue').notNull(), // 'agent-jobs' | 'scheduled-jobs'
  name: text('name').notNull(), // job name like 'agent-reply', 'standup-generate'
  data: jsonb('data').notNull(), // job payload
  status: text('status').default('pending').notNull(), // 'pending' | 'running' | 'completed' | 'failed'
  attempts: integer('attempts').default(0).notNull(),
  max_attempts: integer('max_attempts').default(3).notNull(),
  run_at: timestamp('run_at').defaultNow().notNull(), // for delayed jobs
  started_at: timestamp('started_at'),
  completed_at: timestamp('completed_at'),
  error: text('error'), // last error message
  cron_key: text('cron_key'), // for repeatable jobs, prevents duplicates
  // Idempotency is retention-bound: terminal rows keep their key until the
  // queue retention sweep removes them.
  dedupe_key: text('dedupe_key'),
  locked_by: text('locked_by'),
  lock_token: text('lock_token'),
  lock_expires_at: timestamp('lock_expires_at'),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  index('job_queue_poll_idx').on(t.status, t.queue, t.run_at),
  index('job_queue_org_idx').on(t.org_id),
  index('job_queue_lease_idx').on(t.status, t.lock_expires_at),
  // Drizzle cannot currently express PostgreSQL's NULLS NOT DISTINCT index
  // option. COALESCE gives fresh `db:push-full` installs the same semantics as
  // the supported upgrade migration's (org_id, dedupe_key) index.
  uniqueIndex('job_queue_dedupe_unique')
    .on(sql`COALESCE(${t.org_id}, '')`, t.dedupe_key)
    .where(sql`${t.dedupe_key} IS NOT NULL`),
  uniqueIndex('job_queue_active_cron_unique')
    .on(t.cron_key)
    .where(sql`${t.cron_key} IS NOT NULL AND ${t.status} IN ('pending', 'running')`),
]);

// ═══ MEETING BRIEFS ═══
export const meetingBriefs = pgTable('meeting_briefs', {
  ...id(),
  ...orgId(),
  user_id: text('user_id').notNull().references(() => users.id),
  event_id: text('event_id').notNull().references(() => events.id),
  brief_text: text('brief_text').notNull(),
  ...timestamps(),
}, (t) => [
  uniqueIndex('meeting_briefs_event_user_unique').on(t.event_id, t.user_id),
]);

// ═══ PEOPLE GRAPH: INTERACTIONS ═══
export const peopleInteractions = pgTable('people_interactions', {
  ...id(),
  ...orgId(),
  user_a_id: text('user_a_id').notNull().references(() => users.id),
  user_b_id: text('user_b_id').notNull().references(() => users.id),
  interaction_count: integer('interaction_count').default(0).notNull(),
  recency_weighted_score: real('recency_weighted_score').default(0).notNull(),
  dm_count: integer('dm_count').default(0).notNull(),
  shared_space_count: integer('shared_space_count').default(0).notNull(),
  mention_count: integer('mention_count').default(0).notNull(),
  thread_co_participation: integer('thread_co_participation').default(0).notNull(),
  last_interaction_at: timestamp('last_interaction_at'),
  updated_at: timestamp('updated_at').defaultNow().notNull().$onUpdate(() => new Date()),
}, (t) => [
  uniqueIndex('people_interaction_unique').on(t.org_id, t.user_a_id, t.user_b_id),
  index('people_interaction_org_idx').on(t.org_id),
]);

// ═══ PEOPLE GRAPH: EXPERTISE ═══
export const peopleExpertise = pgTable('people_expertise', {
  ...id(),
  ...orgId(),
  user_id: text('user_id').notNull().references(() => users.id),
  topic: text('topic').notNull(),
  message_count: integer('message_count').default(0).notNull(),
  question_answered_count: integer('question_answered_count').default(0).notNull(),
  mentioned_for_help_count: integer('mentioned_for_help_count').default(0).notNull(),
  tasks_completed_count: integer('tasks_completed_count').default(0).notNull(),
  expertise_score: real('expertise_score').default(0).notNull(),
  first_seen_at: timestamp('first_seen_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull().$onUpdate(() => new Date()),
}, (t) => [
  uniqueIndex('people_expertise_unique').on(t.org_id, t.user_id, t.topic),
  index('people_expertise_org_idx').on(t.org_id),
]);

// ═══ PEOPLE GRAPH: INFLUENCE ═══
export const peopleInfluence = pgTable('people_influence', {
  ...id(),
  ...orgId(),
  user_id: text('user_id').notNull().references(() => users.id),
  influence_type: text('influence_type').notNull(), // 'decision_maker' | 'blocker_resolver' | 'reviewer' | 'connector' | 'mentor'
  context: text('context'),
  score: real('score').notNull(),
  evidence_count: integer('evidence_count').notNull(),
  evidence_samples: jsonb('evidence_samples'),
  updated_at: timestamp('updated_at').defaultNow().notNull().$onUpdate(() => new Date()),
}, (t) => [
  index('people_influence_org_idx').on(t.org_id),
  index('people_influence_user_idx').on(t.user_id),
]);

// ═══ PEOPLE GRAPH: PATTERNS ═══
export const peoplePatterns = pgTable('people_patterns', {
  ...id(),
  ...orgId(),
  user_id: text('user_id').notNull().references(() => users.id),
  pattern_type: text('pattern_type').notNull(), // 'active_hours' | 'response_time' | 'communication_style' | 'activity_trend' | 'collaboration_preference'
  pattern_data: jsonb('pattern_data'),
  baseline_data: jsonb('baseline_data'),
  confidence: real('confidence'),
  updated_at: timestamp('updated_at').defaultNow().notNull().$onUpdate(() => new Date()),
}, (t) => [
  uniqueIndex('people_pattern_unique').on(t.org_id, t.user_id, t.pattern_type),
]);

// ═══ PEOPLE GRAPH: RELATIONSHIPS ═══
export const peopleRelationships = pgTable('people_relationships', {
  ...id(),
  ...orgId(),
  user_a_id: text('user_a_id').notNull().references(() => users.id),
  user_b_id: text('user_b_id').notNull().references(() => users.id),
  relationship_type: text('relationship_type').notNull(), // 'close_collaborator' | 'mentor_mentee' | 'tension' | 'delegation_chain' | 'cross_team_bridge' | 'knowledge_dependency'
  strength: real('strength'),
  direction: text('direction'), // 'bidirectional' | 'a_to_b' | 'b_to_a'
  evidence: jsonb('evidence'),
  first_detected_at: timestamp('first_detected_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull().$onUpdate(() => new Date()),
}, (t) => [
  index('people_relationship_org_idx').on(t.org_id),
  uniqueIndex('people_relationships_pair_type_unique').on(t.user_a_id, t.user_b_id, t.relationship_type),
]);

// ═══ PEOPLE GRAPH: TEAM HEALTH SNAPSHOTS ═══
export const teamHealthSnapshots = pgTable('team_health_snapshots', {
  ...id(),
  ...orgId(),
  snapshot_date: timestamp('snapshot_date').notNull(),
  team_data: jsonb('team_data'),
  generated_by: text('generated_by'),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  index('team_health_org_idx').on(t.org_id),
]);

// ═══ PEOPLE GRAPH: 1:1 PREPS ═══
export const oneonePreps = pgTable('oneone_preps', {
  ...id(),
  ...orgId(),
  manager_id: text('manager_id').notNull().references(() => users.id),
  report_id: text('report_id').notNull().references(() => users.id),
  meeting_date: timestamp('meeting_date'),
  prep_content: jsonb('prep_content'),
  status: text('status').default('generated').notNull(),
  ...timestamps(),
}, (t) => [
  index('oneone_prep_org_idx').on(t.org_id),
  index('oneone_prep_manager_idx').on(t.manager_id),
]);

// ═══ PEOPLE GRAPH: BURNOUT ALERTS ═══
// PRIVACY: This data is sensitive. Never expose in API responses except to the manager in alerted_to and the user in user_id.
export const burnoutAlerts = pgTable('burnout_alerts', {
  ...id(),
  ...orgId(),
  user_id: text('user_id').notNull().references(() => users.id),
  alerted_to: text('alerted_to').notNull().references(() => users.id),
  signals: jsonb('signals'),
  confidence: real('confidence'),
  status: text('status').default('active').notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
  acknowledged_at: timestamp('acknowledged_at'),
}, (t) => [
  index('burnout_alert_org_idx').on(t.org_id),
  index('burnout_alert_user_idx').on(t.user_id),
]);

// ═══ NOTE FOLDERS ═══
export const noteFolders = pgTable('note_folders', {
  ...id(),
  ...orgId(),
  user_id: text('user_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  icon: text('icon'),
  parent_folder_id: text('parent_folder_id'),
  sort_order: integer('sort_order').default(0).notNull(),
  is_deleted: boolean('is_deleted').default(false).notNull(),
  ...timestamps(),
}, (t) => [
  index('note_folder_user_idx').on(t.user_id),
]);

// ═══ NOTES ═══
export const notes = pgTable('notes', {
  ...id(),
  ...orgId(),
  user_id: text('user_id').notNull().references(() => users.id),
  folder_id: text('folder_id').references(() => noteFolders.id),
  title: text('title').default('').notNull(),
  content: text('content'), // TipTap HTML
  icon: text('icon'), // emoji icon for the note
  is_pinned: boolean('is_pinned').default(false).notNull(),
  is_template: boolean('is_template').default(false).notNull(),
  is_deleted: boolean('is_deleted').default(false).notNull(),
  version: integer('version').default(1).notNull(),
  visibility: text('visibility').default('private').notNull(), // 'private' | 'org' | 'space'
  visibility_space_id: text('visibility_space_id').references(() => spaces.id, { onDelete: 'set null' }),
  ...timestamps(),
}, (t) => [
  index('note_org_idx').on(t.org_id),
  index('note_user_idx').on(t.user_id),
  index('note_updated_idx').on(t.updated_at),
  index('note_folder_idx').on(t.folder_id),
  index('note_visibility_idx').on(t.visibility),
]);

// ═══ NOTE VERSIONS ═══
export const noteVersions = pgTable('note_versions', {
  ...id(),
  note_id: text('note_id').notNull().references(() => notes.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  title: text('title').notNull(),
  content: text('content'),
  edited_by: text('edited_by'),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  index('note_versions_note_idx').on(t.note_id),
  uniqueIndex('note_versions_unique').on(t.note_id, t.version),
]);

// ═══ NOTE SHARES ═══
export const noteShares = pgTable('note_shares', {
  ...id(),
  note_id: text('note_id').notNull().references(() => notes.id, { onDelete: 'cascade' }),
  shared_with_user_id: text('shared_with_user_id').notNull().references(() => users.id),
  permission: text('permission').default('view').notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  uniqueIndex('note_shares_unique').on(t.note_id, t.shared_with_user_id),
  index('note_shares_user_idx').on(t.shared_with_user_id),
]);

// ═══ TAGS ═══
export const tags = pgTable('tags', {
  ...id(),
  ...orgId(),
  name: text('name').notNull(), // lowercase, no spaces: "launch", "q3-planning"
  color: text('color'), // hex color for visual distinction
  ...timestamps(),
}, (t) => [
  uniqueIndex('tag_name_unique').on(t.org_id, t.name),
]);

// ═══ ENTITY TAGS (junction table) ═══
export const entityTagTypeEnum = pgEnum('entity_tag_type', ['message', 'task', 'clip', 'daily_note', 'note']);

export const entityTags = pgTable('entity_tags', {
  ...id(),
  ...orgId(),
  tag_id: text('tag_id').notNull().references(() => tags.id, { onDelete: 'cascade' }),
  entity_type: entityTagTypeEnum('entity_type').notNull(),
  entity_id: text('entity_id').notNull(),
  ...timestamps(),
}, (t) => [
  uniqueIndex('entity_tag_unique').on(t.tag_id, t.entity_type, t.entity_id),
  index('entity_tag_org_idx').on(t.org_id, t.tag_id),
  index('entity_tag_entity_idx').on(t.entity_type, t.entity_id),
]);

// ═══ CLIPS (Async voice/video clips + Live huddle recordings) ═══
export const clipStatusEnum = pgEnum('clip_status', ['uploading', 'transcribing', 'summarizing', 'ready', 'failed']);
export const clipModeEnum = pgEnum('clip_mode', ['async', 'live']);
export const clipContextTypeEnum = pgEnum('clip_context_type', ['space', 'task', 'thread', 'project']);

export const clips = pgTable('clips', {
  ...id(),
  ...orgId(),
  space_id: text('space_id').references(() => spaces.id),
  message_id: text('message_id').references(() => messages.id), // the message that displays this clip card
  context_type: clipContextTypeEnum('context_type').notNull(),
  context_id: text('context_id').notNull(), // ID of the task, thread, project, or space
  mode: clipModeEnum('mode').default('async').notNull(),
  created_by: text('created_by').notNull().references(() => users.id),
  duration_s: integer('duration_s'),
  file_key: text('file_key').notNull(), // storage path (local or S3)
  file_size: integer('file_size'), // bytes
  mime_type: text('mime_type').default('audio/webm').notNull(),
  status: clipStatusEnum('status').default('uploading').notNull(),
  transcript: text('transcript'), // full plain-text transcript
  segments: jsonb('segments'), // timestamped segments: [{ start, end, text, speaker? }]
  summary: jsonb('summary'), // { tldr, decisions[], actions[], blockers[] }
  participants: jsonb('participants'), // [{ id, name }]
  whisper_model: text('whisper_model'), // which model was used for transcription
  error: text('error'), // last processing error
  is_deleted: boolean('is_deleted').default(false).notNull(),
  ...timestamps(),
}, (t) => [
  index('clip_org_idx').on(t.org_id),
  index('clip_space_idx').on(t.space_id),
  index('clip_context_idx').on(t.context_type, t.context_id),
  index('clip_status_idx').on(t.status),
  index('clip_created_by_idx').on(t.created_by),
]);

// ═══ PEOPLE GRAPH: MANAGER SETTINGS ═══
export const managerSettings = pgTable('manager_settings', {
  ...id(),
  user_id: text('user_id').notNull().references(() => users.id),
  ...orgId(),
  team_pulse_frequency: text('team_pulse_frequency').default('daily').notNull(),
  oneone_prep_enabled: boolean('oneone_prep_enabled').default(true).notNull(),
  burnout_alerts_enabled: boolean('burnout_alerts_enabled').default(true).notNull(),
  overload_threshold: integer('overload_threshold').default(6).notNull(),
  blocked_threshold_hours: integer('blocked_threshold_hours').default(24).notNull(),
  weekly_digest_enabled: boolean('weekly_digest_enabled').default(true).notNull(),
  ...timestamps(),
}, (t) => [
  uniqueIndex('manager_settings_unique').on(t.user_id, t.org_id),
]);

// ═══ THREAD READS (track per-user thread read state) ═══
export const threadReads = pgTable('thread_reads', {
  ...id(),
  user_id: text('user_id').notNull().references(() => users.id),
  parent_message_id: text('parent_message_id').notNull().references(() => messages.id),
  last_read_at: timestamp('last_read_at').defaultNow().notNull(),
  ...timestamps(),
}, (t) => [
  uniqueIndex('thread_reads_unique').on(t.user_id, t.parent_message_id),
]);

// ═══ MESSAGE VERSIONS (edit history) ═══
export const messageVersions = pgTable('message_versions', {
  ...id(),
  message_id: text('message_id').notNull().references(() => messages.id),
  content: text('content').notNull(),
  edited_at: timestamp('edited_at').defaultNow().notNull(),
});

// ═══ WIKI PAGES (LLM Wiki — structured knowledge) ═══
export const wikiPages = pgTable('wiki_pages', {
  ...id(),
  ...orgId(),
  scope: wikiPageScopeEnum('scope').default('org').notNull(),
  space_id: text('space_id').references(() => spaces.id),
  origin_space_id: text('origin_space_id').references(() => spaces.id, { onDelete: 'set null' }),
  origin_message_id: text('origin_message_id').references(() => messages.id, { onDelete: 'set null' }),
  origin_user_id: text('origin_user_id').references(() => users.id, { onDelete: 'set null' }),
  created_via: text('created_via'),
  user_id: text('user_id').references(() => users.id),
  agent_employee_id: text('agent_employee_id'),
  type: wikiPageTypeEnum('type').notNull(),
  title: text('title').notNull(),
  slug: text('slug').notNull(),
  summary: text('summary'),
  content: text('content').notNull(),
  metadata: jsonb('metadata'),
  confidence: real('confidence').default(1.0).notNull(),
  version: integer('version').default(1).notNull(),
  previous_content: text('previous_content'),
  is_deleted: boolean('is_deleted').default(false).notNull(),
  embedding: vector('embedding', { dimensions: 1536 }),
  tags: text('tags').array().default(sql`ARRAY[]::text[]`),
  referenced_user_ids: text('referenced_user_ids').array().default(sql`ARRAY[]::text[]`),
  ...timestamps(),
}, (t) => [
  uniqueIndex('wiki_pages_org_slug').on(t.org_id, t.slug),
  index('wiki_pages_org_type').on(t.org_id, t.type),
  index('wiki_pages_org_scope').on(t.org_id, t.scope),
  index('wiki_pages_org_origin_space').on(t.org_id, t.origin_space_id),
  index('wiki_pages_org_scope_space').on(t.org_id, t.scope, t.space_id),
  index('wiki_pages_org_created_via').on(t.org_id, t.created_via),
  index('wiki_pages_tags_gin').on(t.tags),
  index('wiki_pages_ref_users_gin').on(t.referenced_user_ids),
]);

export const wikiLinks = pgTable('wiki_links', {
  ...id(),
  ...orgId(),
  source_page_id: text('source_page_id').notNull().references(() => wikiPages.id, { onDelete: 'cascade' }),
  target_page_id: text('target_page_id').notNull().references(() => wikiPages.id, { onDelete: 'cascade' }),
  context: text('context'),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  uniqueIndex('wiki_links_unique').on(t.source_page_id, t.target_page_id),
  index('wiki_links_source').on(t.source_page_id),
  index('wiki_links_target').on(t.target_page_id),
]);

export const wikiCitations = pgTable('wiki_citations', {
  ...id(),
  org_id: text('org_id').references(() => orgs.id, { onDelete: 'cascade' }),
  page_id: text('page_id').notNull().references(() => wikiPages.id, { onDelete: 'cascade' }),
  source_type: text('source_type').notNull(),
  source_id: text('source_id').notNull(),
  source_space_id: text('source_space_id').references(() => spaces.id, { onDelete: 'set null' }),
  source_user_id: text('source_user_id').references(() => users.id, { onDelete: 'set null' }),
  excerpt: text('excerpt'),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  index('wiki_citations_page').on(t.page_id),
  index('wiki_citations_org_source_space').on(t.org_id, t.source_space_id),
  index('wiki_citations_source').on(t.source_type, t.source_id),
]);

export const wikiMemorySyncs = pgTable('wiki_memory_syncs', {
  ...id(),
  ...orgId(),
  agent_employee_id: text('agent_employee_id').notNull().references(() => agentEmployees.id, { onDelete: 'cascade' }),
  idempotency_key: text('idempotency_key').notNull(),
  content_digest: text('content_digest').notNull(),
  page_id: text('page_id').notNull().references(() => wikiPages.id, { onDelete: 'cascade' }),
  page_version: integer('page_version').notNull(),
  runtime_session_id: text('runtime_session_id'),
  provenance: jsonb('provenance'),
  ...timestamps(),
}, (t) => [
  uniqueIndex('wiki_memory_sync_identity_unique').on(t.org_id, t.agent_employee_id, t.idempotency_key),
  index('wiki_memory_sync_page_idx').on(t.page_id),
  index('wiki_memory_sync_employee_updated_idx').on(t.org_id, t.agent_employee_id, t.updated_at),
]);

export const wikiOpsLog = pgTable('wiki_ops_log', {
  ...id(),
  ...orgId(),
  operation: text('operation').notNull(),
  page_id: text('page_id').references(() => wikiPages.id),
  details: jsonb('details'),
  performed_by: text('performed_by'),
  created_at: timestamp('created_at').defaultNow().notNull(),
});

// ═══ WIKI PAGE VERSIONS (full history) ═══
export const wikiPageVersions = pgTable('wiki_page_versions', {
  ...id(),
  page_id: text('page_id').notNull().references(() => wikiPages.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  title: text('title').notNull(),
  content: text('content').notNull(),
  summary: text('summary'),
  edited_by: text('edited_by'),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  index('wiki_page_versions_page').on(t.page_id),
  uniqueIndex('wiki_page_versions_unique').on(t.page_id, t.version),
]);

// ═══ MCP CONNECTIONS ═══
export const mcpConnections = pgTable('mcp_connections', {
  ...id(),
  ...orgId(),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  server_url: text('server_url'),
  transport: mcpTransportEnum('transport').notNull(),
  stdio_command: text('stdio_command'),
  stdio_args: jsonb('stdio_args'),
  auth_type: text('auth_type').notNull().default('none'),
  auth_config_encrypted: jsonb('auth_config_encrypted'),
  is_active: boolean('is_active').default(true).notNull(),
  last_connected_at: timestamp('last_connected_at'),
  connection_error: text('connection_error'),
  tools_cache: jsonb('tools_cache'),
  tools_cached_at: timestamp('tools_cached_at'),
  default_trust_tier: approvalTierEnum('default_trust_tier').default('full').notNull(),
  enabled_tools: text('enabled_tools').array(),
  app_run_authorization_version: integer('app_run_authorization_version').default(1).notNull(),
  created_by: text('created_by').notNull().references(() => users.id),
  ...timestamps(),
}, (t) => [
  unique('mcp_connections_org_id_id_unique').on(t.org_id, t.id),
  index('mcp_conn_org_idx').on(t.org_id),
  uniqueIndex('mcp_conn_slug_unique').on(t.org_id, t.slug),
]);

// ═══ MCP TOOL OVERRIDES ═══
export const mcpToolOverrides = pgTable('mcp_tool_overrides', {
  ...id(),
  ...orgId(),
  mcp_connection_id: text('mcp_connection_id').notNull().references(() => mcpConnections.id, { onDelete: 'cascade' }),
  tool_name: text('tool_name').notNull(),
  trust_tier_override: approvalTierEnum('trust_tier_override'),
  is_disabled: boolean('is_disabled').default(false).notNull(),
  app_run_authorization_version: integer('app_run_authorization_version').default(1).notNull(),
  ...timestamps(),
}, (t) => [
  foreignKey({
    columns: [t.org_id, t.mcp_connection_id],
    foreignColumns: [mcpConnections.org_id, mcpConnections.id],
    name: 'mcp_tool_overrides_org_connection_fk',
  }).onDelete('cascade'),
  uniqueIndex('mcp_tool_override_unique').on(t.mcp_connection_id, t.tool_name),
]);

// ═══ AGENT EMPLOYEES ═══
export const agentEmployees = pgTable('agent_employees', {
  ...id(),
  ...orgId(),
  user_id: text('user_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  role: agentEmployeeRoleEnum('role').notNull(),
  avatar_url: text('avatar_url'),
  system_prompt: text('system_prompt').notNull(),
  expertise_description: text('expertise_description'),
  starter_prompts: text('starter_prompts').array(),
  // native_tools[] removed in Task 4.12 (migration 0038) — per-employee
  // tool selection moved to the skills primitive (migrations 0035-0037).
  mcp_connection_ids: text('mcp_connection_ids').array(),
  disabled_tools: text('disabled_tools').array(),
  space_ids: text('space_ids').array(),
  project_ids: text('project_ids').array(),
  trust_level: trustLevelEnum('trust_level').default('conservative').notNull(),
  max_daily_actions: integer('max_daily_actions').default(50).notNull(),
  daily_action_count: integer('daily_action_count').default(0).notNull(),
  daily_action_reset_at: timestamp('daily_action_reset_at'),
  heartbeat_enabled: boolean('heartbeat_enabled').default(false).notNull(),
  heartbeat_interval_min: integer('heartbeat_interval_min').default(30).notNull(),
  heartbeat_config: jsonb('heartbeat_config'),
  /**
   * Task 8.2 — per-employee overlay for the heartbeat prompt builder.
   * Shape (all fields optional):
   *   {
   *     checklist?: string[];          // extra checklist items
   *     cadence_minutes?: number;      // per-employee cadence override (Task 8.3)
   *   }
   */
  heartbeat_overrides: jsonb('heartbeat_overrides'),
  /**
   * Task 8.5 — daily cost guardrails. `daily_cost_cents` is reset at UTC
   * midnight alongside `daily_action_count`; `daily_budget_cents` is the
   * soft cap enforced by the heartbeat + trigger dispatchers. Default
   * 10000 (=$100/day) mirrors the PR plan, tunable per-employee via the
   * PATCH endpoint.
   */
  daily_budget_cents: integer('daily_budget_cents').default(10000).notNull(),
  daily_cost_cents: integer('daily_cost_cents').default(0).notNull(),
  /**
   * Task 8.5 / 8.6 — circuit breaker. Set by the heartbeat handler after
   * 3 consecutive errors OR by Task 8.6's loop detector; cleared via
   * PATCH { mark_healthy: true }. Blocks every autonomous dispatcher
   * from firing until cleared.
   */
  unhealthy: boolean('unhealthy').default(false).notNull(),
  unhealthy_reason: text('unhealthy_reason'),
  last_heartbeat_at: timestamp('last_heartbeat_at'),
  is_active: boolean('is_active').default(true).notNull(),
  // is_active=false is "pause" (resumable). is_deleted=true is a real
  // soft-delete — the row is hidden from every list endpoint and cannot
  // be restored from the UI. Separate semantics added in migration 0058.
  is_deleted: boolean('is_deleted').default(false).notNull(),
  deleted_at: timestamp('deleted_at'),
  is_byoa: boolean('is_byoa').default(false).notNull(),
  byoa_model_info: text('byoa_model_info'),
  mcp_token_hash: text('mcp_token_hash'),
  // BYOA runtime/control-plane metadata. Deft registers an already-running
  // agent as a workplace employee; it does not own the runtime's identity.
  runtime_kind: text('runtime_kind').default('custom_mcp').notNull(),
  job_title: text('job_title'),
  wake_mode: text('wake_mode').default('manual').notNull(),
  certification_status: text('certification_status').default('token_issued').notNull(),
  last_verified_at: timestamp('last_verified_at'),
  last_mcp_call_at: timestamp('last_mcp_call_at'),
  last_work_outcome_at: timestamp('last_work_outcome_at'),
  connection_notes: text('connection_notes'),
  // trigger_subscriptions is the routing key for the trigger system (e.g.
  // member.joined, cron:standup) — kept as part of Phase 9.
  trigger_subscriptions: text('trigger_subscriptions').array(),
  app_run_authorization_version: integer('app_run_authorization_version').default(1).notNull(),
  created_by: text('created_by').notNull().references(() => users.id),
  ...timestamps(),
}, (t) => [
  uniqueIndex('agent_employee_slug_unique').on(t.org_id, t.slug),
  index('agent_employee_org_idx').on(t.org_id),
]);

// ═══ AGENT: SKILL JUNCTIONS ═══
// Phase 4 Task 4.2 — link skills to the two surfaces that consume them.

// agent_employee_skills: "installed" skills grant the employee tools,
// capability packs, triggers, and prompt additions (per skills.agent_config).
// Agent certification challenges prove an external BYOA runtime can actually
// call Deft tools. They prevent "the agent said it is connected" from becoming
// an operational status without DB evidence.
export const agentCertificationChallenges = pgTable('agent_certification_challenges', {
  ...id(),
  ...orgId(),
  employee_id: text('employee_id').notNull().references(() => agentEmployees.id, { onDelete: 'cascade' }),
  nonce: text('nonce').notNull(),
  required_tools: text('required_tools').array().notNull(),
  status: text('status').default('pending').notNull(),
  failure_reason: text('failure_reason'),
  started_at: timestamp('started_at').defaultNow().notNull(),
  completed_at: timestamp('completed_at'),
  ...timestamps(),
}, (t) => [
  index('agent_cert_employee_idx').on(t.employee_id, t.created_at),
  index('agent_cert_org_status_idx').on(t.org_id, t.status, t.created_at),
]);

// Append-only audit of MCP tool calls made by BYOA employees.
export const agentMcpCallAudit = pgTable('agent_mcp_call_audit', {
  ...id(),
  ...orgId(),
  employee_id: text('employee_id').notNull().references(() => agentEmployees.id, { onDelete: 'cascade' }),
  tool_name: text('tool_name').notNull(),
  success: boolean('success').default(false).notNull(),
  error: text('error'),
  metadata: jsonb('metadata'),
  ...timestamps(),
}, (t) => [
  index('agent_mcp_audit_employee_idx').on(t.employee_id, t.created_at),
  index('agent_mcp_audit_org_tool_idx').on(t.org_id, t.tool_name, t.created_at),
]);

// Personal and agent MCP access tokens. Agent employee tokens are still stored
// on agent_employees for backwards compatibility; this table is the first-class
// home for human-owned AI client tokens and future tokenized MCP principals.
export const mcpTokens = pgTable('mcp_tokens', {
  ...id(),
  ...orgId(),
  user_id: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
  agent_employee_id: text('agent_employee_id').references(() => agentEmployees.id, { onDelete: 'cascade' }),
  principal_kind: text('principal_kind').notNull(), // 'human' | 'agent'
  name: text('name').notNull(),
  token_hash: text('token_hash').notNull(),
  token_prefix: text('token_prefix').notNull(),
  scopes: text('scopes').array().notNull(),
  last_used_at: timestamp('last_used_at'),
  revoked_at: timestamp('revoked_at'),
  app_run_authorization_version: integer('app_run_authorization_version').default(1).notNull(),
  created_by: text('created_by').references(() => users.id),
  ...timestamps(),
}, (t) => [
  index('mcp_tokens_org_idx').on(t.org_id),
  index('mcp_tokens_user_idx').on(t.user_id),
  index('mcp_tokens_agent_idx').on(t.agent_employee_id),
  index('mcp_tokens_prefix_idx').on(t.token_prefix),
]);

// ═══ AGENT CHANNELS ══════════════════════════════════════════════════════════
// Durable delivery plane for always-on BYOA runtimes such as Hermes/OpenClaw.
// MCP remains the tool/action plane; these tables track live workspace events
// that should wake a runtime, plus the runtime's delivery cursor and replies.
export const agentChannelConnections = pgTable('agent_channel_connections', {
  ...id(),
  ...orgId(),
  agent_employee_id: text('agent_employee_id').notNull().references(() => agentEmployees.id, { onDelete: 'cascade' }),
  runtime_kind: text('runtime_kind').default('custom_mcp').notNull(),
  status: text('status').default('disconnected').notNull(),
  protocol_version: text('protocol_version').default('deft.agent_channel.v2').notNull(),
  last_seen_at: timestamp('last_seen_at'),
  last_event_id: text('last_event_id'),
  last_error: text('last_error'),
  paused_at: timestamp('paused_at'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  ...timestamps(),
}, (t) => [
  uniqueIndex('agent_channel_connection_employee_unique').on(t.org_id, t.agent_employee_id),
  index('agent_channel_connection_org_status_idx').on(t.org_id, t.status),
  index('agent_channel_connection_seen_idx').on(t.agent_employee_id, t.last_seen_at),
]);

export const agentChannelTokens = pgTable('agent_channel_tokens', {
  ...id(),
  ...orgId(),
  agent_employee_id: text('agent_employee_id').notNull().references(() => agentEmployees.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  token_hash: text('token_hash').notNull(),
  token_prefix: text('token_prefix').notNull(),
  scopes: jsonb('scopes').$type<string[]>().notNull().default(['channel:read', 'channel:write']),
  is_active: boolean('is_active').default(true).notNull(),
  last_used_at: timestamp('last_used_at'),
  revoked_at: timestamp('revoked_at'),
  created_by: text('created_by').references(() => users.id, { onDelete: 'set null' }),
  ...timestamps(),
}, (t) => [
  index('agent_channel_tokens_org_idx').on(t.org_id),
  index('agent_channel_tokens_employee_idx').on(t.agent_employee_id),
  index('agent_channel_tokens_prefix_idx').on(t.token_prefix),
]);

export const agentChannelEvents = pgTable('agent_channel_events', {
  ...id(),
  ...orgId(),
  agent_employee_id: text('agent_employee_id').notNull().references(() => agentEmployees.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  source_kind: text('source_kind'),
  source_id: text('source_id'),
  space_id: text('space_id').references(() => spaces.id, { onDelete: 'set null' }),
  thread_id: text('thread_id').references(() => messages.id, { onDelete: 'set null' }),
  actor_user_id: text('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  idempotency_key: text('idempotency_key').notNull(),
  status: text('status').default('pending').notNull(),
  delivery_count: integer('delivery_count').default(0).notNull(),
  claim_owner: text('claim_owner'),
  claim_token: text('claim_token'),
  claimed_at: timestamp('claimed_at'),
  lease_expires_at: timestamp('lease_expires_at'),
  delivered_at: timestamp('delivered_at'),
  acked_at: timestamp('acked_at'),
  completed_at: timestamp('completed_at'),
  failed_at: timestamp('failed_at'),
  work_outcome: text('work_outcome'),
  outcome_detail: text('outcome_detail'),
  outcome_at: timestamp('outcome_at'),
  runtime_session_key: text('runtime_session_key'),
  error: text('error'),
  ...timestamps(),
}, (t) => [
  uniqueIndex('agent_channel_event_idempotency_unique').on(t.org_id, t.agent_employee_id, t.idempotency_key),
  index('agent_channel_event_employee_status_idx').on(t.agent_employee_id, t.status, t.created_at),
  index('agent_channel_event_lease_idx').on(t.agent_employee_id, t.status, t.lease_expires_at),
  index('agent_channel_event_outcome_idx').on(t.agent_employee_id, t.work_outcome, t.outcome_at),
  index('agent_channel_event_org_kind_idx').on(t.org_id, t.kind, t.created_at),
  index('agent_channel_event_space_idx').on(t.space_id),
  check('agent_channel_event_claim_shape_check', sql`
    (${t.claim_token} IS NULL AND ${t.claim_owner} IS NULL AND ${t.claimed_at} IS NULL AND ${t.lease_expires_at} IS NULL)
    OR
    (${t.claim_token} IS NOT NULL AND ${t.claim_owner} IS NOT NULL AND ${t.claimed_at} IS NOT NULL)
  `),
  check('agent_channel_event_work_outcome_check', sql`
    ${t.work_outcome} IS NULL
    OR ${t.work_outcome} IN (
      'completed',
      'needs_human',
      'blocked',
      'failed',
      'cancelled',
      'work_completed_handoff_uncertain'
    )
  `),
]);

export const agentChannelCursors = pgTable('agent_channel_cursors', {
  ...id(),
  ...orgId(),
  agent_employee_id: text('agent_employee_id').notNull().references(() => agentEmployees.id, { onDelete: 'cascade' }),
  connection_id: text('connection_id').references(() => agentChannelConnections.id, { onDelete: 'set null' }),
  last_delivered_event_id: text('last_delivered_event_id'),
  last_acked_event_id: text('last_acked_event_id'),
  ...timestamps(),
}, (t) => [
  uniqueIndex('agent_channel_cursor_employee_unique').on(t.org_id, t.agent_employee_id),
  index('agent_channel_cursor_connection_idx').on(t.connection_id),
]);

export const agentChannelSessions = pgTable('agent_channel_sessions', {
  ...id(),
  ...orgId(),
  agent_employee_id: text('agent_employee_id').notNull().references(() => agentEmployees.id, { onDelete: 'cascade' }),
  deft_scope: text('deft_scope').notNull(),
  deft_scope_id: text('deft_scope_id').notNull(),
  runtime_session_key: text('runtime_session_key').notNull(),
  busy_mode: text('busy_mode').default('queue').notNull(),
  last_active_at: timestamp('last_active_at'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  ...timestamps(),
}, (t) => [
  uniqueIndex('agent_channel_session_scope_unique').on(t.org_id, t.agent_employee_id, t.deft_scope, t.deft_scope_id),
  index('agent_channel_session_runtime_idx').on(t.agent_employee_id, t.runtime_session_key),
]);

export const agentChannelDeliveryAttempts = pgTable('agent_channel_delivery_attempts', {
  ...id(),
  ...orgId(),
  agent_employee_id: text('agent_employee_id').notNull().references(() => agentEmployees.id, { onDelete: 'cascade' }),
  event_id: text('event_id').references(() => agentChannelEvents.id, { onDelete: 'cascade' }),
  direction: text('direction').notNull(),
  idempotency_key: text('idempotency_key'),
  status: text('status').notNull(),
  request_json: jsonb('request_json').$type<Record<string, unknown>>(),
  response_json: jsonb('response_json').$type<Record<string, unknown>>(),
  error: text('error'),
  ...timestamps(),
}, (t) => [
  uniqueIndex('agent_channel_attempt_idempotency_unique').on(t.org_id, t.agent_employee_id, t.idempotency_key),
  uniqueIndex('agent_channel_attempt_active_runtime_unique')
    .on(t.org_id, t.agent_employee_id)
    .where(sql`${t.direction} = 'outbound_runtime' AND ${t.status} = 'started'`),
  index('agent_channel_attempt_event_idx').on(t.event_id, t.created_at),
  index('agent_channel_attempt_employee_idx').on(t.agent_employee_id, t.created_at),
]);

export const oauthClients = pgTable('oauth_clients', {
  ...id(),
  client_id: text('client_id').notNull().unique(),
  client_secret_hash: text('client_secret_hash'),
  client_name: text('client_name').notNull(),
  client_uri: text('client_uri'),
  logo_uri: text('logo_uri'),
  redirect_uris: text('redirect_uris').array().notNull(),
  grant_types: text('grant_types').array().notNull().default(['authorization_code', 'refresh_token']),
  response_types: text('response_types').array().notNull().default(['code']),
  token_endpoint_auth_method: text('token_endpoint_auth_method').notNull().default('none'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  ...timestamps(),
}, (t) => [
  index('oauth_clients_client_id_idx').on(t.client_id),
]);

export const oauthAuthorizationCodes = pgTable('oauth_authorization_codes', {
  ...id(),
  code_hash: text('code_hash').notNull().unique(),
  org_id: text('org_id').notNull(),
  user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  client_id: text('client_id').notNull(),
  redirect_uri: text('redirect_uri').notNull(),
  code_challenge: text('code_challenge').notNull(),
  code_challenge_method: text('code_challenge_method').notNull(),
  resource: text('resource').notNull(),
  scopes: text('scopes').array().notNull(),
  expires_at: timestamp('expires_at').notNull(),
  used_at: timestamp('used_at'),
  ...timestamps(),
}, (t) => [
  index('oauth_codes_hash_idx').on(t.code_hash),
  index('oauth_codes_client_idx').on(t.client_id),
  index('oauth_codes_user_idx').on(t.user_id),
]);

export const oauthGrants = pgTable('oauth_grants', {
  ...id(),
  org_id: text('org_id').notNull(),
  user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  client_id: text('client_id').notNull(),
  app_name: text('app_name').notNull(),
  connector_profile: text('connector_profile').notNull().default('knowledge'),
  scopes: text('scopes').array().notNull(),
  revoked_at: timestamp('revoked_at'),
  ...timestamps(),
}, (t) => [
  index('oauth_grants_org_user_idx').on(t.org_id, t.user_id),
  index('oauth_grants_client_idx').on(t.client_id),
]);

export const oauthAccessTokens = pgTable('oauth_access_tokens', {
  ...id(),
  token_hash: text('token_hash').notNull().unique(),
  grant_id: text('grant_id').notNull().references(() => oauthGrants.id, { onDelete: 'cascade' }),
  org_id: text('org_id').notNull(),
  user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  client_id: text('client_id').notNull(),
  resource: text('resource').notNull(),
  scopes: text('scopes').array().notNull(),
  expires_at: timestamp('expires_at').notNull(),
  last_used_at: timestamp('last_used_at'),
  revoked_at: timestamp('revoked_at'),
  app_run_authorization_version: integer('app_run_authorization_version').default(1).notNull(),
  ...timestamps(),
}, (t) => [
  index('oauth_access_tokens_hash_idx').on(t.token_hash),
  index('oauth_access_tokens_grant_idx').on(t.grant_id),
  index('oauth_access_tokens_user_idx').on(t.user_id),
]);

export const oauthRefreshTokens = pgTable('oauth_refresh_tokens', {
  ...id(),
  token_hash: text('token_hash').notNull().unique(),
  grant_id: text('grant_id').notNull().references(() => oauthGrants.id, { onDelete: 'cascade' }),
  rotated_from: text('rotated_from'),
  expires_at: timestamp('expires_at').notNull(),
  revoked_at: timestamp('revoked_at'),
  ...timestamps(),
}, (t) => [
  index('oauth_refresh_tokens_hash_idx').on(t.token_hash),
  index('oauth_refresh_tokens_grant_idx').on(t.grant_id),
]);

export const oauthAuditEvents = pgTable('oauth_audit_events', {
  ...id(),
  org_id: text('org_id'),
  user_id: text('user_id').references(() => users.id, { onDelete: 'set null' }),
  client_id: text('client_id'),
  event: text('event').notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  index('oauth_audit_org_idx').on(t.org_id, t.created_at),
  index('oauth_audit_client_idx').on(t.client_id, t.created_at),
]);

export const agentEmployeeSkills = pgTable('agent_employee_skills', {
  agent_employee_id: text('agent_employee_id').notNull()
    .references(() => agentEmployees.id, { onDelete: 'cascade' }),
  skill_id: text('skill_id').notNull()
    .references(() => skills.id, { onDelete: 'restrict' }),
  installed_at: timestamp('installed_at').defaultNow().notNull(),
  installed_version: text('installed_version').notNull(),
}, (t) => [
  primaryKey({ columns: [t.agent_employee_id, t.skill_id] }),
  index('aes_skill_idx').on(t.skill_id),
]);

// ═══ AGENT PLANS ═══
export const agentPlans = pgTable('agent_plans', {
  ...id(),
  ...orgId(),
  user_id: text('user_id').notNull().references(() => users.id),
  agent_employee_id: text('agent_employee_id'),
  conversation_id: text('conversation_id'),
  title: text('title').notNull(),
  description: text('description'),
  steps: jsonb('steps').notNull(),
  status: planStatusEnum('status').default('draft').notNull(),
  current_step: integer('current_step').default(0).notNull(),
  context: jsonb('context'),
  error: text('error'),
  /**
   * Task 3.9 — fail-fast mode. When true, the executor marks every later
   * step 'skipped_due_to_failure' and stops as soon as any step fails,
   * instead of asking the agent for an alternative path. Default false
   * preserves existing recovery-and-continue behavior.
   */
  fail_fast: boolean('fail_fast').default(false).notNull(),
  /**
   * Task 3.9 — rollback-on-fail mode. Only meaningful when fail_fast=true.
   * When set, successful write-action steps taken earlier in the plan are
   * reversed on failure (create_task → soft-delete, post_message →
   * mark deleted). Steps without a safe reversal (update_task_*) log a
   * warning and are left as-is.
   */
  rollback_on_fail: boolean('rollback_on_fail').default(false).notNull(),
  ...timestamps(),
}, (t) => [
  index('agent_plan_org_idx').on(t.org_id),
  index('agent_plan_employee_idx').on(t.agent_employee_id),
]);

// ═══ API KEYS ═══
export const apiKeys = pgTable('api_keys', {
  ...id(),
  ...orgId(),
  agent_employee_id: text('agent_employee_id'),
  name: text('name').notNull(),
  key_hash: text('key_hash').notNull(),
  key_prefix: text('key_prefix').notNull(),
  permissions: text('permissions').array().notNull(),
  rate_limit_per_minute: integer('rate_limit_per_minute').default(60).notNull(),
  rate_limit_per_day: integer('rate_limit_per_day').default(10000).notNull(),
  last_used_at: timestamp('last_used_at'),
  request_count: integer('request_count').default(0).notNull(),
  is_active: boolean('is_active').default(true).notNull(),
  expires_at: timestamp('expires_at'),
  created_by: text('created_by').notNull().references(() => users.id),
  ...timestamps(),
}, (t) => [
  index('api_key_org_idx').on(t.org_id),
  index('api_key_prefix_idx').on(t.key_prefix),
]);

// ═══ AGENT EMPLOYEE TEMPLATES (Phase 2) ═══
// Template marketplace — SOUL.md / AGENTS.md / USER.md / TOOLS.md bootstrap files.
// Version is semver-validated at app layer via `assertSemver` AND at DB layer via
// the `agent_employee_templates_version_semver` CHECK constraint applied in migration 0009.
export const agentEmployeeTemplates = pgTable('agent_employee_templates', {
  ...id(),
  // Block 3.1 — nullable. NULL = first-party/community seed; non-NULL =
  // org-scoped "Save as template" clone. Uniqueness is (org_id, slug)
  // declared via the SQL migration's COALESCE-keyed partial index.
  org_id: text('org_id').references(() => orgs.id, { onDelete: 'cascade' }),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  version: text('version').notNull(),
  role: agentEmployeeRoleEnum('role').notNull(),
  description: text('description').notNull(),
  soul_md: text('soul_md').notNull(),
  agents_md: text('agents_md').notNull(),
  user_md_template: text('user_md_template').notNull(),
  tools_md: text('tools_md').notNull(),
  default_tools: text('default_tools').array().notNull(),
  // Phase 9 — pack slugs matching `CAPABILITY_PACKS` in capability-packs.ts.
  // Nullable for backward compatibility with rows seeded before migration 0016.
  default_capability_packs: text('default_capability_packs').array(),
  default_trust_level: trustLevelEnum('default_trust_level').default('standard').notNull(),
  default_trigger_subscriptions: text('default_trigger_subscriptions').array(),
  model_recommendation: text('model_recommendation').notNull(),
  fallback_models: text('fallback_models').array(),
  source: text('source').$type<'first-party' | 'community' | 'user'>()
    .default('first-party').notNull(),
  source_attribution: text('source_attribution'),
  download_count: integer('download_count').default(0).notNull(),
  is_public: boolean('is_public').default(true).notNull(),
  created_by: text('created_by').references(() => users.id),
  ...timestamps(),
}, (t) => [
  check(
    'agent_employee_templates_version_semver',
    sql`${t.version} ~ '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\\+[0-9A-Za-z.-]+)?$'`,
  ),
]);

// ═══ AGENT SESSION TURNS (Phase 2) ═══
// Session inspector feed — one row per agent turn. Cost is computed on read
// from {model_name, tokens_in, tokens_out} against a model_pricing lookup table.
// ═══ AGENT COOPERATIVE LOG (self-hosted v1) ═══
// Append-only stream of cooperative-knowledge records volunteered by BYOA
// agents via the MCP `record_*` tools. Aspirational surface: tools accept
// the write and stash it here without any trust gating, so an agent can
// self-report its reasoning, decisions, outcomes, action attempts, or
// ambient conversation turns even when Deft isn't watching the turn
// itself. A future session inspector / Defty roll-up will render this;
// the table is deliberately minimal today.
export const agentCooperativeLog = pgTable('agent_cooperative_log', {
  ...id(),
  ...orgId(),
  employee_id: text('employee_id').notNull().references(() => agentEmployees.id, { onDelete: 'cascade' }),
  kind: text('kind').$type<
    | 'conversation_turn'
    | 'decision'
    | 'outcome'
    | 'reasoning_step'
    | 'action_attempt'
    | 'milestone'
  >().notNull(),
  // Free-form narrative the agent sends. Never truncated — the point of
  // the log is to receive the agent's voice verbatim.
  summary: text('summary').notNull(),
  // Optional structured metadata (decision alternatives, outcome code,
  // attempted-action name, etc.). Shape is intentionally unscoped.
  metadata: jsonb('metadata'),
  // Optional pointer to the turn this record belongs to, when the agent
  // can provide one. Allows a future rollup to thread records.
  session_turn_id: text('session_turn_id'),
  ...timestamps(),
}, (t) => [
  index('agent_coop_log_employee_idx').on(t.employee_id, t.created_at),
  index('agent_coop_log_org_kind_idx').on(t.org_id, t.kind, t.created_at),
]);

export const agentSessionTurns = pgTable('agent_session_turns', {
  ...id(),
  ...orgId(),
  employee_id: text('employee_id').notNull().references(() => agentEmployees.id),
  trigger_kind: text('trigger_kind').notNull(),
  triggering_message_id: text('triggering_message_id'),
  space_id: text('space_id'),
  input_messages_json: jsonb('input_messages_json').notNull(),
  raw_reply_text: text('raw_reply_text'),
  tool_calls_json: jsonb('tool_calls_json'),
  latency_ms: integer('latency_ms').notNull(),
  model_name: text('model_name'),
  tokens_in: integer('tokens_in'),
  tokens_out: integer('tokens_out'),
  result: text('result').$type<'success' | 'timeout' | 'error' | 'rejected_approval'>().notNull(),
  error: text('error'),
  ...timestamps(),
}, (t) => [
  index('ast_employee_idx').on(t.employee_id, t.created_at),
  index('ast_org_idx').on(t.org_id, t.created_at),
]);

// ═══ AGENT HEARTBEAT TURNS (Phase 8 Task 8.4) ═══
//
// One row per heartbeat tick — whether it dispatched, was skipped for
// budget/idempotency, or errored. The session inspector uses this feed
// to surface the "Heartbeats" tab on the agent-employee detail page.
// `prompt_sha` is the normalized-prompt digest from `heartbeat-prompt.ts`
// used by Task 8.6 idempotency.
export const agentHeartbeatTurns = pgTable('agent_heartbeat_turns', {
  ...id(),
  ...orgId(),
  agent_employee_id: text('agent_employee_id')
    .notNull()
    .references(() => agentEmployees.id, { onDelete: 'cascade' }),
  fired_at: timestamp('fired_at').defaultNow().notNull(),
  cadence_minutes: integer('cadence_minutes').notNull(),
  prompt_sha: text('prompt_sha').notNull(),
  action_count: integer('action_count').default(0).notNull(),
  tokens_in: integer('tokens_in'),
  tokens_out: integer('tokens_out'),
  cost_cents: integer('cost_cents'),
  /**
   * Outcome vocabulary:
   *   - 'dispatched'          — succeeded, agent ran
   *   - 'no_op'               — agent returned HEARTBEAT_OK
   *   - 'skipped_budget'      — daily action / cost cap hit
   *   - 'skipped_idempotent'  — same prompt_sha as last no_op
   *   - 'skipped_unhealthy'   — circuit breaker tripped
   *   - 'skipped_disconnected'— Gateway not connected
   *   - 'error'               — dispatcher threw
   */
  outcome: text('outcome').notNull(),
  outcome_reason: text('outcome_reason'),
  summary: text('summary'),
  raw_response: jsonb('raw_response'),
}, (t) => [
  index('aht_employee_fired_idx').on(t.agent_employee_id, t.fired_at),
  index('aht_org_fired_idx').on(t.org_id, t.fired_at),
]);

// ═══ ACTION RECEIPTS (Phase 2) ═══
// HMAC-signed receipts for every elevated action. action_id is a real FK to
// agent_actions.id (verified in Phase 0).
export const actionReceipts = pgTable('action_receipts', {
  ...id(),
  ...orgId(),
  action_id: text('action_id').notNull().references(() => agentActions.id),
  employee_id: text('employee_id').references(() => agentEmployees.id),
  proposer: text('proposer').$type<'defty' | 'employee' | 'user' | 'cron'>().notNull(),
  proposer_id: text('proposer_id'),
  approver_id: text('approver_id').references(() => users.id),
  decision: text('decision').$type<'auto_executed' | 'approved' | 'rejected' | 'expired'>().notNull(),
  decision_reason: text('decision_reason'),
  action_name: text('action_name').notNull(),
  action_params_json: jsonb('action_params_json').notNull(),
  result_json: jsonb('result_json'),
  signature_hmac: text('signature_hmac').notNull(),
  signed_at: timestamp('signed_at').defaultNow().notNull(),
  ...timestamps(),
}, (t) => [
  index('receipt_org_idx').on(t.org_id, t.created_at),
  index('receipt_action_idx').on(t.action_id),
  uniqueIndex('receipt_action_decision_unique').on(t.action_id, t.decision),
]);

// ═══ SPACE MEMORY (Phase 2) ═══
// Per-channel KV bag used by agents to remember space-scoped facts.
export const spaceMemory = pgTable('space_memory', {
  ...id(),
  ...orgId(),
  space_id: text('space_id').notNull().references(() => spaces.id),
  key: text('key').notNull(),
  value: jsonb('value').notNull(),
  updated_by_employee_id: text('updated_by_employee_id').references(() => agentEmployees.id),
  ...timestamps(),
}, (t) => [
  uniqueIndex('space_memory_key_unique').on(t.space_id, t.key),
]);

// ═══ INTEGRATIONS (Phase 8) ═══
// Third-party OAuth integrations Deft uses to orchestrate managed employee
// deployments (Railway today; Fly/DO later). Tokens encrypted via env.ENCRYPTION_KEY.
export const integrations = pgTable('integrations', {
  ...id(),
  ...orgId(),
  provider: text('provider').$type<'railway' | 'fly' | 'digitalocean'>().notNull(),
  account_label: text('account_label'),
  access_token_encrypted: text('access_token_encrypted').notNull(),
  refresh_token_encrypted: text('refresh_token_encrypted'),
  access_token_expires_at: timestamp('access_token_expires_at'),
  scopes: text('scopes').array(),
  external_workspace_id: text('external_workspace_id'),
  external_workspace_name: text('external_workspace_name'),
  external_default_project_id: text('external_default_project_id'),
  status: text('status').$type<'connected' | 'revoked' | 'error'>().default('connected').notNull(),
  connected_by: text('connected_by').references(() => users.id),
  last_used_at: timestamp('last_used_at'),
  ...timestamps(),
}, (t) => [
  uniqueIndex('integrations_org_provider_idx').on(t.org_id, t.provider),
]);

// ═══ MESSAGE CLASSIFICATIONS (Task 5.6) ═══
// Persisted output from the Haiku classifier that runs on every chat message.
// Written by the fire-and-forget IIFE in routes/messages.ts immediately after
// classifyMessage() returns, before any downstream job enqueues.
export const messageClassifications = pgTable('message_classifications', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  org_id: text('org_id').notNull(),
  message_id: text('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
  intent: text('intent').notNull(),                        // task_create | question | discussion | actionable | none
  confidence: real('confidence').notNull(),                // 0-1
  agent_mentioned: boolean('agent_mentioned').notNull().default(false),
  blocked: boolean('blocked').notNull().default(false),
  task_references: text('task_references').array().default(sql`ARRAY[]::text[]`),
  entities: jsonb('entities'),                             // { assignee?, project?, due_date? }
  memorable_facts: text('memorable_facts').array().default(sql`ARRAY[]::text[]`),
  decision: text('decision'),                              // nullable
  created_at: timestamp('created_at').notNull().defaultNow(),
}, (t) => [
  index('mc_org_msg_idx').on(t.org_id, t.message_id),
]);

// Browser session families: refresh rotation and access revocation share one row.
export const webSessions = pgTable('web_sessions', {
  ...id(),
  user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  org_id: text('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  refresh_token_hash: text('refresh_token_hash').notNull(),
  expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
  revoked_at: timestamp('revoked_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index('web_sessions_user_org_idx').on(t.user_id, t.org_id)]);

// A host-issued, short-lived proof that a human may render one reviewed App
// experience. The token itself is never stored here.
export const appExperienceSessions = pgTable('app_experience_sessions', {
  ...id(),
  ...orgId(),
  user_id: text('user_id').notNull(),
  web_session_id: text('web_session_id').notNull(),
  app_installation_id: text('app_installation_id').notNull(),
  app_version_id: text('app_version_id').notNull(),
  grant_snapshot_id: text('grant_snapshot_id').notNull(),
  grant_snapshot_kind: text('grant_snapshot_kind').$type<'effective'>().default('effective').notNull(),
  experience_key: text('experience_key').notNull(),
  artifact_digest: text('artifact_digest').notNull(),
  lifecycle_epoch: integer('lifecycle_epoch').notNull(),
  grant_epoch: integer('grant_epoch').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
  revoked_at: timestamp('revoked_at', { withTimezone: true }),
}, (t) => [
  foreignKey({ columns: [t.org_id, t.user_id],
    foreignColumns: [orgMembers.org_id, orgMembers.user_id],
    name: 'app_experience_sessions_member_fk' }).onDelete('restrict'),
  foreignKey({ columns: [t.web_session_id], foreignColumns: [webSessions.id],
    name: 'app_experience_sessions_web_session_fk' }).onDelete('restrict'),
  foreignKey({ columns: [t.org_id, t.app_installation_id, t.app_version_id],
    foreignColumns: [appVersions.org_id, appVersions.installation_id, appVersions.id],
    name: 'app_experience_sessions_version_fk' }).onDelete('restrict'),
  foreignKey({ columns: [t.org_id, t.app_installation_id, t.app_version_id,
    t.grant_snapshot_id, t.grant_snapshot_kind],
    foreignColumns: [appGrantSnapshots.org_id, appGrantSnapshots.app_installation_id,
      appGrantSnapshots.app_version_id, appGrantSnapshots.id, appGrantSnapshots.snapshot_kind],
    name: 'app_experience_sessions_grant_fk' }).onDelete('restrict'),
  unique('app_experience_sessions_org_identity_unique').on(t.org_id, t.id, t.user_id, t.web_session_id),
  index('app_experience_sessions_web_app_idx').on(t.org_id, t.web_session_id,
    t.app_installation_id, t.expires_at),
  index('app_experience_sessions_expires_idx').on(t.expires_at),
  check('app_experience_sessions_key_check', sql`${t.experience_key} ~ '^[a-z][a-z0-9_]{0,47}$'`),
  check('app_experience_sessions_digest_check', sql`${t.artifact_digest} ~ '^sha256:[a-f0-9]{64}$'`),
  check('app_experience_sessions_epoch_check', sql`${t.lifecycle_epoch} >= 0 AND ${t.grant_epoch} >= 0`),
  check('app_experience_sessions_kind_check', sql`${t.grant_snapshot_kind} = 'effective'`),
  check('app_experience_sessions_expiry_check', sql`${t.expires_at} > ${t.created_at}`),
]);

// Separate explicit disclosure consent. App/sync grants and old sessions never
// populate these rows. Session pruning cascades operational rows, not the audit.
export const appExperienceResourceExposures = pgTable('app_experience_resource_exposures', {
  ...id(), ...orgId(),
  experience_session_id: text('experience_session_id').notNull(),
  owner_user_id: text('owner_user_id').notNull(),
  web_session_id: text('web_session_id').notNull(),
  review_digest: text('review_digest').notNull(),
  snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull(),
  payload_policy_version: text('payload_policy_version').notNull(),
  exposure_epoch: integer('exposure_epoch').default(0).notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
  revoked_at: timestamp('revoked_at', { withTimezone: true }),
}, t => [
  foreignKey({ columns: [t.org_id, t.experience_session_id, t.owner_user_id, t.web_session_id],
    foreignColumns: [appExperienceSessions.org_id, appExperienceSessions.id, appExperienceSessions.user_id, appExperienceSessions.web_session_id],
    name: 'app_experience_resource_exposures_session_fk' }).onDelete('cascade'),
  unique('app_experience_resource_exposures_org_id_unique').on(t.org_id, t.id),
  unique('app_experience_resource_exposures_review_unique').on(t.org_id, t.experience_session_id, t.review_digest),
  uniqueIndex('app_experience_resource_exposures_current_unique').on(t.org_id, t.experience_session_id).where(sql`${t.revoked_at} IS NULL`),
  check('app_experience_resource_exposures_digest_check', sql`${t.review_digest} ~ '^sha256:[a-f0-9]{64}$'`),
  check('app_experience_resource_exposures_policy_check', sql`${t.payload_policy_version} = 'deft.experience_resource_payload.v1'`),
  check('app_experience_resource_exposures_epoch_check', sql`${t.exposure_epoch} >= 0`),
  check('app_experience_resource_exposures_expiry_check', sql`${t.expires_at} > ${t.created_at}`),
]);

export const appExperienceResourceExposureResources = pgTable('app_experience_resource_exposure_resources', {
  ...orgId(), exposure_id: text('exposure_id').notNull(), resource_key: text('resource_key').notNull(),
  resource_binding_id: text('resource_binding_id').notNull(), runtime_registration_id: text('runtime_registration_id').notNull(),
  runtime_epoch: integer('runtime_epoch').notNull(), descriptor_digest: text('descriptor_digest').notNull(),
  resource_type: text('resource_type').notNull(),
  allowed_operations: jsonb('allowed_operations').$type<string[]>().notNull(),
  allowed_fields: jsonb('allowed_fields').$type<string[]>().notNull(),
}, t => [
  primaryKey({ name: 'app_experience_resource_exposure_resources_pkey', columns: [t.org_id, t.exposure_id, t.resource_key] }),
  foreignKey({ columns: [t.org_id, t.exposure_id], foreignColumns: [appExperienceResourceExposures.org_id, appExperienceResourceExposures.id],
    name: 'app_experience_resource_exposure_resources_parent_fk' }).onDelete('cascade'),
  foreignKey({ columns: [t.org_id, t.runtime_registration_id, t.resource_binding_id],
    foreignColumns: [appResourceBindings.org_id, appResourceBindings.runtime_registration_id, appResourceBindings.id],
    name: 'app_experience_resource_exposure_resources_binding_fk' }).onDelete('restrict'),
  check('app_experience_resource_exposure_resources_epoch_check', sql`${t.runtime_epoch} > 0`),
  check('app_experience_resource_exposure_resources_key_check', sql`${t.resource_key} ~ '^[a-z][a-z0-9_]{0,47}$'`),
]);

export const appExperienceResourceExposureAudit = pgTable('app_experience_resource_exposure_audit', {
  ...id(), ...orgId(), exposure_id: text('exposure_id').notNull(), experience_session_id: text('experience_session_id').notNull(),
  owner_user_id: text('owner_user_id').notNull(), review_digest: text('review_digest').notNull(),
  event: text('event').$type<'accepted' | 'revoked'>().notNull(),
  safe_snapshot: jsonb('safe_snapshot').$type<Record<string, unknown>>().notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, t => [
  unique('app_experience_resource_exposure_audit_event_unique').on(t.org_id, t.exposure_id, t.event),
  check('app_experience_resource_exposure_audit_event_check', sql`${t.event} IN ('accepted', 'revoked')`),
]);

// ═══ REVOKED TOKENS ═══
// Server-side refresh token revocation (Option B — stateless JWTs, hash-based blacklist).
// Logout inserts the sha256 hash; /refresh rejects any token whose hash is present.
export const revokedTokens = pgTable('revoked_tokens', {
  ...id(),
  token_hash: text('token_hash').notNull().unique(),
  user_id: text('user_id'),
  org_id: text('org_id'),
  revoked_at: timestamp('revoked_at').defaultNow().notNull(),
}, (t) => [
  index('revoked_tokens_hash_idx').on(t.token_hash),
]);

// Gate G public ingress is host-owned. The first claim provider is a canonical
// Module record; App packages cannot create endpoints active or provide SQL.
export const appPublicEndpoints = pgTable('app_public_endpoints', {
  ...id(),
  ...orgId(),
  slug_digest: text('slug_digest').notNull(),
  app_installation_id: text('app_installation_id').notNull(),
  app_version_id: text('app_version_id').notNull(),
  grant_snapshot_id: text('grant_snapshot_id').notNull(),
  installation_lifecycle_epoch: integer('installation_lifecycle_epoch').notNull(),
  installation_grant_epoch: integer('installation_grant_epoch').notNull(),
  module_installation_id: text('module_installation_id').notNull(),
  collection_key: text('collection_key').notNull(),
  public_action_key: text('public_action_key'),
  runtime_binding_id: text('runtime_binding_id'),
  native_binding_id: text('native_binding_id'),
  native_input_mapping: jsonb('native_input_mapping').$type<Record<string, { source: 'claim.resource_id' | 'claim.claim_id' } | { source: 'record.field'; field_key: string }> | null>(),
  approver_user_id: text('approver_user_id'),
  input_mapping: jsonb('input_mapping').$type<Record<string, 'claim.resource_id' | 'claim.claim_id'> | null>(),
  mapping_digest: text('mapping_digest'),
  availability_policy: jsonb('availability_policy').$type<Record<string, unknown> | null>(),
  budget_policy: jsonb('budget_policy').$type<Record<string, unknown> | null>(),
  cancellation_policy: jsonb('cancellation_policy').$type<Record<string, unknown> | null>(),
  cancel_native_binding_id: text('cancel_native_binding_id').generatedAlwaysAs(sql`cancellation_policy->>'cancel_native_binding_id'`),
  authentication_policy: jsonb('authentication_policy').$type<Record<string, unknown> | null>(),
  hmac_key_id: text('hmac_key_id'),
  state: text('state').$type<'disabled' | 'enabled'>().default('disabled').notNull(),
  endpoint_epoch: integer('endpoint_epoch').default(1).notNull(),
  review_digest: text('review_digest').notNull(),
  reviewed_by_user_id: text('reviewed_by_user_id').notNull(),
  reviewed_at: timestamp('reviewed_at').notNull(),
  public_label: text('public_label').notNull(),
  max_body_bytes: integer('max_body_bytes').default(1024).notNull(),
  ...timestamps(),
}, (t) => [
  foreignKey({
    columns: [t.org_id, t.app_installation_id, t.app_version_id],
    foreignColumns: [appVersions.org_id, appVersions.installation_id, appVersions.id],
    name: 'app_public_endpoints_version_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.org_id, t.app_installation_id, t.app_version_id, t.grant_snapshot_id],
    foreignColumns: [appGrantSnapshots.org_id, appGrantSnapshots.app_installation_id,
      appGrantSnapshots.app_version_id, appGrantSnapshots.id],
    name: 'app_public_endpoints_grant_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.org_id, t.module_installation_id],
    foreignColumns: [moduleInstallations.org_id, moduleInstallations.id],
    name: 'app_public_endpoints_module_fk',
  }).onDelete('restrict'),
  foreignKey({ columns: [t.org_id, t.runtime_binding_id],
    foreignColumns: [appRuntimeBindings.org_id, appRuntimeBindings.id],
    name: 'app_public_endpoints_runtime_binding_fk' }).onDelete('restrict'),
  foreignKey({ columns: [t.org_id, t.app_installation_id, t.app_version_id, t.grant_snapshot_id, t.native_binding_id, t.approver_user_id],
    foreignColumns: [appNativeBindings.org_id, appNativeBindings.app_installation_id, appNativeBindings.app_version_id,
      appNativeBindings.grant_snapshot_id, appNativeBindings.id, appNativeBindings.owner_user_id],
    name: 'app_public_endpoints_native_binding_fk' }).onDelete('restrict'),
  foreignKey({ columns: [t.org_id, t.app_installation_id, t.app_version_id, t.grant_snapshot_id, t.cancel_native_binding_id, t.approver_user_id],
    foreignColumns: [appNativeBindings.org_id, appNativeBindings.app_installation_id, appNativeBindings.app_version_id,
      appNativeBindings.grant_snapshot_id, appNativeBindings.id, appNativeBindings.owner_user_id],
    name: 'app_public_endpoints_cancel_binding_fk' }).onDelete('restrict'),
  foreignKey({ columns: [t.org_id, t.approver_user_id],
    foreignColumns: [orgMembers.org_id, orgMembers.user_id],
    name: 'app_public_endpoints_approver_fk' }).onDelete('restrict'),
  unique('app_public_endpoints_org_id_unique').on(t.org_id, t.id),
  unique('app_public_endpoints_app_id_unique').on(t.org_id, t.app_installation_id, t.id),
  uniqueIndex('app_public_endpoints_slug_digest_unique').on(t.slug_digest),
  index('app_public_endpoints_org_installation_idx').on(t.org_id, t.app_installation_id, t.state),
  check('app_public_endpoints_slug_digest_check', sql`${t.slug_digest} ~ '^sha256:[a-f0-9]{64}$'`),
  check('app_public_endpoints_review_digest_check', sql`${t.review_digest} ~ '^sha256:[a-f0-9]{64}$'`),
  check('app_public_endpoints_state_check', sql`${t.state} IN ('disabled', 'enabled')`),
  check('app_public_endpoints_epoch_check', sql`${t.endpoint_epoch} >= 1
    AND ${t.installation_lifecycle_epoch} >= 0 AND ${t.installation_grant_epoch} >= 1`),
  check('app_public_endpoints_collection_check', sql`${t.collection_key} ~ '^[a-z][a-z0-9_]{0,63}$'`),
  check('app_public_endpoints_label_check', sql`octet_length(${t.public_label}) BETWEEN 1 AND 200`),
  check('app_public_endpoints_body_limit_check', sql`${t.max_body_bytes} BETWEEN 128 AND 8192`),
  check('app_public_endpoints_action_shape_check', sql`
    (${t.native_binding_id} IS NULL AND ${t.native_input_mapping} IS NULL AND (
    (${t.public_action_key} IS NULL AND ${t.runtime_binding_id} IS NULL
      AND ${t.approver_user_id} IS NULL AND ${t.input_mapping} IS NULL AND ${t.mapping_digest} IS NULL)
    OR (${t.public_action_key} IS NOT NULL AND ${t.public_action_key} ~ '^[a-z][a-z0-9_]{0,47}$'
      AND ${t.runtime_binding_id} IS NOT NULL AND ${t.approver_user_id} IS NOT NULL
      AND ${t.input_mapping} IS NOT NULL AND jsonb_typeof(${t.input_mapping}) = 'object'
      AND octet_length(${t.input_mapping}::text) <= 4096
      AND ${t.mapping_digest} IS NOT NULL AND ${t.mapping_digest} IS NOT NULL AND ${t.mapping_digest} ~ '^sha256:[a-f0-9]{64}$')
    )) OR (${t.native_binding_id} IS NOT NULL AND ${t.runtime_binding_id} IS NULL
      AND ${t.input_mapping} IS NULL AND ${t.native_input_mapping} IS NOT NULL
      AND jsonb_typeof(${t.native_input_mapping}) = 'object' AND octet_length(${t.native_input_mapping}::text) <= 4096
      AND ${t.public_action_key} IS NOT NULL AND ${t.public_action_key} ~ '^[a-z][a-z0-9_]{0,47}$'
      AND ${t.approver_user_id} IS NOT NULL AND ${t.mapping_digest} IS NOT NULL AND ${t.mapping_digest} ~ '^sha256:[a-f0-9]{64}$')
  `),
]);

// A receipt is retained even for a losing claim. No raw request body, cookie,
// public key or private Module projection is copied into this table.
export const appPublicIngress = pgTable('app_public_ingress', {
  ...id(),
  ...orgId(),
  endpoint_id: text('endpoint_id').notNull(),
  endpoint_epoch: integer('endpoint_epoch').notNull(),
  request_key_digest: text('request_key_digest').notNull(),
  input_digest: text('input_digest').notNull(),
  state: text('state').$type<'processing' | 'confirmed' | 'conflict'>().notNull(),
  follow_up_state: text('follow_up_state').$type<'pending' | 'unsupported' | 'run_created'>().default('pending').notNull(),
  follow_up_code: text('follow_up_code').$type<'APP_HANDLER_UNAVAILABLE' | 'ENDPOINT_REVOKED' | 'PUBLIC_WITHDRAWN'>(),
  handled_at: timestamp('handled_at'),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  foreignKey({
    columns: [t.org_id, t.endpoint_id],
    foreignColumns: [appPublicEndpoints.org_id, appPublicEndpoints.id],
    name: 'app_public_ingress_endpoint_fk',
  }).onDelete('restrict'),
  unique('app_public_ingress_org_endpoint_id_unique').on(t.org_id, t.endpoint_id, t.id),
  uniqueIndex('app_public_ingress_request_unique').on(t.org_id, t.endpoint_id, t.endpoint_epoch, t.request_key_digest),
  index('app_public_ingress_endpoint_created_idx').on(t.org_id, t.endpoint_id, t.created_at),
  check('app_public_ingress_epoch_check', sql`${t.endpoint_epoch} >= 1`),
  check('app_public_ingress_key_digest_check', sql`${t.request_key_digest} ~ '^sha256:[a-f0-9]{64}$'`),
  check('app_public_ingress_input_digest_check', sql`${t.input_digest} ~ '^sha256:[a-f0-9]{64}$'`),
  check('app_public_ingress_state_check', sql`${t.state} IN ('processing', 'confirmed', 'conflict')`),
  check('app_public_ingress_follow_up_check', sql`(${t.follow_up_state} = 'pending' AND ${t.follow_up_code} IS NULL AND ${t.handled_at} IS NULL)
    OR (${t.follow_up_state} = 'unsupported' AND ${t.follow_up_code} IS NOT NULL
      AND ${t.follow_up_code} IN ('APP_HANDLER_UNAVAILABLE', 'ENDPOINT_REVOKED', 'PUBLIC_WITHDRAWN') AND ${t.handled_at} IS NOT NULL)
    OR (${t.follow_up_state} = 'run_created' AND ${t.follow_up_code} IS NULL
      AND ${t.handled_at} IS NOT NULL)`),
]);

// Signing key versions are immutable and remain available for audit/restore.
export const appPublicHmacKeys = pgTable('app_public_hmac_keys', {
  ...id(), ...orgId(), endpoint_id: text('endpoint_id').notNull(),
  sealed_secret: text('sealed_secret').notNull(), created_at: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  foreignKey({ columns: [t.org_id, t.endpoint_id], foreignColumns: [appPublicEndpoints.org_id, appPublicEndpoints.id],
    name: 'app_public_hmac_keys_endpoint_fk' }).onDelete('restrict'),
  unique('app_public_hmac_keys_identity_unique').on(t.org_id, t.endpoint_id, t.id),
]);
export const appPublicHmacNonces = pgTable('app_public_hmac_nonces', {
  ...id(), ...orgId(), endpoint_id: text('endpoint_id').notNull(), key_id: text('key_id').notNull(),
  nonce_digest: text('nonce_digest').notNull(), signed_at: timestamp('signed_at').notNull(),
  accepted_at: timestamp('accepted_at').notNull(), expires_at: timestamp('expires_at').notNull(),
}, (t) => [
  foreignKey({ columns: [t.org_id, t.endpoint_id, t.key_id],
    foreignColumns: [appPublicHmacKeys.org_id, appPublicHmacKeys.endpoint_id, appPublicHmacKeys.id],
    name: 'app_public_hmac_nonces_key_fk' }).onDelete('restrict'),
  unique('app_public_hmac_nonces_replay_unique').on(t.org_id, t.endpoint_id, t.key_id, t.nonce_digest),
  index('app_public_hmac_nonces_expiry_idx').on(t.org_id, t.endpoint_id, t.expires_at),
]);

// The uniqueness key omits endpoint identity: two public endpoints cannot
// claim the same canonical resource at once. Released rows remain for audit.
export const appCanonicalClaims = pgTable('app_canonical_claims', {
  ...id(),
  ...orgId(),
  endpoint_id: text('endpoint_id').notNull(),
  ingress_id: text('ingress_id').notNull(),
  provider_kind: text('provider_kind').$type<'module'>().notNull(),
  provider_instance_id: text('provider_instance_id').notNull(),
  resource_type: text('resource_type').notNull(),
  resource_id: text('resource_id').notNull(),
  claim_kind: text('claim_kind').$type<'exclusive'>().notNull(),
  claimed_resource_revision: integer('claimed_resource_revision'),
  released_at: timestamp('released_at'),
  // Fresh PostgreSQL admission instant; historical NULL rows retain their
  // original created_at as an explicitly approximate budget-day fallback.
  budget_reserved_at: timestamp('budget_reserved_at'),
  control_digest: text('control_digest'),
  control_expires_at: timestamp('control_expires_at'),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  foreignKey({
    columns: [t.org_id, t.endpoint_id, t.ingress_id],
    foreignColumns: [appPublicIngress.org_id, appPublicIngress.endpoint_id, appPublicIngress.id],
    name: 'app_canonical_claims_ingress_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.org_id, t.provider_instance_id, t.resource_id],
    foreignColumns: [moduleRecords.org_id, moduleRecords.installation_id, moduleRecords.id],
    name: 'app_canonical_claims_module_record_fk',
  }).onDelete('restrict'),
  unique('app_canonical_claims_org_id_unique').on(t.org_id, t.id),
  unique('app_canonical_claims_endpoint_id_unique').on(t.org_id, t.endpoint_id, t.id),
  uniqueIndex('app_canonical_claims_ingress_unique').on(t.org_id, t.ingress_id),
  uniqueIndex('app_canonical_claims_active_resource_unique')
    .on(t.org_id, t.provider_kind, t.provider_instance_id, t.resource_id, t.claim_kind)
    .where(sql`${t.released_at} IS NULL`),
  index('app_canonical_claims_endpoint_created_idx').on(t.org_id, t.endpoint_id, t.created_at),
  check('app_canonical_claims_revision_check', sql`${t.claimed_resource_revision} IS NULL OR ${t.claimed_resource_revision} >= 1`),
  check('app_canonical_claims_provider_check', sql`${t.provider_kind} = 'module'`),
  check('app_canonical_claims_resource_type_check', sql`${t.resource_type} ~ '^[a-z][a-z0-9_]{0,63}$'`),
  check('app_canonical_claims_kind_check', sql`${t.claim_kind} = 'exclusive'`),
  check('app_canonical_claims_release_check', sql`${t.released_at} IS NULL OR ${t.released_at} >= ${t.created_at}`),
  check('app_canonical_claims_control_check', sql`(${t.control_digest} IS NULL AND ${t.control_expires_at} IS NULL)
    OR COALESCE((${t.control_digest} ~ '^sha256:[a-f0-9]{64}$' AND ${t.control_expires_at} IS NOT NULL
      AND ${t.budget_reserved_at} IS NOT NULL AND ${t.control_expires_at} > ${t.budget_reserved_at}
      AND ${t.control_expires_at} <= ${t.budget_reserved_at} + interval '7 days'),false)`),
]);

export const appPublicCancellations = pgTable('app_public_cancellations', {
  ...id(), ...orgId(),
  app_installation_id: text('app_installation_id').notNull(),
  endpoint_id: text('endpoint_id').notNull(), claim_id: text('claim_id').notNull(),
  original_run_id: text('original_run_id'), request_key_digest: text('request_key_digest').notNull(),
  state: text('state').$type<'released_before_effect' | 'withdrawal_requested' | 'cancellation_unavailable'>().notNull(),
  accepted_at: timestamp('accepted_at').notNull(), settled_at: timestamp('settled_at'),
}, t => [
  foreignKey({ columns: [t.org_id, t.endpoint_id, t.claim_id],
    foreignColumns: [appCanonicalClaims.org_id, appCanonicalClaims.endpoint_id, appCanonicalClaims.id],
    name: 'app_public_cancellations_claim_fk' }).onDelete('restrict'),
  foreignKey({ columns: [t.org_id, t.app_installation_id, t.endpoint_id],
    foreignColumns: [appPublicEndpoints.org_id, appPublicEndpoints.app_installation_id, appPublicEndpoints.id],
    name: 'app_public_cancellations_endpoint_fk' }).onDelete('restrict'),
  foreignKey({ columns: [t.org_id, t.original_run_id], foreignColumns: [appRuns.org_id, appRuns.id],
    name: 'app_public_cancellations_run_fk' }).onDelete('restrict'),
  unique('app_public_cancellations_claim_unique').on(t.org_id, t.claim_id),
  index('app_public_cancellations_app_accepted_idx').on(t.org_id, t.app_installation_id, t.accepted_at),
  check('app_public_cancellations_key_check', sql`${t.request_key_digest} ~ '^sha256:[a-f0-9]{64}$'`),
  check('app_public_cancellations_state_check', sql`${t.state} IN ('released_before_effect','withdrawal_requested','cancellation_unavailable')
    AND ((${t.state} = 'withdrawal_requested' AND ${t.settled_at} IS NULL)
      OR (${t.state} <> 'withdrawal_requested' AND ${t.settled_at} IS NOT NULL AND ${t.settled_at} >= ${t.accepted_at}))`),
]);
// Explicit human-only exact-content App resource disclosure; no body copies.
export const appResourceAccessGrants = pgTable('app_resource_access_grants', {
  ...id(), ...orgId(), owner_user_id: text('owner_user_id').notNull(),
  recipient_user_id: text('recipient_user_id').notNull(), app_installation_id: text('app_installation_id').notNull(),
  resource_binding_id: text('resource_binding_id').notNull(), checkpoint_id: text('checkpoint_id').notNull(),
  projection_id: text('projection_id').notNull(), review_digest: text('review_digest').notNull(),
  snapshot: jsonb('snapshot').notNull(), accepted_sequence: bigserial('accepted_sequence', { mode: 'bigint' }).notNull(), accepted_at: timestamp('accepted_at', { withTimezone: true }).notNull(),
  expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
  revoked_at: timestamp('revoked_at', { withTimezone: true }), revoked_by_user_id: text('revoked_by_user_id'),
}, t => [
  foreignKey({ columns: [t.org_id, t.resource_binding_id, t.owner_user_id], foreignColumns: [appResourceBindings.org_id, appResourceBindings.id, appResourceBindings.owner_user_id], name: 'app_resource_access_grants_owner_fk' }).onDelete('restrict'),
  foreignKey({ columns: [t.org_id, t.checkpoint_id, t.resource_binding_id], foreignColumns: [appSyncCheckpoints.org_id, appSyncCheckpoints.id, appSyncCheckpoints.resource_binding_id], name: 'app_resource_access_grants_checkpoint_fk' }).onDelete('cascade'),
  foreignKey({ columns: [t.org_id, t.projection_id], foreignColumns: [appResourceProjections.org_id, appResourceProjections.id], name: 'app_resource_access_grants_projection_fk' }).onDelete('cascade'),
  foreignKey({ columns: [t.org_id, t.recipient_user_id], foreignColumns: [orgMembers.org_id, orgMembers.user_id], name: 'app_resource_access_grants_recipient_fk' }).onDelete('restrict'),
  unique('app_resource_access_grants_review_unique').on(t.org_id, t.owner_user_id, t.review_digest),
  index('app_resource_access_grants_owner_idx').on(t.org_id, t.owner_user_id, t.app_installation_id),
  index('app_resource_access_grants_recipient_idx').on(t.org_id, t.recipient_user_id, t.accepted_sequence),
  check('app_resource_access_grants_digest_check', sql`${t.review_digest} ~ '^sha256:[a-f0-9]{64}$'`),
  check('app_resource_access_grants_expiry_check', sql`${t.expires_at} > ${t.accepted_at} AND ${t.expires_at} <= ${t.accepted_at} + interval '24 hours'`),
  check('app_resource_access_grants_revocation_check', sql`(${t.revoked_at} IS NULL AND ${t.revoked_by_user_id} IS NULL) OR (${t.revoked_at} IS NOT NULL AND ${t.revoked_by_user_id} = ${t.owner_user_id})`),
  check('app_resource_access_grants_snapshot_check', sql`COALESCE(jsonb_typeof(${t.snapshot})='object' AND octet_length(${t.snapshot}::text)<=8192 AND ${t.snapshot} ?& ARRAY['schema_version','purpose','org_id','owner_user_id','recipient_user_id','app_installation_id','app_version_id','grant_snapshot_id','lifecycle_epoch','grant_epoch','registration_id','operator_user_id','runtime_epoch','resource_binding_id','descriptor_digest','checkpoint_id','generation','ref','revision_digest','content_digest','field_keys','operations','app_label','recipient_label','expires_at','review_expires_at'] AND (${t.snapshot} - ARRAY['schema_version','purpose','org_id','owner_user_id','recipient_user_id','app_installation_id','app_version_id','grant_snapshot_id','lifecycle_epoch','grant_epoch','registration_id','operator_user_id','runtime_epoch','resource_binding_id','descriptor_digest','checkpoint_id','generation','ref','revision_digest','content_digest','field_keys','operations','app_label','recipient_label','expires_at','review_expires_at'])='{}'::jsonb AND ${t.snapshot}->>'schema_version'='deft.app_resource_access_snapshot.v1' AND ${t.snapshot}->>'purpose'='human_view' AND ${t.snapshot}->>'org_id'=${t.org_id} AND ${t.snapshot}->>'owner_user_id'=${t.owner_user_id} AND ${t.snapshot}->>'recipient_user_id'=${t.recipient_user_id} AND ${t.snapshot}->>'app_installation_id'=${t.app_installation_id} AND ${t.snapshot}->>'resource_binding_id'=${t.resource_binding_id} AND ${t.snapshot}->>'checkpoint_id'=${t.checkpoint_id} AND jsonb_typeof(${t.snapshot}->'ref')='object' AND jsonb_typeof(${t.snapshot}->'field_keys')='array' AND jsonb_array_length(${t.snapshot}->'field_keys') BETWEEN 1 AND 32 AND jsonb_typeof(${t.snapshot}->'operations')='array' AND jsonb_array_length(${t.snapshot}->'operations') BETWEEN 1 AND 3 AND (${t.snapshot}->'operations') <@ '["cite","read","search"]'::jsonb AND ${t.snapshot}->'operations' IN ('["cite"]'::jsonb,'["read"]'::jsonb,'["search"]'::jsonb,'["cite","read"]'::jsonb,'["cite","search"]'::jsonb,'["read","search"]'::jsonb,'["cite","read","search"]'::jsonb) AND ${t.snapshot}#>>'{ref,schema_version}'='deft.resource_ref.v2' AND ${t.snapshot}#>>'{ref,provider,kind}'='app_runtime' AND ${t.snapshot}#>>'{ref,resource_id}'=${t.projection_id} AND ${t.snapshot}#>>'{ref,provider,provider_instance_id}'=${t.snapshot}->>'registration_id' AND jsonb_typeof(${t.snapshot}->'app_version_id')='string' AND jsonb_typeof(${t.snapshot}->'grant_snapshot_id')='string' AND jsonb_typeof(${t.snapshot}->'registration_id')='string' AND jsonb_typeof(${t.snapshot}->'operator_user_id')='string' AND jsonb_typeof(${t.snapshot}->'descriptor_digest')='string' AND jsonb_typeof(${t.snapshot}->'revision_digest')='string' AND jsonb_typeof(${t.snapshot}->'content_digest')='string' AND jsonb_typeof(${t.snapshot}->'expires_at')='string' AND jsonb_typeof(${t.snapshot}->'review_expires_at')='string' AND jsonb_typeof(${t.snapshot}->'app_label')='string' AND length(${t.snapshot}->>'app_label')<=200 AND jsonb_typeof(${t.snapshot}->'recipient_label')='string' AND length(${t.snapshot}->>'recipient_label')<=200 AND jsonb_typeof(${t.snapshot}->'lifecycle_epoch')='number' AND jsonb_typeof(${t.snapshot}->'grant_epoch')='number' AND jsonb_typeof(${t.snapshot}->'runtime_epoch')='number' AND jsonb_typeof(${t.snapshot}->'generation')='number',false)`),
]);
