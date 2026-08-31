import { stripHtml } from '@/lib/strip-html';

export type AgentActionForPresentation = {
  action: string;
  params: Record<string, any>;
  approval_tier?: 'auto' | 'quick' | 'full' | string | null;
  source?: string | null;
  employee_name?: string | null;
  proposer?: 'employee' | 'defty' | string | null;
  created_at?: string;
};

export type ApprovalIconName =
  | 'task'
  | 'message'
  | 'knowledge'
  | 'note'
  | 'calendar'
  | 'canvas'
  | 'module'
  | 'plan'
  | 'admin'
  | 'generic';

export type ApprovalChipIconName =
  | 'user'
  | 'calendar'
  | 'project'
  | 'book'
  | 'task'
  | 'message'
  | 'shield'
  | 'clock'
  | 'tag';

export type ApprovalCardPresentation = {
  kind:
    | 'task_create'
    | 'task_update'
    | 'message'
    | 'knowledge'
    | 'note'
    | 'calendar'
    | 'canvas'
    | 'module'
    | 'app_run'
    | 'plan'
    | 'admin'
    | 'generic';
  icon: ApprovalIconName;
  eyebrow: string;
  headline: string;
  title: string;
  summary: string;
  approveLabel: string;
  doneLabel: string;
  sourceLabel: string;
  detailsLabel: string;
  emptyDetails: string;
  badge?: string;
  badgeTone?: 'neutral' | 'caution' | 'danger';
  chips: Array<{ label: string; icon?: ApprovalChipIconName }>;
};

const INTERNAL_APPROVAL_PARAM_KEYS = new Set([
  'idempotency_key',
  'expected_manifest_digest',
  'expected_revision',
  'manifest_digest',
  'proposal_node_id',
  'proposal_depends_on',
  'source_message_id',
  'source_space_id',
  'origin_space_id',
  'requested_by_user_id',
  'agent_employee_id',
  'org_id',
  'user_id',
]);

export function getSafeGenericParams(params: Record<string, unknown>) {
  return Object.entries(params).filter(([key, value]) => {
    if (value === undefined || value === null || value === '') return false;
    if (INTERNAL_APPROVAL_PARAM_KEYS.has(key)) return false;
    if (key.startsWith('proposal_') || key.startsWith('debug_')) return false;
    if (key.endsWith('_id') || key.endsWith('_ids')) return false;
    return true;
  });
}

function cleanText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return stripHtml(value).replace(/\s+/g, ' ').trim();
}

export function truncateApprovalText(value: string, max = 140) {
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 3)}...` : cleaned;
}

export function getStringParam(params: Record<string, any>, keys: string[]) {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === 'string' && value.trim()) return cleanText(value);
  }
  return '';
}

function getNestedStringParam(params: Record<string, any>, keys: string[]) {
  for (const key of keys) {
    const parts = key.split('.');
    let value: unknown = params;
    for (const part of parts) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        value = undefined;
        break;
      }
      value = (value as Record<string, unknown>)[part];
    }
    if (typeof value === 'string' && value.trim()) return cleanText(value);
  }
  return '';
}

function getSubtaskDrafts(params: Record<string, any>): Array<{ title: string }> {
  const subtasks = params.subtasks;
  if (!Array.isArray(subtasks)) return [];
  return subtasks
    .map((subtask) => {
      if (!subtask || typeof subtask !== 'object') return { title: '' };
      return { title: cleanText((subtask as Record<string, unknown>).title) };
    })
    .filter((subtask) => subtask.title.length > 0);
}

function getNumberParam(params: Record<string, any>, keys: string[]) {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function getDueLabel(params: Record<string, any>) {
  const value = getNestedStringParam(params, [
    'due_date',
    'dueDate',
    'deadline',
    'due_at',
    'scheduled_for',
    'patch.due_date',
    'remind_at',
  ]);
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isFinite(parsed.getTime()) && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    return parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  return truncateApprovalText(value, 30);
}

function getScopeLabel(params: Record<string, any>) {
  const scope = getStringParam(params, ['scope', 'visibility']);
  if (scope === 'org') return 'Team-wide';
  if (scope === 'space') return params.space_name ? `#${cleanText(params.space_name)}` : 'Space scoped';
  if (scope === 'user') return 'Personal';
  if (scope === 'private') return 'Private';
  if (scope) return scope.replaceAll('_', ' ');
  if (params.source_space_id || params.space_id) return 'Space source';
  return '';
}

