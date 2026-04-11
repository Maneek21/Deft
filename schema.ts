// packages/db/schema.ts — Deft database schema (Drizzle ORM + PostgreSQL)
// This schema covers: Auth, Orgs, Users, Chat (spaces + messages), Tasks, Projects, Agent, Events

import { pgTable, text, timestamp, boolean, integer, jsonb, pgEnum, index, uniqueIndex, real } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// ═══ HELPERS ═══
const id = () => ({ id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()) });
const orgId = () => ({ org_id: text('org_id').notNull() });
const timestamps = () => ({
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull().$onUpdate(() => new Date()),
});

// ═══ ENUMS ═══
export const orgRoleEnum = pgEnum('org_role', ['owner', 'admin', 'member', 'guest']);
export const spaceTypeEnum = pgEnum('space_type', ['public', 'private', 'dm', 'group_dm']);
export const taskPriorityEnum = pgEnum('task_priority', ['p0', 'p1', 'p2', 'p3']);
export const taskStatusEnum = pgEnum('task_status', ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled']);
export const trustLevelEnum = pgEnum('trust_level', ['conservative', 'standard', 'autonomous']);
export const approvalTierEnum = pgEnum('approval_tier', ['auto', 'quick', 'full']);
export const approvalStatusEnum = pgEnum('approval_status', ['pending', 'approved', 'rejected', 'expired']);
export const eventSourceEnum = pgEnum('event_source', ['native', 'google_calendar', 'github', 'slack', 'gmail', 'linear']);

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
  ...timestamps(),
});

