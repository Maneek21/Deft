// packages/db/schema.ts — Deft database schema (Drizzle ORM + PostgreSQL)
// This schema covers: Auth, Orgs, Users, Chat (spaces + messages), Tasks, Projects, Agent, Events

import { pgTable, text, timestamp, boolean, integer, jsonb, pgEnum, index, uniqueIndex, real, vector, check, primaryKey, numeric } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

// ═══ HELPERS ═══
const id = () => ({ id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()) });
const orgId = () => ({ org_id: text('org_id').notNull() });
const timestamps = () => ({
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull().$onUpdate(() => new Date()),
});

// ═══ ENUMS ═══
export const orgRoleEnum = pgEnum('org_role', ['owner', 'admin', 'member', 'guest']);
export const userKindEnum = pgEnum('user_kind', ['human', 'agent', 'system']);
export const spaceTypeEnum = pgEnum('space_type', ['public', 'private', 'dm', 'group_dm']);
export const taskPriorityEnum = pgEnum('task_priority', ['p0', 'p1', 'p2', 'p3']);
export const taskStatusEnum = pgEnum('task_status', ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled']);
export const trustLevelEnum = pgEnum('trust_level', ['conservative', 'standard', 'autonomous']);
export const approvalTierEnum = pgEnum('approval_tier', ['auto', 'quick', 'full']);
export const approvalStatusEnum = pgEnum('approval_status', ['pending', 'approved', 'rejected', 'expired']);
export const eventSourceEnum = pgEnum('event_source', ['native', 'google_calendar', 'github', 'slack', 'gmail', 'linear']);
export const knowledgeTypeEnum = pgEnum('knowledge_type', ['decision', 'resource', 'action_item', 'note']);
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
  timezone: text('timezone').default('UTC'),
  status_emoji: text('status_emoji'),
  status_text: text('status_text'),
  status_expires_at: timestamp('status_expires_at'),
  password_hash: text('password_hash'),
  email_verified: boolean('email_verified').default(false).notNull(),
  last_seen_at: timestamp('last_seen_at'),
  notification_keywords: text('notification_keywords').array(),
  show_read_receipts: boolean('show_read_receipts').default(true).notNull(),
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
// Task 6.3 — Slack-style emoji reactions on tasks. A (task, user, emoji)
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
  agent_employee_id: text('agent_employee_id'),
  title: text('title'),
  ...timestamps(),
});

// ═══ AGENT: MESSAGES ═══
export const agentMessages = pgTable('agent_messages', {
  ...id(),
  conversation_id: text('conversation_id').notNull().references(() => agentConversations.id),
  role: text('role').notNull(), // 'user', 'assistant'
  content: text('content').notNull(),
  content_blocks: jsonb('content_blocks'), // Anthropic content blocks: [{type:'text'},{type:'tool_use'},{type:'tool_result'}]
  citations: jsonb('citations'), // [{ type, id, title, url }]
  tool_calls: jsonb('tool_calls'), // [{ tool, params, result, status }]
  hidden: boolean('hidden').default(false).notNull(),
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
  message_id: text('message_id'),
  agent_employee_id: text('agent_employee_id'),
  tool_use_id: text('tool_use_id'), // Anthropic tool_use block id (toolu_*)
  source: text('source').default('native'),
  mcp_connection_id: text('mcp_connection_id'),
  plan_id: text('plan_id'),
  plan_step_id: text('plan_step_id'),
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
  status: text('status').default('pending').notNull(), // 'pending', 'sent', 'cancelled'
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

// ═══ SPACE KNOWLEDGE ═══
/**
 * @deprecated Migrated to wikiPages in feat/phase2-4-mcp-agents-plans (2026-04-16).
 * Writes stopped in Phase 2 (Tasks 2.2 and 2.3). Reads migrated.
 * Safe to drop after 30 days (2026-05-16) if the deprecation-warning cron
 * continues to report zero new rows. No remaining legitimate consumers.
 */
export const spaceKnowledge = pgTable('space_knowledge', {
  ...id(),
  ...orgId(),
  space_id: text('space_id').notNull().references(() => spaces.id),
  type: knowledgeTypeEnum('type').notNull(),
  title: text('title').notNull(),
  content: text('content'),
  metadata: jsonb('metadata'),
  source_message_id: text('source_message_id').references(() => messages.id),
  created_by: text('created_by').notNull().references(() => users.id),
  is_deleted: boolean('is_deleted').default(false).notNull(),
  ...timestamps(),
}, (t) => [
  index('space_knowledge_org_idx').on(t.org_id),
  index('space_knowledge_space_idx').on(t.space_id),
  index('space_knowledge_type_idx').on(t.space_id, t.type),
]);

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
  conversation_id: text('conversation_id').references(() => agentConversations.id),
  scope: text('scope').notNull(), // 'conversation' | 'user' | 'org'
  key: text('key').notNull(),
  value: text('value').notNull(),
  ...timestamps(),
}, (t) => [
  uniqueIndex('agent_memory_upsert_unique').on(t.user_id, t.conversation_id, t.key),
]);

// ═══ DECISIONS ═══
/**
 * @deprecated Migrated to wikiPages in feat/phase2-4-mcp-agents-plans (2026-04-16).
 * Writes stopped in Phase 2 (Tasks 2.2 and 2.3). Reads migrated.
 * Safe to drop after 30 days (2026-05-16) if the deprecation-warning cron
 * continues to report zero new rows. No remaining legitimate consumers.
 */
export const decisions = pgTable('decisions', {
  ...id(),
  ...orgId(),
  space_id: text('space_id').notNull().references(() => spaces.id),
  message_id: text('message_id').notNull().references(() => messages.id),
  decision_text: text('decision_text').notNull(),
  decided_by: text('decided_by').notNull().references(() => users.id),
  context: text('context'), // surrounding context / why
  tags: jsonb('tags'), // ['payments', 'infrastructure']
  is_reversed: boolean('is_reversed').default(false).notNull(),
  // Block 2.6 — set when the decision has been acted on (agent tool
  // mark_decision_implemented, or the decision-wiki UI).
  implemented_at: timestamp('implemented_at'),
  ...timestamps(),
}, (t) => [
  index('decisions_org_idx').on(t.org_id),
  index('decisions_space_idx').on(t.space_id),
  index('decisions_implemented_idx').on(t.implemented_at),
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
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  index('job_queue_poll_idx').on(t.status, t.queue, t.run_at),
  index('job_queue_cron_idx').on(t.cron_key),
]);

// ═══ MEETING BRIEFS ═══
export const meetingBriefs = pgTable('meeting_briefs', {
  ...id(),
  ...orgId(),
  user_id: text('user_id').notNull().references(() => users.id),
  event_id: text('event_id').notNull().references(() => events.id),
  brief_text: text('brief_text').notNull(),
  ...timestamps(),
});

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
  user_id: text('user_id').references(() => users.id),
  agent_employee_id: text('agent_employee_id'),
  type: wikiPageTypeEnum('type').notNull(),
  title: text('title').notNull(),
  slug: text('slug').notNull(),
  summary: text('summary'),
  content: text('content').notNull(),
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
  page_id: text('page_id').notNull().references(() => wikiPages.id, { onDelete: 'cascade' }),
  source_type: text('source_type').notNull(),
  source_id: text('source_id').notNull(),
  excerpt: text('excerpt'),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  index('wiki_citations_page').on(t.page_id),
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
