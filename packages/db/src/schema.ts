// packages/db/schema.ts — Deft database schema (Drizzle ORM + PostgreSQL)
// This schema covers: Auth, Orgs, Users, Chat (spaces + messages), Tasks, Projects, Agent, Events

import { pgTable, text, timestamp, boolean, integer, jsonb, pgEnum, index, unique, uniqueIndex, real, vector, check, primaryKey, numeric, customType, foreignKey } from 'drizzle-orm/pg-core';
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

// ═══ ORG MEMBERS ═══
export const orgMembers = pgTable('org_members', {
  ...id(),
  ...orgId(),
  user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: orgRoleEnum('role').default('member').notNull(),
  is_active: boolean('is_active').default(true).notNull(),
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
  message_id: text('message_id').references(() => messages.id),
  task_id: text('task_id'), // filled when attached to task
  ...timestamps(),
});

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
  index('agent_action_org_idx').on(t.org_id),
  index('agent_action_user_idx').on(t.user_id),
  index('agent_action_runtime_request_idx').on(t.org_id, t.agent_employee_id, t.runtime_request_key),
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
  created_by: text('created_by').notNull().references(() => users.id),
  ...timestamps(),
}, (t) => [
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
  ...timestamps(),
}, (t) => [
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