// ═══ USERS ═══
export const users = pgTable('users', {
  ...id(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  avatar_url: text('avatar_url'),
  title: text('title'),
  timezone: text('timezone').default('UTC'),
  status_emoji: text('status_emoji'),
  status_text: text('status_text'),
  status_expires_at: timestamp('status_expires_at'),
  password_hash: text('password_hash'),
  email_verified: boolean('email_verified').default(false).notNull(),
  last_seen_at: timestamp('last_seen_at'),
  ...timestamps(),
});

// ═══ ORG MEMBERS ═══
export const orgMembers = pgTable('org_members', {
  ...id(),
  ...orgId(),
  user_id: text('user_id').notNull().references(() => users.id),
  role: orgRoleEnum('role').default('member').notNull(),
  is_active: boolean('is_active').default(true).notNull(),
  joined_at: timestamp('joined_at').defaultNow().notNull(),
  ...timestamps(),
}, (t) => [
  uniqueIndex('org_member_unique').on(t.org_id, t.user_id),
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
  assignee_id: text('assignee_id').references(() => users.id),
  created_by: text('created_by').notNull().references(() => users.id),
  due_date: timestamp('due_date'),
  sort_order: real('sort_order').default(0).notNull(),
  source_message_id: text('source_message_id').references(() => messages.id),
  is_deleted: boolean('is_deleted').default(false).notNull(),
  ...timestamps(),
}, (t) => [
  index('task_project_idx').on(t.project_id),
  index('task_assignee_idx').on(t.assignee_id),
  index('task_org_idx').on(t.org_id),
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
  uniqueIndex('task_label_unique').on(t.task_id, t.label_id),
]);

// ═══ TASK COMMENTS ═══
export const taskComments = pgTable('task_comments', {
  ...id(),
  task_id: text('task_id').notNull().references(() => tasks.id),
  user_id: text('user_id').notNull().references(() => users.id),
  content: text('content').notNull(),
  is_deleted: boolean('is_deleted').default(false).notNull(),
  ...timestamps(),
});

// ═══ TASK ACTIVITY LOG ═══
export const taskActivity = pgTable('task_activity', {
  ...id(),
  task_id: text('task_id').notNull().references(() => tasks.id),
  user_id: text('user_id').references(() => users.id), // null = agent
  action: text('action').notNull(), // 'status_changed', 'assigned', 'priority_changed', 'commented', 'created'
  field: text('field'),
  old_value: text('old_value'),
  new_value: text('new_value'),
  ...timestamps(),
}, (t) => [
  index('activity_task_idx').on(t.task_id),
]);

// ═══ TASK RELATIONSHIPS ═══
export const taskRelationships = pgTable('task_relationships', {
  ...id(),
  source_task_id: text('source_task_id').notNull().references(() => tasks.id),
  target_task_id: text('target_task_id').notNull().references(() => tasks.id),
  type: text('type').notNull(), // 'blocks', 'relates_to', 'duplicates'
  ...timestamps(),
});

// ═══ NOTIFICATIONS ═══
export const notifications = pgTable('notifications', {
  ...id(),
  ...orgId(),
  user_id: text('user_id').notNull().references(() => users.id),
  type: text('type').notNull(), // 'mention', 'task_assigned', 'task_updated', 'agent_suggestion', 'system'
  title: text('title').notNull(),
  body: text('body'),
  link: text('link'), // URL to navigate to
  is_read: boolean('is_read').default(false).notNull(),
  metadata: jsonb('metadata'),
  ...timestamps(),
}, (t) => [
  index('notification_user_idx').on(t.user_id),
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

// ═══ AGENT: CONVERSATIONS ═══
export const agentConversations = pgTable('agent_conversations', {
  ...id(),
  ...orgId(),
  user_id: text('user_id').notNull().references(() => users.id),
  title: text('title'),
  ...timestamps(),
});

// ═══ AGENT: MESSAGES ═══
export const agentMessages = pgTable('agent_messages', {
  ...id(),
  conversation_id: text('conversation_id').notNull().references(() => agentConversations.id),
  role: text('role').notNull(), // 'user', 'assistant'
  content: text('content').notNull(),
  citations: jsonb('citations'), // [{ type, id, title, url }]
  tool_calls: jsonb('tool_calls'), // [{ tool, params, result, status }]
  model: text('model'),
  tokens_in: integer('tokens_in'),
  tokens_out: integer('tokens_out'),
  ...timestamps(),
});

// ═══ AGENT: ACTIONS LOG ═══
export const agentActions = pgTable('agent_actions', {
  ...id(),
  ...orgId(),
  user_id: text('user_id').notNull().references(() => users.id),
  conversation_id: text('conversation_id').references(() => agentConversations.id),
  action: text('action').notNull(), // 'create_task', 'update_task_status', 'post_message', etc.
  params: jsonb('params').notNull(),
  result: jsonb('result'),
  approval_tier: approvalTierEnum('approval_tier').notNull(),
  approval_status: approvalStatusEnum('approval_status').default('pending').notNull(),
  approved_at: timestamp('approved_at'),
  executed_at: timestamp('executed_at'),
  error: text('error'),
  before_state: jsonb('before_state'),
  after_state: jsonb('after_state'),
  undone_at: timestamp('undone_at'),
  ...timestamps(),
}, (t) => [
  index('agent_action_org_idx').on(t.org_id),
  index('agent_action_user_idx').on(t.user_id),
]);

// ═══ AGENT: SKILLS ═══
export const skills = pgTable('skills', {
  ...id(),
  ...orgId(),
  name: text('name').notNull(),
  description: text('description'),
  slug: text('slug').notNull(), // /slug to invoke
  system_prompt: text('system_prompt').notNull(),
  param_schema: jsonb('param_schema'), // JSON schema for params
  created_by: text('created_by').notNull().references(() => users.id),
  usage_count: integer('usage_count').default(0).notNull(),
  ...timestamps(),
}, (t) => [
  uniqueIndex('skill_slug_unique').on(t.org_id, t.slug),
]);

// ═══ AGENT: TOOL REGISTRY ═══
export const tools = pgTable('tools', {
  ...id(),
  name: text('name').notNull().unique(),
  description: text('description').notNull(),
  category: text('category').notNull(), // 'native', 'google_calendar', 'github', 'slack', 'gmail'
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
  created_by: text('created_by').notNull().references(() => users.id),
  ...timestamps(),
});

// ═══ CONNECTED ACCOUNTS (OAUTH) ═══
export const connectedAccounts = pgTable('connected_accounts', {
  ...id(),
  ...orgId(),
  user_id: text('user_id').notNull().references(() => users.id),
  provider: text('provider').notNull(), // 'google_calendar', 'github', 'slack', 'gmail'
  provider_account_id: text('provider_account_id'),
  access_token_encrypted: text('access_token_encrypted').notNull(),
  refresh_token_encrypted: text('refresh_token_encrypted'),
  token_expires_at: timestamp('token_expires_at'),
  scopes: text('scopes'),
  metadata: jsonb('metadata'), // provider-specific data (slack workspace, github org, etc.)
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
  event_type: text('event_type').notNull(), // 'calendar_event', 'pr_opened', 'pr_merged', 'slack_message', 'email_received'
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

// ═══ ONBOARDING STATE ═══
export const onboardingState = pgTable('onboarding_state', {
  ...id(),
  user_id: text('user_id').notNull().references(() => users.id).unique(),
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
