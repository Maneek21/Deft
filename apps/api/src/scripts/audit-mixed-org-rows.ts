/**
 * Read-only audit: list rows whose org_id does not match the org of the row
 * they belong to (or whose user is not a member of the row's org).
 *
 * The script never writes. Every query runs inside one
 * `BEGIN TRANSACTION READ ONLY` transaction with a per-statement timeout, so
 * PostgreSQL itself rejects any write. There is no fix or cleanup mode and
 * flags that look like one are refused.
 *
 * Run:
 *   pnpm --filter @deft/api exec tsx src/scripts/audit-mixed-org-rows.ts \
 *     --database-url postgresql://user@host:5432/db [--json report.json] [--limit 50]
 *
 * The URL may also come from DATABASE_URL (the variable the other scripts in
 * this folder use). Exit code: 0 no mismatches, 2 mismatches found, 1 error.
 *
 * Output never contains message content, note bodies, names, emails or any
 * other user text: samples carry row ids, both org ids and created_at only.
 */

import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

export type Severity = 'mismatch' | 'info';

export interface CheckDef {
  id: string;
  /** What the check compares, in plain words. */
  description: string;
  tables: string[];
  columns: string[];
  /** 'mismatch' counts toward the exit code; 'info' is listed but does not. */
  severity: Severity;
  /** Child table, aliased `c` in `from`. Used to resolve the row id columns. */
  childTable: string;
  /** Static SQL after FROM. Never built from input. */
  from: string;
  /** Static SQL predicate that selects offending rows. */
  where: string;
  /** SQL expression for the org stamped on the row. */
  orgA: string;
  /** SQL expression for the org it should match, or null for membership checks. */
  orgB: string | null;
}

export interface Skip {
  what: string;
  reason: string;
}

const IDENT = /^[a-z_][a-z0-9_]*$/u;
function q(name: string): string {
  if (!IDENT.test(name)) throw new Error(`unsafe identifier in check registry: ${name}`);
  return `"${name}"`;
}

/** child.col references parent.id; both carry org_id; offending when they differ. */
function ref(child: string, col: string, parent: string, description?: string): CheckDef {
  return {
    id: `${child}.${col}->${parent}`,
    description: description ?? `${child}.org_id differs from ${parent}.org_id of the row named by ${child}.${col}`,
    tables: [child, parent],
    columns: [`${child}.org_id`, `${child}.${col}`, `${parent}.org_id`],
    severity: 'mismatch',
    childTable: child,
    from: `${q(child)} c JOIN ${q(parent)} p ON p.id = c.${q(col)}`,
    where: 'c.org_id <> p.org_id',
    orgA: 'c.org_id',
    orgB: 'p.org_id',
  };
}

/** Same as ref but the row must also belong to the same user (private notes/folders). */
function refSameOwner(child: string, col: string, parent: string, ownerCol: string): CheckDef {
  return {
    id: `${child}.${col}->${parent} (owner)`,
    description: `${child}.${ownerCol} differs from ${parent}.${ownerCol} of the row named by ${child}.${col}`,
    tables: [child, parent],
    columns: [`${child}.${col}`, `${child}.${ownerCol}`, `${parent}.${ownerCol}`, `${child}.org_id`],
    severity: 'mismatch',
    childTable: child,
    from: `${q(child)} c JOIN ${q(parent)} p ON p.id = c.${q(col)}`,
    where: `c.${q(ownerCol)} <> p.${q(ownerCol)} AND c.org_id = p.org_id`,
    orgA: 'c.org_id',
    orgB: 'p.org_id',
  };
}

interface MemberOpts {
  /** Table holding the user column. */
  table: string;
  userCol: string;
  /** When the table has no org_id: parent table, its join column, and an extra predicate. */
  via?: { parent: string; col: string; extra?: string; label?: string };
  /** true = user has a membership row only in an inactive state (informational). */
  inactive?: boolean;
}

/**
 * Membership check. Default: the user has no org_members row at all in the
 * row's org (system users such as the Defty user are excluded). With
 * `inactive`: the user has a row but no active one.
 */
function member(o: MemberOpts): CheckDef {
  const orgExpr = o.via ? 'p.org_id' : 'c.org_id';
  const join = o.via ? ` JOIN ${q(o.via.parent)} p ON p.id = c.${q(o.via.col)}` : '';
  const kind = o.inactive ? 'inactive' : 'none';
  const memberPred = o.inactive
    ? `NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = ${orgExpr} AND m.user_id = c.${q(o.userCol)} AND m.is_active)
       AND EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = ${orgExpr} AND m.user_id = c.${q(o.userCol)})`
    : `NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = ${orgExpr} AND m.user_id = c.${q(o.userCol)})`;
  const via = o.via?.label ? ` [${o.via.label}]` : '';
  return {
    id: `${o.table}.${o.userCol} not member (${kind})${via}`,
    description: o.inactive
      ? `${o.table}.${o.userCol} is a user whose only membership in the row's org is inactive`
      : `${o.table}.${o.userCol} is a user with no membership at all in the org of the row`,
    tables: o.via ? [o.table, o.via.parent, 'org_members', 'users'] : [o.table, 'org_members', 'users'],
    columns: [`${o.table}.${o.userCol}`, o.via ? `${o.via.parent}.org_id` : `${o.table}.org_id`, 'org_members.org_id', 'org_members.user_id'],
    severity: o.inactive ? 'info' : 'mismatch',
    childTable: o.table,
    from: `${q(o.table)} c${join} JOIN users u ON u.id = c.${q(o.userCol)}`,
    where: `u.kind::text <> 'system'${o.via ? '' : ' AND c.org_id IS NOT NULL'}${o.via?.extra ? ` AND ${o.via.extra}` : ''} AND ${memberPred}`,
    orgA: orgExpr,
    orgB: null,
  };
}