function formatConfidence(value: number | null) {
  if (value === null) return '';
  const normalized = value > 1 ? value / 100 : value;
  const clamped = Math.max(0, Math.min(1, normalized));
  if (clamped >= 0.8) return `${Math.round(clamped * 100)}% confidence`;
  if (clamped >= 0.55) return `${Math.round(clamped * 100)}% confidence`;
  return `${Math.round(clamped * 100)}% confidence`;
}

function formatAge(createdAt?: string) {
  if (!createdAt) return '';
  const ageMs = Date.now() - new Date(createdAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) return '';
  const minutes = Math.floor(ageMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m old`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h old`;
  const days = Math.floor(hours / 24);
  return `${days}d old`;
}

function pushChip(
  chips: ApprovalCardPresentation['chips'],
  label: string,
  icon?: ApprovalChipIconName,
) {
  if (!label) return;
  if (chips.some((chip) => chip.label.toLowerCase() === label.toLowerCase())) return;
  chips.push({ label: truncateApprovalText(label, 34), icon });
}

function getTaskIdentity(params: Record<string, any>) {
  return getNestedStringParam(params, [
    'task_identifier',
    'task_id',
    'task_number',
    'id',
    'patch.task_identifier',
  ]);
}

function getTaskPatchSummary(params: Record<string, any>, actionName = '') {
  const task = getTaskIdentity(params) || 'task';
  const status = getNestedStringParam(params, ['new_status', 'status', 'patch.status']);
  const assignee = getNestedStringParam(params, ['assignee_name', 'assignee', 'patch.assignee_name']);
  const priority = getNestedStringParam(params, ['priority', 'patch.priority']);
  const due = getDueLabel(params);
  const label = getNestedStringParam(params, ['label_name', 'patch.label_name']);
  const comment = getNestedStringParam(params, ['comment', 'content', 'patch.comment']);

  if (actionName === 'close_task') return `Mark ${task} done`;
  if (actionName === 'reopen_task') return `Reopen ${task}`;
  if (status) return `Move ${task} to ${status.replaceAll('_', ' ')}`;
  if (assignee) return `Assign ${task} to ${assignee}`;
  if (priority) return `Set ${task} to ${priority.toUpperCase()}`;
  if (due) return `Set ${task} due ${due}`;
  if (label) return `Add ${label} to ${task}`;
  if (comment) return `Comment on ${task}`;
  return `Update ${task}`;
}

function actionKind(actionName: string): ApprovalCardPresentation['kind'] {
  if (['create_task', 'task_create'].includes(actionName)) return 'task_create';
  if (
    [
      'task_update',
      'update_task',
      'update_task_status',
      'assign_task',
      'comment_on_task',
      'set_due_date',
      'set_priority',
      'add_label',
      'close_task',
      'reopen_task',
      'add_dependency',
      'remove_dependency',
      'task_transition',
    ].includes(actionName)
  ) return 'task_update';
  if (['post_message', 'message_post', 'send_message', 'post_thread_reply'].includes(actionName)) return 'message';
  if (
    [
      'wiki_create',
      'wiki_update',
      'wiki_write',
      'memory_update',
      'add_knowledge',
      'note_to_wiki',
      'link_decision_to_tasks',
      'mark_decision_implemented',
    ].includes(actionName)
  ) return 'knowledge';
  if (['create_note'].includes(actionName)) return 'note';
  if (['create_reminder', 'schedule_meeting', 'calendar_create', 'calendar_update'].includes(actionName)) return 'calendar';
  if (['write_canvas'].includes(actionName)) return 'canvas';
  if (
    ['module_record_create', 'module_record_bulk_create', 'module_record_update', 'module_record_archive'].includes(actionName)
  ) return 'module';
  if (['create_plan'].includes(actionName)) return 'plan';
  if (
    [
      'manage_agent_employee',
      'manage_mcp_connection',
      'manage_triggers',
      'remove_member',
    ].includes(actionName) ||
    actionName.startsWith('delete_')
  ) return 'admin';
  return 'generic';
}

function getMessageTarget(params: Record<string, any>) {
  const space = getNestedStringParam(params, ['space_name', 'target.space_name']);
  if (space) return `#${space}`;
  const spaceId = getNestedStringParam(params, ['space_id', 'resolved_space_id', 'target.space_id']);
  if (spaceId) return 'selected space';
  const user = getNestedStringParam(params, ['target.user_name', 'user_name']);
  if (user) return user;
  const thread = getNestedStringParam(params, ['parent_message_id', 'thread_id', 'target.thread_id']);
  if (thread) return 'thread';
  return 'chat';
}

export function getAgentActionPresentation(action: AgentActionForPresentation): ApprovalCardPresentation {
  const { params } = action;
  const kind = actionKind(action.action);
  const title = getStringParam(params, ['title', 'name', 'summary']);
  const content = getNestedStringParam(params, ['description', 'content', 'summary', 'patch.description']);
  const assignee = getNestedStringParam(params, ['assignee_name', 'assignee', 'patch.assignee_name']);
  const due = getDueLabel(params);
  const project = getNestedStringParam(params, ['project_name', 'project', 'project_title']);
  const priority = getNestedStringParam(params, ['priority', 'patch.priority']);
  const type = getStringParam(params, ['type']);
  const scope = getScopeLabel(params);
  const confidence = formatConfidence(getNumberParam(params, ['confidence', 'capture_confidence', 'classification_confidence']));
  const age = formatAge(action.created_at);
  const chips: ApprovalCardPresentation['chips'] = [];

  if (action.action === 'app_run_invoke' || action.source === 'app_run') {
    const previewTitle = getNestedStringParam(params, ['safe_preview.title']);
    const previewSummary = getNestedStringParam(params, ['safe_preview.summary']);
    const provider = getStringParam(params, ['provider_label']);
    const capability = getStringParam(params, ['capability_label']);
    const preview = params.safe_preview && typeof params.safe_preview === 'object' && !Array.isArray(params.safe_preview)
      ? params.safe_preview as Record<string, unknown>
      : {};
    const resourceRefs = Array.isArray(preview.resource_refs) ? preview.resource_refs : [];
    for (const candidate of resourceRefs) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
      const label = cleanText((candidate as Record<string, unknown>).label);
      pushChip(chips, label, 'project');
    }
    pushChip(chips, capability, 'shield');
    return {
      kind: 'app_run',
      icon: 'generic',
      eyebrow: 'Connected App action',
      headline: 'An App prepared a governed action',
      title: previewTitle || capability || 'Run App action',
      summary: previewSummary ? truncateApprovalText(previewSummary, 150) : 'Review the safe preview before Deft releases this action to the selected provider.',
      approveLabel: 'Approve App action',
      doneLabel: 'App action approved',
      sourceLabel: provider ? `Provider: ${provider}` : 'Source: Connected App',
      detailsLabel: 'Safe App preview',
      emptyDetails: 'Provider input remains sealed. Deft revalidates App, grant, connector, and resource authority before execution.',
      badge: 'Governed Run',
      badgeTone: 'caution',
      chips,
    };
  }

  if (kind === 'task_create') {
    const subtasks = getSubtaskDrafts(params);
    pushChip(chips, assignee, 'user');
    pushChip(chips, due, 'calendar');
    pushChip(chips, project, 'project');
    if (subtasks.length > 0) pushChip(chips, `${subtasks.length} subtasks`, 'task');
    pushChip(chips, priority.toUpperCase(), 'task');
    return {
      kind,
      icon: 'task',
      eyebrow: 'Task draft',
      headline: 'Defty drafted a task',
      title: title || 'Create a task',
      summary: content
        ? truncateApprovalText(content, 140)
        : subtasks.length > 0
          ? `Creates a parent task with ${subtasks.length} subtasks: ${truncateApprovalText(subtasks.map((subtask) => subtask.title).join(', '), 110)}`
          : 'Review the proposed task before it is added to the workspace.',
      approveLabel: 'Approve task',
      doneLabel: 'Task created',
      sourceLabel: age ? `Source: Defty - ${age}` : 'Source: Defty',
      detailsLabel: 'Task details',
      emptyDetails: 'Prepared from this thread. A receipt is saved after approval or dismissal.',
      badge: priority ? priority.toUpperCase() : undefined,
      badgeTone: 'caution',
      chips,
    };
  }

  if (kind === 'task_update') {
    const task = getTaskIdentity(params);
    pushChip(chips, task, 'task');
    pushChip(chips, getNestedStringParam(params, ['new_status', 'status', 'patch.status']).replaceAll('_', ' '), 'tag');
    pushChip(chips, assignee, 'user');
    pushChip(chips, due, 'calendar');
    pushChip(chips, priority.toUpperCase(), 'task');
    return {
      kind,
      icon: 'task',
      eyebrow: 'Task update',
      headline: 'Defty drafted a task update',
      title: getTaskPatchSummary(params, action.action),
      summary: content ? truncateApprovalText(content, 140) : 'Review the proposed task change before it is applied.',
      approveLabel: 'Approve update',
      doneLabel: 'Task updated',
      sourceLabel: age ? `Source: Defty - ${age}` : 'Source: Defty',
      detailsLabel: 'Change details',
      emptyDetails: 'The card shows the proposed task mutation. A receipt is saved after approval or dismissal.',
      chips,
    };
  }

  if (kind === 'message') {
    const target = getMessageTarget(params);
    pushChip(chips, target, 'message');
    pushChip(chips, age, 'clock');
    return {
      kind,
      icon: 'message',
      eyebrow: 'Message draft',
      headline: 'Defty drafted a message',
      title: `Post to ${target}`,
      summary: content ? truncateApprovalText(content, 150) : 'Review the exact message before it is posted.',
      approveLabel: 'Approve post',
      doneLabel: 'Message posted',
      sourceLabel: age ? `Source: Defty - ${age}` : 'Source: Defty',
      detailsLabel: 'Full message',
      emptyDetails: 'Nothing is posted until you approve this draft.',
      badge: 'Visible',
      badgeTone: 'caution',
      chips,
    };
  }

  if (kind === 'knowledge') {
    pushChip(chips, type.replaceAll('_', ' '), 'book');
    pushChip(chips, scope, 'shield');
    pushChip(chips, confidence, 'tag');
    return {
      kind,
      icon: 'knowledge',
      eyebrow: action.action.includes('update') || action.action === 'memory_update' ? 'Knowledge update' : 'Knowledge draft',
      headline: 'Defty drafted a knowledge change',
      title: title || getNestedStringParam(params, ['slug']) || 'Save knowledge',
      summary: content ? truncateApprovalText(content, 150) : 'Review what will be saved into shared memory.',
      approveLabel: action.action.includes('update') ? 'Approve update' : 'Approve save',
      doneLabel: action.action.includes('update') ? 'Knowledge updated' : 'Knowledge saved',
      sourceLabel: age ? `Source: Defty - ${age}` : 'Source: Defty',
      detailsLabel: 'Knowledge preview',
      emptyDetails: 'This changes the workspace memory. Review scope and source before approving.',
      chips,
    };
  }

  if (kind === 'note') {
    pushChip(chips, scope || 'Private', 'book');
    pushChip(chips, age, 'clock');
    return {
      kind,
      icon: 'note',
      eyebrow: 'Note draft',
      headline: 'Defty drafted a note',
      title: title || 'Create a note',
      summary: content ? truncateApprovalText(content, 150) : 'Review the note before it is saved.',
      approveLabel: 'Approve note',
      doneLabel: 'Note saved',
      sourceLabel: age ? `Source: Defty - ${age}` : 'Source: Defty',
      detailsLabel: 'Note preview',
      emptyDetails: 'This creates a note using the visibility shown above.',
      chips,
    };
  }

  if (kind === 'calendar') {
    pushChip(chips, due, 'calendar');
    pushChip(chips, getNestedStringParam(params, ['attendee_name', 'attendees']), 'user');
    return {
      kind,
      icon: 'calendar',
      eyebrow: action.action === 'create_reminder' ? 'Reminder draft' : 'Calendar draft',
      headline: 'Defty drafted a calendar change',
      title: title || content || 'Create reminder',
      summary: content ? truncateApprovalText(content, 150) : 'Review the timing before this is scheduled.',
      approveLabel: action.action === 'create_reminder' ? 'Approve reminder' : 'Approve calendar',
      doneLabel: action.action === 'create_reminder' ? 'Reminder created' : 'Calendar updated',
      sourceLabel: age ? `Source: Defty - ${age}` : 'Source: Defty',
      detailsLabel: 'Timing details',
      emptyDetails: 'This will create or change a scheduled item.',
      chips,
    };
  }

  if (kind === 'canvas') {
    pushChip(chips, getNestedStringParam(params, ['space_name']), 'project');
    return {
      kind,
      icon: 'canvas',
      eyebrow: 'Canvas update',
      headline: 'Defty drafted a canvas update',
      title: title || 'Update shared canvas',
      summary: content ? truncateApprovalText(content, 150) : 'Review the shared canvas change before applying it.',
      approveLabel: 'Approve canvas',
      doneLabel: 'Canvas updated',
      sourceLabel: age ? `Source: Defty - ${age}` : 'Source: Defty',
      detailsLabel: 'Canvas preview',
      emptyDetails: 'This changes a shared surface visible to the space.',
      chips,
    };
  }

  if (kind === 'module') {
    const proposerName = action.proposer === 'employee' && action.employee_name
      ? action.employee_name
      : 'Defty';
    const moduleName = getNestedStringParam(params, [
      'module_name',
      'module.name',
      'module_slug',
      'module.slug',
      'slug',
    ]);
    const collectionName = getNestedStringParam(params, [
      'collection_name',
      'collection.name',
      'collection_key',
      'collection.key',
    ]);
    const recordTitle = getNestedStringParam(params, [
      'record_title',
      'title',
      'data.name',
      'data.title',
      'patch.name',
      'patch.title',
    ]);
    const isCreate = action.action === 'module_record_create';
    const isBulkCreate = action.action === 'module_record_bulk_create';
    const isArchive = action.action === 'module_record_archive';
    const operation = isBulkCreate ? 'import' : isCreate ? 'create' : isArchive ? 'archive' : 'update';
    const rowCount = Array.isArray(params.rows)
      ? params.rows.length
      : typeof params.row_count === 'number' ? params.row_count : 0;
    const sourceFileName = getNestedStringParam(params, ['source_file_name']);

    pushChip(chips, moduleName, 'project');
    pushChip(chips, collectionName.replaceAll('_', ' '), 'book');
    return {
      kind,
      icon: 'module',
      eyebrow: isBulkCreate ? 'Module import draft' : isCreate ? 'Module record draft' : isArchive ? 'Module archive' : 'Module record update',
      headline: `${proposerName} proposed a module ${operation}`,
      title: isBulkCreate
        ? `Import ${rowCount || ''} ${collectionName || 'module'} record${rowCount === 1 ? '' : 's'}`.replace(/\s+/g, ' ').trim()
        : recordTitle || `${operation[0].toUpperCase()}${operation.slice(1)} ${collectionName || 'record'}`,
      summary: content
        ? truncateApprovalText(content, 150)
        : isBulkCreate
          ? `Review ${rowCount} validated row${rowCount === 1 ? '' : 's'}${sourceFileName ? ` from ${sourceFileName}` : ''} before import.`
          : `Review this ${collectionName || 'module'} record change before it is applied.`,
      approveLabel: isBulkCreate ? 'Approve import' : isCreate ? 'Approve create' : isArchive ? 'Approve archive' : 'Approve update',
      doneLabel: isBulkCreate ? 'Records imported' : isCreate ? 'Record created' : isArchive ? 'Record archived' : 'Record updated',
      sourceLabel: age ? `Source: ${proposerName} - ${age}` : `Source: ${proposerName}`,
      detailsLabel: isBulkCreate ? 'Import details' : 'Record details',
      emptyDetails: 'The module manifest validates this change before it is applied.',
      badge: isArchive ? 'Archive' : moduleName || undefined,
      badgeTone: isArchive ? 'danger' : 'neutral',
      chips,
    };
  }

  if (kind === 'plan') {
    const steps = Array.isArray(params.steps) ? params.steps.length : null;
    pushChip(chips, steps ? `${steps} steps` : '', 'task');
    return {
      kind,
      icon: 'plan',
      eyebrow: 'Plan draft',
      headline: 'Defty drafted a plan',
      title: title || 'Review plan',
      summary: content ? truncateApprovalText(content, 150) : 'Review the sequence before Defty starts executing.',
      approveLabel: 'Approve plan',
      doneLabel: 'Plan approved',
      sourceLabel: age ? `Source: Defty - ${age}` : 'Source: Defty',
      detailsLabel: 'Plan details',
      emptyDetails: 'Plan steps are listed in the details payload.',
      badge: 'Multi-step',
      badgeTone: 'caution',
      chips,
    };
  }

  if (kind === 'admin') {
    const target = getNestedStringParam(params, ['target', 'mode', 'name', 'slug']);
    pushChip(chips, target, 'shield');
    return {
      kind,
      icon: 'admin',
      eyebrow: 'Admin review',
      headline: 'Defty drafted an admin change',
      title: title || action.action.replaceAll('_', ' '),
      summary: content ? truncateApprovalText(content, 150) : 'Review this workspace-level change carefully.',
      approveLabel: 'Approve change',
      doneLabel: 'Admin change applied',
      sourceLabel: age ? `Source: Defty - ${age}` : 'Source: Defty',
      detailsLabel: 'Admin details',
      emptyDetails: 'This may affect workspace access, agents, or connected apps.',
      badge: 'Sensitive',
      badgeTone: 'danger',
      chips,
    };
  }

  pushChip(chips, age, 'clock');
  return {
    kind,
    icon: 'generic',
    eyebrow: 'Action draft',
    headline: `Defty drafted ${action.action.replaceAll('_', ' ')}`,
    title: title || action.action.replaceAll('_', ' '),
    summary: content ? truncateApprovalText(content, 150) : 'Review the proposed action before it runs.',
    approveLabel: 'Approve',
    doneLabel: 'Action completed',
    sourceLabel: age ? `Source: Defty - ${age}` : 'Source: Defty',
    detailsLabel: 'Action details',
    emptyDetails: 'Review the parameters below before approving.',
    chips,
  };
}