function custom(c: Omit<CheckDef, 'severity'> & { severity?: Severity }): CheckDef {
  return { severity: 'mismatch', ...c };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Single-column foreign keys between two tables that both carry org_id.
 * Derived from the live catalog (pg_constraint) of a database built by
 * `pnpm db:push-full`; the test file re-derives the list and fails if a new
 * pair appears that is neither here nor in SKIPS.
 */
export const FK_PAIRS: Array<[child: string, col: string, parent: string]> = [
  ['action_receipts', 'action_id', 'agent_actions'],
  ['action_receipts', 'employee_id', 'agent_employees'],
  ['agent_action_approvers', 'action_id', 'agent_actions'],
  ['agent_certification_challenges', 'employee_id', 'agent_employees'],
  ['agent_channel_connections', 'agent_employee_id', 'agent_employees'],
  ['agent_channel_cursors', 'agent_employee_id', 'agent_employees'],
  ['agent_channel_cursors', 'connection_id', 'agent_channel_connections'],
  ['agent_channel_delivery_attempts', 'agent_employee_id', 'agent_employees'],
  ['agent_channel_delivery_attempts', 'event_id', 'agent_channel_events'],
  ['agent_channel_events', 'agent_employee_id', 'agent_employees'],
  ['agent_channel_events', 'space_id', 'spaces'],
  ['agent_channel_events', 'thread_id', 'messages'],
  ['agent_channel_sessions', 'agent_employee_id', 'agent_employees'],
  ['agent_channel_tokens', 'agent_employee_id', 'agent_employees'],
  ['agent_cooperative_log', 'employee_id', 'agent_employees'],
  ['agent_heartbeat_turns', 'agent_employee_id', 'agent_employees'],
  ['agent_mcp_call_audit', 'employee_id', 'agent_employees'],
  ['agent_nudges', 'task_id', 'tasks'],
  ['agent_session_turns', 'employee_id', 'agent_employees'],
  ['agent_webhooks', 'agent_employee_id', 'agent_employees'],
  ['app_connection_consent_continuations', 'web_session_id', 'web_sessions'],
  ['app_connection_forms', 'web_session_id', 'web_sessions'],
  ['app_connection_sessions', 'web_session_id', 'web_sessions'],
  ['app_data_invocations', 'web_session_id', 'web_sessions'],
  ['app_experience_sessions', 'web_session_id', 'web_sessions'],
  ['app_future_record_action_releases', 'review_web_session_id', 'web_sessions'],
  ['app_integration_capture_sources', 'page_id', 'wiki_pages'],
  ['app_integration_capture_threads', 'page_id', 'wiki_pages'],
  ['app_local_job_invocations', 'web_session_id', 'web_sessions'],
  ['app_run_inspection_leases', 'experience_session_id', 'app_experience_sessions'],
  ['attention_deliveries', 'attention_item_id', 'attention_items'],
  ['attention_events', 'attention_item_id', 'attention_items'],
  ['canvases', 'space_id', 'spaces'],
  ['clips', 'message_id', 'messages'],
  ['clips', 'space_id', 'spaces'],
  ['duplicate_flags', 'task_a_id', 'tasks'],
  ['duplicate_flags', 'task_b_id', 'tasks'],
  ['email_calendar_invitations', 'event_id', 'events'],
  ['email_knowledge_threads', 'page_id', 'wiki_pages'],
  ['entity_tags', 'tag_id', 'tags'],
  ['events', 'connected_account_id', 'connected_accounts'],
  ['files', 'message_id', 'messages'],
  ['mcp_tokens', 'agent_employee_id', 'agent_employees'],
  ['mcp_tool_overrides', 'mcp_connection_id', 'mcp_connections'],
  ['meeting_briefs', 'event_id', 'events'],
  ['message_bookmarks', 'message_id', 'messages'],
  ['message_bookmarks', 'space_id', 'spaces'],
  ['message_classifications', 'message_id', 'messages'],
  ['message_observations', 'message_id', 'messages'],
  ['message_observations', 'space_id', 'spaces'],
  ['messages', 'space_id', 'spaces'],
  ['module_mutation_receipts', 'agent_action_id', 'agent_actions'],
  ['native_mention_deliveries', 'source_state_id', 'native_reference_states'],
  ['notes', 'folder_id', 'note_folders'],
  ['notes', 'visibility_space_id', 'spaces'],
  ['oauth_access_tokens', 'grant_id', 'oauth_grants'],
  ['reminders', 'source_message_id', 'messages'],
  ['saved_views', 'project_id', 'projects'],
  ['scheduled_messages', 'space_id', 'spaces'],
  ['space_memory', 'space_id', 'spaces'],
  ['space_memory', 'updated_by_employee_id', 'agent_employees'],
  ['task_activity', 'task_id', 'tasks'],
  ['task_comments', 'task_id', 'tasks'],
  ['task_reactions', 'task_id', 'tasks'],
  ['tasks', 'parent_task_id', 'tasks'],
  ['tasks', 'project_id', 'projects'],
  ['tasks', 'source_message_id', 'messages'],
  ['team_dashboard_snapshots', 'team_id', 'teams'],
  ['team_members', 'team_id', 'teams'],
  ['team_resources', 'team_id', 'teams'],
  ['teams', 'default_space_id', 'spaces'],
  ['wiki_citations', 'page_id', 'wiki_pages'],
  ['wiki_citations', 'source_space_id', 'spaces'],
  ['wiki_links', 'source_page_id', 'wiki_pages'],
  ['wiki_links', 'target_page_id', 'wiki_pages'],
  ['wiki_memory_syncs', 'agent_employee_id', 'agent_employees'],
  ['wiki_memory_syncs', 'page_id', 'wiki_pages'],
  ['wiki_ops_log', 'page_id', 'wiki_pages'],
  ['wiki_pages', 'origin_message_id', 'messages'],
  ['wiki_pages', 'origin_space_id', 'spaces'],
  ['wiki_pages', 'space_id', 'spaces'],
  ['work_intents', 'agent_employee_id', 'agent_employees'],
  ['work_intents', 'converted_task_id', 'tasks'],
  ['work_intents', 'source_message_id', 'messages'],
  ['work_intents', 'space_id', 'spaces'],
];

/**
 * Id columns that point at another org-scoped table but have no foreign key
 * constraint in the database (the code is the only thing keeping them honest).
 */
export const UNCONSTRAINED_REFS: Array<[child: string, col: string, parent: string]> = [
  ['messages', 'parent_id', 'messages'],
  ['tasks', 'recurrence_source_id', 'tasks'],
  ['note_folders', 'parent_folder_id', 'note_folders'],
  ['files', 'task_id', 'tasks'],
  ['agent_session_turns', 'space_id', 'spaces'],
  ['agent_session_turns', 'triggering_message_id', 'messages'],
  ['agent_cooperative_log', 'session_turn_id', 'agent_session_turns'],
  ['agent_actions', 'message_id', 'messages'],
  ['agent_actions', 'conversation_id', 'spaces'],
  ['agent_actions', 'agent_employee_id', 'agent_employees'],
  ['agent_actions', 'mcp_connection_id', 'mcp_connections'],
  ['agent_actions', 'plan_id', 'agent_plans'],
  ['agent_actions', 'channel_event_id', 'agent_channel_events'],
  ['agent_plans', 'agent_employee_id', 'agent_employees'],
  ['agent_plans', 'conversation_id', 'spaces'],
  ['agent_memory', 'conversation_id', 'spaces'],
  ['agent_channel_connections', 'last_event_id', 'agent_channel_events'],
  ['agent_channel_cursors', 'last_acked_event_id', 'agent_channel_events'],
  ['agent_channel_cursors', 'last_delivered_event_id', 'agent_channel_events'],
  ['api_keys', 'agent_employee_id', 'agent_employees'],
  ['automation_runs', 'agent_employee_id', 'agent_employees'],
  ['triggers', 'agent_employee_id', 'agent_employees'],
  ['wiki_pages', 'agent_employee_id', 'agent_employees'],
  ['skills', 'default_agent_employee_id', 'agent_employees'],
  ['task_activity', 'acting_agent_employee_id', 'agent_employees'],
  ['task_activity', 'agent_action_id', 'agent_actions'],
  ['work_intents', 'converted_action_id', 'agent_actions'],
  ['app_action_batches', 'employee_id', 'agent_employees'],
  ['app_action_batches', 'token_id', 'mcp_tokens'],
  ['app_integration_capture_claims', 'page_id', 'wiki_pages'],
  ['email_sync_receipts', 'page_id', 'wiki_pages'],
  ['native_mention_deliveries', 'attention_id', 'attention_items'],
];

/** Polymorphic references: (type column, type value, id column) -> parent table. */
const POLYMORPHIC: Array<{ child: string; typeCol: string; typeValue: string; col: string; parent: string }> = [
  ...(['message', 'task', 'event', 'note', 'project'] as const).flatMap((t) => {
    const parent = { message: 'messages', task: 'tasks', event: 'events', note: 'notes', project: 'projects' }[t];
    return [
      { child: 'cross_references', typeCol: 'source_type', typeValue: t, col: 'source_id', parent },
      { child: 'cross_references', typeCol: 'target_type', typeValue: t, col: 'target_id', parent },
    ];
  }),
  { child: 'entity_tags', typeCol: 'entity_type', typeValue: 'message', col: 'entity_id', parent: 'messages' },
  { child: 'entity_tags', typeCol: 'entity_type', typeValue: 'task', col: 'entity_id', parent: 'tasks' },
  { child: 'entity_tags', typeCol: 'entity_type', typeValue: 'note', col: 'entity_id', parent: 'notes' },
  { child: 'entity_tags', typeCol: 'entity_type', typeValue: 'daily_note', col: 'entity_id', parent: 'notes' },
  { child: 'entity_tags', typeCol: 'entity_type', typeValue: 'clip', col: 'entity_id', parent: 'clips' },
  { child: 'clips', typeCol: 'context_type', typeValue: 'space', col: 'context_id', parent: 'spaces' },
  { child: 'clips', typeCol: 'context_type', typeValue: 'task', col: 'context_id', parent: 'tasks' },
  { child: 'clips', typeCol: 'context_type', typeValue: 'project', col: 'context_id', parent: 'projects' },
  { child: 'clips', typeCol: 'context_type', typeValue: 'thread', col: 'context_id', parent: 'messages' },
  { child: 'wiki_citations', typeCol: 'source_type', typeValue: 'message', col: 'source_id', parent: 'messages' },
  { child: 'wiki_citations', typeCol: 'source_type', typeValue: 'task', col: 'source_id', parent: 'tasks' },
  { child: 'wiki_citations', typeCol: 'source_type', typeValue: 'note', col: 'source_id', parent: 'notes' },
];

function polymorphic(p: (typeof POLYMORPHIC)[number]): CheckDef {
  return custom({
    id: `${p.child}.${p.col}->${p.parent} (${p.typeCol}=${p.typeValue})`,
    description: `${p.child}.org_id differs from ${p.parent}.org_id when ${p.child}.${p.typeCol} = '${p.typeValue}'`,
    tables: [p.child, p.parent],
    columns: [`${p.child}.org_id`, `${p.child}.${p.typeCol}`, `${p.child}.${p.col}`, `${p.parent}.org_id`],
    childTable: p.child,
    from: `${q(p.child)} c JOIN ${q(p.parent)} p ON p.id = c.${q(p.col)}`,
    where: `c.${q(p.typeCol)}::text = '${p.typeValue}' AND c.org_id <> p.org_id`,
    orgA: 'c.org_id',
    orgB: 'p.org_id',
  });
}

/** Author / owner / assignee columns that must name someone who belongs to the row's org. */
const MEMBER_COLUMNS: Array<[table: string, col: string]> = [
  ['messages', 'user_id'],
  ['spaces', 'created_by'],
  ['notes', 'user_id'],
  ['note_folders', 'user_id'],
  ['scheduled_messages', 'user_id'],
  ['canvases', 'last_edited_by'],
  ['projects', 'lead_id'],
  ['tasks', 'created_by'],
  ['tasks', 'assignee_id'],
  ['task_comments', 'user_id'],
  ['task_activity', 'user_id'],
  ['task_reactions', 'user_id'],
  ['message_bookmarks', 'user_id'],
  ['reminders', 'user_id'],
  ['wiki_pages', 'user_id'],
  ['wiki_pages', 'origin_user_id'],
  ['teams', 'lead_user_id'],
  ['team_members', 'user_id'],
  ['saved_views', 'user_id'],
  ['notifications', 'user_id'],
  ['agent_plans', 'user_id'],
  ['agent_memory', 'user_id'],
  ['events', 'user_id'],
  ['files', 'uploaded_by'],
  ['clips', 'created_by'],
  ['cross_references', 'created_by'],
  ['work_intents', 'source_user_id'],
  // user references found by the catalog completeness test (S5 round 2)
  ['action_receipts', 'approver_id'],
  ['agent_action_approvers', 'user_id'],
  ['agent_actions', 'user_id'],
  ['agent_actions', 'approved_by_user_id'],
  ['agent_channel_tokens', 'created_by'],
  ['agent_employees', 'user_id'],
  ['agent_employees', 'created_by'],
  ['agent_nudges', 'user_id'],
  ['agent_webhooks', 'created_by'],
  ['api_keys', 'created_by'],
  ['app_action_batches', 'owner_user_id'],
  ['app_action_payloads', 'owner_user_id'],
  ['app_installations', 'installed_by_user_id'],
  ['app_integration_capture_policies', 'owner_user_id'],
  ['app_integration_destination_receipts', 'owner_user_id'],
  ['app_integration_notification_policies', 'owner_user_id'],
  ['app_private_defty_seals', 'owner_user_id'],
  ['app_private_files', 'owner_user_id'],
  ['app_private_state_records', 'owner_user_id'],
  ['app_restore_access_reviews', 'owner_user_id'],
  ['attention_deliveries', 'user_id'],
  ['attention_events', 'user_id'],
  ['attention_items', 'user_id'],
  ['automation_runs', 'user_id'],
  ['burnout_alerts', 'user_id'],
  ['burnout_alerts', 'alerted_to'],
  ['connected_accounts', 'user_id'],
  ['custom_emoji', 'uploaded_by'],
  ['email_context_transfers', 'owner_user_id'],
  ['ics_subscriptions', 'user_id'],
  ['integrations', 'connected_by'],
  ['invites', 'invited_by'],
  ['invites', 'accepted_by'],
  ['manager_settings', 'user_id'],
  ['mcp_connections', 'created_by'],
  ['mcp_tokens', 'user_id'],
  ['mcp_tokens', 'created_by'],
  ['meeting_briefs', 'user_id'],
  ['message_observations', 'user_id'],
  ['module_installations', 'installed_by_user_id'],
  ['native_create_requests', 'user_id'],
  ['native_mention_deliveries', 'recipient_user_id'],
  ['oauth_access_tokens', 'user_id'],
  ['oauth_authorization_codes', 'user_id'],
  ['oauth_grants', 'user_id'],
  ['oneone_preps', 'manager_id'],
  ['oneone_preps', 'report_id'],
  ['people_expertise', 'user_id'],
  ['people_influence', 'user_id'],
  ['people_interactions', 'user_a_id'],
  ['people_interactions', 'user_b_id'],
  ['people_patterns', 'user_id'],
  ['people_relationships', 'user_a_id'],
  ['people_relationships', 'user_b_id'],
  ['team_resources', 'created_by'],
  ['teams', 'created_by'],
  ['triggers', 'created_by'],
  ['user_groups', 'created_by'],
  ['web_push_subscriptions', 'user_id'],
  ['web_sessions', 'user_id'],
  ['wiki_citations', 'source_user_id'],
  ['work_intents', 'converted_by'],
  ['work_intents', 'dismissed_by'],
  ['workflow_rules', 'created_by'],
  // rows with org_id NULL (bundled, marketplace, first-party) are excluded by the check itself
  ['skills', 'created_by'],
  ['task_templates', 'created_by'],
  ['agent_employee_templates', 'created_by'],
  // Defty is users.kind = agent with an org_members row in every org (ensure-defty-membership.ts)
  ['app_private_defty_seals', 'defty_user_id'],
  ['native_mention_deliveries', 'actor_user_id'],
  ['agent_channel_events', 'actor_user_id'],
  ['attention_events', 'actor_user_id'],
];

/**
 * User foreign keys on org-bearing tables that are deliberately not membership
 * checks. A column whose table also has a composite (org_id, user) foreign key
 * to org_members is covered by PostgreSQL itself and needs no entry. The test
 * file derives the full list from the live catalog and fails on anything that
 * is neither registered above nor listed here.
 */
export const USER_FK_SKIPS: Array<{ table: string; col: string; reason: string }> = [
  { table: 'org_members', col: 'user_id', reason: 'this table is the membership record the other checks compare against' },
  { table: 'oauth_audit_events', col: 'user_id', reason: 'append-only audit history with a nullable org; the actor may have left or never joined the org' },
];

export function buildChecks(): CheckDef[] {
  const checks: CheckDef[] = [];

  for (const [c, col, p] of FK_PAIRS) checks.push(ref(c, col, p));
  for (const [c, col, p] of UNCONSTRAINED_REFS) {
    const r = ref(c, col, p);
    r.description += ' (no foreign key constraint on this column)';
    checks.push(r);
  }
  for (const p of POLYMORPHIC) checks.push(polymorphic(p));

  // Private notes and folders must also stay inside one owner.
  checks.push(refSameOwner('notes', 'folder_id', 'note_folders', 'user_id'));
  checks.push(refSameOwner('note_folders', 'parent_folder_id', 'note_folders', 'user_id'));

  // Tables with no org_id of their own: compare the two parents they join.
  checks.push(custom({
    id: 'pinned_messages.message_id->messages vs pinned_messages.space_id->spaces',
    description: 'a pin whose message belongs to a different org than the space it is pinned in',
    tables: ['pinned_messages', 'messages', 'spaces'],
    columns: ['pinned_messages.message_id', 'pinned_messages.space_id', 'messages.org_id', 'spaces.org_id'],
    childTable: 'pinned_messages',
    from: 'pinned_messages c JOIN messages mm ON mm.id = c.message_id JOIN spaces s ON s.id = c.space_id',
    where: 'mm.org_id <> s.org_id',
    orgA: 'mm.org_id',
    orgB: 's.org_id',
  }));
  checks.push(custom({
    id: 'pinned_messages.space_id vs messages.space_id',
    description: 'a pin whose space_id differs from the space the pinned message lives in',
    tables: ['pinned_messages', 'messages'],
    columns: ['pinned_messages.space_id', 'pinned_messages.message_id', 'messages.space_id'],
    childTable: 'pinned_messages',
    from: 'pinned_messages c JOIN messages mm ON mm.id = c.message_id JOIN spaces s ON s.id = c.space_id JOIN spaces ms ON ms.id = mm.space_id',
    where: 'c.space_id <> mm.space_id',
    orgA: 's.org_id',
    orgB: 'ms.org_id',
  }));
  checks.push(custom({
    id: 'project_spaces.project_id->projects vs project_spaces.space_id->spaces',
    description: 'a project linked to a space of a different org',
    tables: ['project_spaces', 'projects', 'spaces'],
    columns: ['project_spaces.project_id', 'project_spaces.space_id', 'projects.org_id', 'spaces.org_id'],
    childTable: 'project_spaces',
    from: 'project_spaces c JOIN projects pr ON pr.id = c.project_id JOIN spaces s ON s.id = c.space_id',
    where: 'pr.org_id <> s.org_id',
    orgA: 'pr.org_id',
    orgB: 's.org_id',
  }));
  checks.push(custom({
    id: 'task_labels.task_id->tasks vs task_labels.label_id->labels',
    description: 'a label from one org applied to a task of another org',
    tables: ['task_labels', 'tasks', 'labels'],
    columns: ['task_labels.task_id', 'task_labels.label_id', 'tasks.org_id', 'labels.org_id'],
    childTable: 'task_labels',
    from: 'task_labels c JOIN tasks t ON t.id = c.task_id JOIN labels l ON l.id = c.label_id',
    where: 't.org_id <> l.org_id',
    orgA: 't.org_id',
    orgB: 'l.org_id',
  }));
  checks.push(custom({
    id: 'task_relationships.source_task_id->tasks vs task_relationships.target_task_id->tasks',
    description: 'a relationship between tasks of two different orgs',
    tables: ['task_relationships', 'tasks'],
    columns: ['task_relationships.source_task_id', 'task_relationships.target_task_id', 'tasks.org_id'],
    childTable: 'task_relationships',
    from: 'task_relationships c JOIN tasks a ON a.id = c.source_task_id JOIN tasks b ON b.id = c.target_task_id',
    where: 'a.org_id <> b.org_id',
    orgA: 'a.org_id',
    orgB: 'b.org_id',
  }));
  checks.push(custom({
    id: 'workflow_runs.rule_id->workflow_rules vs workflow_runs.triggered_by_message_id->messages',
    description: 'a workflow run whose rule and triggering message belong to different orgs',
    tables: ['workflow_runs', 'workflow_rules', 'messages'],
    columns: ['workflow_runs.rule_id', 'workflow_runs.triggered_by_message_id', 'workflow_rules.org_id', 'messages.org_id'],
    childTable: 'workflow_runs',
    from: 'workflow_runs c JOIN workflow_rules r ON r.id = c.rule_id JOIN messages mm ON mm.id = c.triggered_by_message_id',
    where: 'r.org_id <> mm.org_id',
    orgA: 'r.org_id',
    orgB: 'mm.org_id',
  }));
  checks.push(custom({
    id: 'agent_employee_skills.agent_employee_id->agent_employees vs agent_employee_skills.skill_id->skills',
    description: 'an org-owned skill installed on an employee of another org (bundled skills with org_id NULL are skipped)',
    tables: ['agent_employee_skills', 'agent_employees', 'skills'],
    columns: ['agent_employee_skills.agent_employee_id', 'agent_employee_skills.skill_id', 'agent_employees.org_id', 'skills.org_id'],
    childTable: 'agent_employee_skills',
    from: 'agent_employee_skills c JOIN agent_employees e ON e.id = c.agent_employee_id JOIN skills sk ON sk.id = c.skill_id',
    where: 'sk.org_id IS NOT NULL AND e.org_id <> sk.org_id',
    orgA: 'e.org_id',
    orgB: 'sk.org_id',
  }));
  checks.push(custom({
    id: 'user_group_members.group_id->user_groups vs org membership',
    description: 'a user group member who has no membership in the group\'s org',
    tables: ['user_group_members', 'user_groups', 'org_members', 'users'],
    columns: ['user_group_members.group_id', 'user_group_members.user_id', 'user_groups.org_id', 'org_members.org_id'],
    childTable: 'user_group_members',
    from: 'user_group_members c JOIN user_groups g ON g.id = c.group_id JOIN users u ON u.id = c.user_id',
    where: `u.kind::text <> 'system' AND NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = g.org_id AND m.user_id = c.user_id)`,
    orgA: 'g.org_id',
    orgB: null,
  }));

  // Membership: grants and links that name a user.
  checks.push(member({ table: 'space_members', userCol: 'user_id', via: { parent: 'spaces', col: 'space_id' } }));
  checks.push(member({ table: 'task_assignees', userCol: 'user_id', via: { parent: 'tasks', col: 'task_id' } }));
  checks.push(member({ table: 'task_watchers', userCol: 'user_id', via: { parent: 'tasks', col: 'task_id' } }));
  checks.push(member({ table: 'note_shares', userCol: 'shared_with_user_id', via: { parent: 'notes', col: 'note_id' } }));
  checks.push(member({ table: 'reactions', userCol: 'user_id', via: { parent: 'messages', col: 'message_id' } }));
  checks.push(member({ table: 'thread_reads', userCol: 'user_id', via: { parent: 'messages', col: 'parent_message_id' } }));
  checks.push(member({ table: 'pinned_messages', userCol: 'pinned_by', via: { parent: 'spaces', col: 'space_id' } }));
  for (const [type, parent] of [['space', 'spaces'], ['project', 'projects'], ['task', 'tasks']] as const) {
    checks.push(member({
      table: 'favorites', userCol: 'user_id',
      via: { parent, col: 'entity_id', extra: `c.entity_type = '${type}'`, label: type },
    }));
  }
  for (const [table, col] of MEMBER_COLUMNS) checks.push(member({ table, userCol: col }));

  // Informational: the user still has a membership row, but it is inactive.
  checks.push(member({ table: 'space_members', userCol: 'user_id', via: { parent: 'spaces', col: 'space_id' }, inactive: true }));
  checks.push(member({ table: 'task_assignees', userCol: 'user_id', via: { parent: 'tasks', col: 'task_id' }, inactive: true }));
  checks.push(member({ table: 'task_watchers', userCol: 'user_id', via: { parent: 'tasks', col: 'task_id' }, inactive: true }));
  checks.push(member({ table: 'note_shares', userCol: 'shared_with_user_id', via: { parent: 'notes', col: 'note_id' }, inactive: true }));
  checks.push(member({ table: 'tasks', userCol: 'assignee_id', inactive: true }));
  checks.push(member({ table: 'team_members', userCol: 'user_id', inactive: true }));

  const seen = new Set<string>();
  for (const c of checks) {
    if (seen.has(c.id)) throw new Error(`duplicate check id ${c.id}`);
    seen.add(c.id);
  }
  return checks;
}

/** Things deliberately not checked, and why. Printed with every run. */
export const SKIPS: Skip[] = [
  { what: 'rows with org_id IS NULL (skills, task_templates, agent_employee_templates, wiki_citations, job_queue, oauth_audit_events, revoked_tokens)', reason: 'NULL org_id marks bundled, marketplace or global rows by design; comparisons use <>, which ignores NULL' },
  { what: 'users.kind = system (the Defty system user)', reason: 'holds an org_members row in every org by design; excluded from membership checks' },
  { what: 'composite foreign keys that include org_id (all app_*, email_*, module_*, resource_relation_*, attachment tables)', reason: 'PostgreSQL enforces org equality through the constraint itself, so a mismatch cannot be stored' },
  { what: 'message_versions, note_versions, wiki_page_versions, onboarding_state, oauth_clients, oauth_refresh_tokens, tools, deft_schema_migrations', reason: 'no org_id and no reference that could cross orgs; they inherit the org of their single parent row' },
  { what: 'attention_*.source_id, audit_log.entity_id, cross-resource ids typed by free text (native_reference_states.source_id, team_resources.resource_id, resource_relation_*.*_resource_id, agent_channel_sessions.deft_scope_id)', reason: 'polymorphic on provider or free-text keys; no single parent table to compare with' },
  { what: 'events.external_id, integrations.external_*, connected_accounts.provider_account_id, oauth_*.client_id, *_request_id / *_operation_id / *_attempt_id idempotency keys', reason: 'identifiers owned by outside systems or per-request keys, not references to org-scoped rows' },
  { what: 'created_by / *_actor_id columns on app and module tables', reason: 'actor ids may be users, agents or system actors and are recorded as history; tenant isolation there is enforced by the composite foreign keys' },
  { what: 'inactive memberships on authorship columns (messages.user_id etc.)', reason: 'former members legitimately keep authored history; only the no-membership-at-all case is a mismatch there' },
];

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface Sample {
  id: string;
  org_a: string | null;
  org_b: string | null;
  created_at: string | null;
}

export interface CheckResult {
  id: string;
  description: string;
  tables: string[];
  columns: string[];
  severity: Severity;
  count: number;
  samples: Sample[];
  error?: string;
}

export interface AuditReport {
  generated_at: string;
  target: string;
  transaction_read_only: string;
  statement_timeout_ms: number;
  limit: number;
  mismatch_checks: number;
  mismatch_rows: number;
  info_rows: number;
  errors: number;
  checks: CheckResult[];
  skipped: Skip[];
}

export interface AuditOptions {
  limit?: number;
  statementTimeoutMs?: number;
  target?: string;
}

type Queryable = Pick<pg.Client, 'query'>;

/**
 * Run `fn` inside one READ ONLY transaction on `client` and always roll back.
 * Exported so tests can prove a write is rejected through the same path.
 */
export async function withReadOnlyTransaction<T>(
  client: Queryable,
  fn: () => Promise<T>,
  statementTimeoutMs = 30_000,
): Promise<T> {
  await client.query('BEGIN TRANSACTION READ ONLY');
  try {
    await client.query(`SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', '5000', true)`, [String(statementTimeoutMs)]);
    return await fn();
  } finally {
    await client.query('ROLLBACK');
  }
}

export async function catalogInfo(client: Queryable): Promise<{ pk: Map<string, string[]>; created: Set<string> }> {
  const pkRows = await client.query<{ rel: string; cols: string[] }>(
    `SELECT cl.relname AS rel,
            (SELECT array_agg(a.attname::text ORDER BY k.ord)
               FROM unnest(i.indkey) WITH ORDINALITY k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = cl.oid AND a.attnum = k.attnum
              WHERE k.ord <= i.indnkeyatts) AS cols
       FROM pg_index i
       JOIN pg_class cl ON cl.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE i.indisprimary AND n.nspname = 'public'`,
  );
  const createdRows = await client.query<{ rel: string }>(
    `SELECT table_name AS rel FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'created_at'`,
  );
  return {
    pk: new Map(pkRows.rows.map((r) => [r.rel, r.cols])),
    created: new Set(createdRows.rows.map((r) => r.rel)),
  };
}

/** Runs every check on `client` (a connected pg client). Does not close it. */
export async function runAudit(client: Queryable, options: AuditOptions = {}): Promise<AuditReport> {
  const limit = options.limit ?? 50;
  const timeout = options.statementTimeoutMs ?? 30_000;
  if (!Number.isInteger(limit) || limit < 0) throw new Error('limit must be a non-negative integer');
  const checks = buildChecks();

  return withReadOnlyTransaction(client, async () => {
    const ro = await client.query<{ transaction_read_only: string }>('SHOW transaction_read_only');
    const readOnly = ro.rows[0]?.transaction_read_only ?? 'unknown';
    if (readOnly !== 'on') throw new Error('refusing to run: transaction is not read only');
    const { pk, created } = await catalogInfo(client);

    const results: CheckResult[] = [];
    for (const check of checks) {
      const result: CheckResult = {
        id: check.id, description: check.description, tables: check.tables,
        columns: check.columns, severity: check.severity, count: 0, samples: [],
      };
      const cols = pk.get(check.childTable) ?? ['id'];
      const keyExpr = cols.length === 1 ? `c.${q(cols[0]!)}::text` : `concat_ws(':', ${cols.map((x) => `c.${q(x)}::text`).join(', ')})`;
      const createdExpr = created.has(check.childTable) ? 'c.created_at' : 'NULL::timestamptz';
      await client.query('SAVEPOINT audit_check');
      try {
        const count = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${check.from} WHERE ${check.where}`);
        result.count = Number(count.rows[0]?.n ?? 0);
        if (result.count > 0 && limit > 0) {
          const rows = await client.query<{ id: string; org_a: string | null; org_b: string | null; created_at: Date | null }>(
            `SELECT ${keyExpr} AS id, ${check.orgA} AS org_a, ${check.orgB ?? 'NULL::text'} AS org_b, ${createdExpr} AS created_at
               FROM ${check.from} WHERE ${check.where} ORDER BY ${createdExpr} NULLS LAST, 1 LIMIT $1`,
            [limit],
          );
          result.samples = rows.rows.map((r) => ({
            id: r.id, org_a: r.org_a, org_b: r.org_b,
            created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
          }));
        }
        await client.query('RELEASE SAVEPOINT audit_check');
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT audit_check');
        result.error = describeError(err);
      }
      results.push(result);
    }

    const mismatch = results.filter((r) => r.severity === 'mismatch');
    return {
      generated_at: new Date().toISOString(),
      target: options.target ?? 'unknown',
      transaction_read_only: readOnly,
      statement_timeout_ms: timeout,
      limit,
      mismatch_checks: mismatch.filter((r) => r.count > 0).length,
      mismatch_rows: mismatch.reduce((n, r) => n + r.count, 0),
      info_rows: results.filter((r) => r.severity === 'info').reduce((n, r) => n + r.count, 0),
      errors: results.filter((r) => r.error).length,
      checks: results,
      skipped: SKIPS,
    };
  }, timeout);
}

// ---------------------------------------------------------------------------
// Error text. Driver messages can carry connection strings, user names or row
// data, so only a fixed description chosen from the error code is ever shown.
// ---------------------------------------------------------------------------

/** Argument errors carry fixed text only and are the only messages main() prints verbatim. */
export class CliError extends Error {}

const SQLSTATE_TEXT: Record<string, string> = {
  '28P01': 'authentication failed',
  '28000': 'authorization rejected',
  '3D000': 'database does not exist',
  '57014': 'statement timeout or cancelled query',
  '25006': 'read-only transaction rejected a write',
  '42501': 'insufficient privilege',
  '42P01': 'table does not exist',
  '42703': 'column does not exist',
  '53300': 'too many connections',
  '57P01': 'server shutting down',
  '55P03': 'lock timeout',
};
const NODE_TEXT: Record<string, string> = {
  ECONNREFUSED: 'connection refused',
  ENOTFOUND: 'host not found',
  EAI_AGAIN: 'host lookup failed',
  ETIMEDOUT: 'connection timed out',
  ECONNRESET: 'connection reset',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable',
};

export function describeError(err: unknown): string {
  if (err instanceof CliError) return err.message;
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  if (typeof code === 'string') {
    const node = NODE_TEXT[code];
    if (node) return `${code} (${node})`;
    if (/^[0-9A-Z]{5}$/u.test(code)) {
      const text = SQLSTATE_TEXT[code] ?? (code.startsWith('08') ? 'connection exception' : 'database error');
      return `SQLSTATE ${code} (${text})`;
    }
  }
  if (err instanceof Error && /timeout expired|Connection terminated/iu.test(err.message)) return 'connection timed out or terminated';
  return 'unexpected error (details withheld)';
}

/** Exit code for a finished report: 1 any errored check, 2 mismatches, 0 clean. */
export function exitCodeFor(report: Pick<AuditReport, 'errors' | 'mismatch_rows'>): number {
  if (report.errors > 0) return 1;
  return report.mismatch_rows > 0 ? 2 : 0;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface CliArgs {
  databaseUrl: string;
  jsonPath?: string;
  limit: number;
  timeoutMs: number;
}

const REFUSED = /^--(fix|repair|delete|cleanup|clean|apply|write|update|force|execute|commit|migrate)/u;

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliArgs {
  let databaseUrl: string | undefined;
  let jsonPath: string | undefined;
  let limit = 50;
  let timeoutMs = 30_000;
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    const [flag, inline] = raw.startsWith('--') && raw.includes('=') ? [raw.slice(0, raw.indexOf('=')), raw.slice(raw.indexOf('=') + 1)] : [raw, undefined];
    const refused = REFUSED.exec(flag);
    if (refused) throw new CliError(`${refused[0]} is not supported: this audit is read-only and has no fix mode`);
    const value = (): string => {
      const v = inline ?? argv[++i];
      if (v === undefined || v.startsWith('--')) throw new CliError(`${flag} needs a value`);
      return v;
    };
    if (flag === '--database-url') databaseUrl = value();
    else if (flag === '--json') jsonPath = value();
    else if (flag === '--limit') {
      limit = Number(value());
      if (!Number.isInteger(limit) || limit < 0 || limit > 10_000) throw new CliError('--limit must be an integer from 0 to 10000');
    } else if (flag === '--timeout-ms') {
      timeoutMs = Number(value());
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600_000) throw new CliError('--timeout-ms must be an integer from 1000 to 600000');
    } else throw new CliError(`unknown argument at position ${i + 1}`);
  }
  databaseUrl ??= env.DATABASE_URL;
  if (!databaseUrl) throw new CliError('pass --database-url <url> (or set DATABASE_URL)');
  return { databaseUrl, jsonPath, limit, timeoutMs };
}

/**
 * host:port/database for display, or null when the URL is not a postgres URL
 * with a real authority (//host) and a plain database name. Nothing but the
 * host, port and database name is ever returned, never a user, password or
 * query string, and a URL that fails these checks is not echoed at all.
 */
export function maskTarget(url: string): string | null {
  if (!/^postgres(?:ql)?:\/\/[^/?#\s]/iu.test(url)) return null;
  try {
    const u = new URL(url);
    if (!['postgres:', 'postgresql:'].includes(u.protocol)) return null;
    if (!/^[A-Za-z0-9._:[\]-]+$/u.test(u.hostname)) return null;
    if (!/^\/[A-Za-z0-9_.-]*$/u.test(u.pathname)) return null;
    return `${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname}`;
  } catch {
    return null;
  }
}

export function formatSummary(report: AuditReport): string {
  const lines: string[] = [];
  lines.push(`Target: ${report.target}`);
  lines.push(`Transaction read only: ${report.transaction_read_only}; statement timeout ${report.statement_timeout_ms} ms`);
  lines.push('');
  for (const r of report.checks) {
    const status = r.error ? `ERROR ${r.error}` : String(r.count);
    const tag = r.severity === 'info' ? ' [info]' : '';
    lines.push(`${r.count > 0 && r.severity === 'mismatch' ? 'MISMATCH' : r.error ? 'ERROR   ' : 'ok      '}  ${r.id}${tag}  tables=${r.tables.join(',')}  count=${status}`);
  }
  lines.push('');
  lines.push(`Checks: ${report.checks.length}; checks with mismatches: ${report.mismatch_checks}; mismatching rows: ${report.mismatch_rows}; informational rows (inactive members): ${report.info_rows}; errored checks: ${report.errors}`);
  lines.push('');
  lines.push('Not checked (by design):');
  for (const s of report.skipped) lines.push(`  - ${s.what}: ${s.reason}`);
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`[audit-mixed-org-rows] ${err instanceof CliError ? err.message : 'invalid arguments (details withheld)'}`);
    return 1;
  }
  const target = maskTarget(args.databaseUrl);
  if (target === null) {
    console.error('[audit-mixed-org-rows] database url must be a postgres or postgresql url with a host and a plain database name (value withheld)');
    return 1;
  }
  console.log(`[audit-mixed-org-rows] target: ${target} (read-only)`);
  let client: pg.Client | undefined;
  try {
    client = new pg.Client({
      connectionString: args.databaseUrl,
      application_name: 'deft-audit-mixed-org-rows',
      statement_timeout: args.timeoutMs,
      connectionTimeoutMillis: 15_000,
    });
    client.on('error', () => undefined);
    await client.connect();
    const report = await runAudit(client, { limit: args.limit, statementTimeoutMs: args.timeoutMs, target });
    console.log(formatSummary(report));
    if (args.jsonPath) {
      writeFileSync(args.jsonPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8' });
      console.log('[audit-mixed-org-rows] JSON report written');
    }
    return exitCodeFor(report);
  } catch (err) {
    console.error(`[audit-mixed-org-rows] failed: ${describeError(err)}`);
    return 1;
  } finally {
    await client?.end().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; });
}
