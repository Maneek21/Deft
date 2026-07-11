import { and, eq, inArray, sql } from 'drizzle-orm';
import { agentActions, messages, orgs, projects } from '@deft/db/schema';
import { getApprovalTier } from './agent-approval.js';
import { db } from './db.js';
import { getOrgAIConfig } from './org-ai-config.js';
import { llm } from './llm.js';
import { truncatePlainText } from './plain-text.js';
import { ACTION_TOOLS, AGENT_TOOLS } from './agent-tools.js';
import { buildActionGraph, type ActionGraph } from './agent-action-graph.js';

type ApprovalTier = 'auto' | 'quick' | 'full';

export type ProposedAgentAction = {
  action: string;
  params: Record<string, any>;
  approval_tier?: ApprovalTier;
  tool_use_id?: string | null;
  source?: string | null;
  node_id?: string;
  depends_on?: string[];
  idempotency_key?: string;
};

type PersistReplyWithActionsParams = {
  orgId: string;
  spaceId: string;
  userId: string;
  agentUserId: string;
  content: string;
  parentId?: string | null;
  metadata: Record<string, any>;
  pendingActions: ProposedAgentAction[];
};

export async function persistAgentReplyWithActions(params: PersistReplyWithActionsParams) {
  return db.transaction(async (tx) => {
    const novelActions: ProposedAgentAction[] = [];
    const duplicateActions: Array<typeof agentActions.$inferSelect> = [];
    const seenKeys = new Set<string>();
    for (const action of params.pendingActions) {
      const key = typeof action.params.idempotency_key === 'string' ? action.params.idempotency_key : '';
      if (!key) {
        novelActions.push(action);
        continue;
      }
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      const [existing] = await tx
        .select()
        .from(agentActions)
        .where(and(
          eq(agentActions.org_id, params.orgId),
          eq(agentActions.user_id, params.userId),
          inArray(agentActions.approval_status, ['pending', 'approved']),
          sql`${agentActions.params}->>'idempotency_key' = ${key}`,
        ))
        .limit(1);
      if (existing) duplicateActions.push(existing);
      else novelActions.push(action);
    }

    const duplicateOnly = params.pendingActions.length > 0 && novelActions.length === 0 && duplicateActions.length > 0;
    const messageContent = duplicateOnly
      ? duplicateActions.every((action) => action.approval_status === 'approved')
        ? 'This request was already approved and completed.'
        : 'I already drafted this request. Use the existing approval card to review it.'
      : params.content;
    const messageMetadata = {
      ...params.metadata,
      pending_actions: novelActions.length > 0 ? novelActions : undefined,
      duplicate_action_ids: duplicateActions.length > 0 ? duplicateActions.map((action) => action.id) : undefined,
    };
    const [agentMessage] = await tx
      .insert(messages)
      .values({
        org_id: params.orgId,
        space_id: params.spaceId,
        user_id: params.agentUserId,
        content: messageContent,
        parent_id: params.parentId ?? null,
        metadata: messageMetadata as never,
      })
      .returning();

    if (!agentMessage) throw new Error('Failed to create agent reply message');

    if (novelActions.length === 0) {
      return { message: agentMessage, actions: [], duplicates: duplicateActions };
    }

    const actions = await tx
      .insert(agentActions)
      .values(
        novelActions.map((p) => ({
          org_id: params.orgId,
          user_id: params.userId,
          conversation_id: params.spaceId,
          message_id: agentMessage.id,
          action: p.action,
          params: p.params,
          approval_tier: normalizeApprovalTier(p),
          approval_status: 'pending' as const,
          source: p.source ?? 'mention',
          tool_use_id: p.tool_use_id ?? null,
        })),
      )
      .returning();

    return { message: agentMessage, actions, duplicates: duplicateActions };
  });
}

function normalizeApprovalTier(action: ProposedAgentAction): ApprovalTier {
  const tier = action.approval_tier ?? getApprovalTier(action.action);
  return tier === 'auto' ? 'quick' : tier;
}

export type CompiledActionDraft = {
  actions: ProposedAgentAction[];
  graph: ActionGraph;
  clarification?: string;
  summary?: string;
  metrics: {
    duration_ms: number;
    tokens_in: number;
    tokens_out: number;
    model: string;
  };
};

type CompileDeftyActionDraftParams = {
  orgId: string;
  promptContent: string;
  agentReplyText?: string;
  sourceMessageId: string;
  projectNameHint?: string | null;
  priorTaskReferences?: string[];
  spaceName?: string | null;
  callerName?: string | null;
  allowedActionNames?: string[];
};

const CLARIFICATION_TOOL = {
  name: 'request_action_clarification',
  description: 'Ask one concise question only when a required write target cannot be inferred safely.',
  input_schema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The single clarification question to ask.' },
      summary: { type: 'string', description: 'What is already understood about the requested action.' },
    },
    required: ['question'],
  },
};

/** The compiler and executor share one action vocabulary. */
export function getActionCompilerTools() {
  return [
    ...AGENT_TOOLS.filter((tool) => ACTION_TOOLS.has(tool.name)),
    CLARIFICATION_TOOL,
  ];
}

export function getActionCompilerToolsForPrompt(promptContent: string, allowedActionNames?: string[]) {
  const allowlist = allowedActionNames?.length ? new Set(allowedActionNames) : null;
  const tools = allowlist
    ? getActionCompilerTools().filter((tool) => allowlist.has(tool.name) || tool.name === CLARIFICATION_TOOL.name)
    : getActionCompilerTools();
  if (/\b(?:remind\s+me|create\s+(?:a\s+)?reminder|set\s+(?:a\s+)?reminder)\b/i.test(promptContent)) {
    return tools.filter((tool) => tool.name === 'create_reminder');
  }
  return tools;
}

export function validateCompiledIntentAlignment(
  promptContent: string,
  actions: ProposedAgentAction[],
  params: Pick<CompileDeftyActionDraftParams, 'projectNameHint'>,
): { blocked: boolean; clarification?: string } {
  const plain = promptContent.replace(/\s+/g, ' ').trim();
  const explicitNoWrite = /\b(?:do\s+not|don't|dont|never)\s+(?:create|queue|post|send|write|save|record|update|edit|change|mark|move|close|assign)(?:\s+or\s+(?:create|queue|post|send|write|update))?\s+(?:any\s+)?(?:tasks?|actions?|changes?|messages?|posts?|pages?|notes?|reminders?)\b/i.test(plain);
  if (explicitNoWrite) {
    return {
      blocked: true,
      clarification: 'Understood. I will not queue or execute that change.',
    };
  }

  const readOnlyLead = /^(?:please\s+)?(?:read|show|list|search|find|explain|summarize|summarise|what|which|who|when|where|how)\b/i.test(plain);
  const explicitWriteVerb = /\b(?:create|queue|post|send|write|save|record|update|edit|change|set|mark|move|close|reopen|assign|comment|link|unlink|remove|convert|remind)\b/i.test(plain);
  if (readOnlyLead && !explicitWriteVerb && actions.length > 0) {
    return { blocked: true };
  }

  const requestsReminder = /\b(?:remind\s+me|create\s+(?:a\s+)?reminder|set\s+(?:a\s+)?reminder)\b/i.test(plain);
  if (requestsReminder && actions.length > 0 && !actions.some((action) => action.action === 'create_reminder')) {
    return {
      blocked: true,
      clarification: 'I could not safely draft that as a reminder. Please include when you want to be reminded.',
    };
  }

  const taskActions = actions.filter((action) => action.action === 'create_task');
  if (taskActions.length > 0) {
    const suppliedOutcome = /\b(?:titled|called|named|name\s+(?:it|this))\b/i.test(plain)
      || /\b(?:task|todo|ticket)\s+(?:to|for|about)\s+\S/i.test(plain)
      || /\b(?:need|needs|should|must)\s+to\s+\S/i.test(plain);
    if (!suppliedOutcome) {
      return {
        blocked: true,
        clarification: 'What should this task accomplish? Give me a title or a concrete outcome.',
      };
    }

    const hasProjectHint = Boolean(params.projectNameHint?.trim());
    const suppliedProject = taskActions.some((action) => {
      const projectName = typeof action.params.project_name === 'string' ? action.params.project_name.trim() : '';
      return projectName.length > 0 && plain.toLowerCase().includes(projectName.toLowerCase());
    }) || /\bproject\b/i.test(plain);
    if (!hasProjectHint && !suppliedProject) {
      return {
        blocked: true,
        clarification: 'Which project should this task belong to?',
      };
    }
  }

  return { blocked: false };
}

export async function compileDeftyActionDraft(params: CompileDeftyActionDraftParams): Promise<CompiledActionDraft> {
  const startedAt = Date.now();
  const orgConfig = await getOrgAIConfig(params.orgId).catch(() => undefined);
  const knownProjects = await db
    .select({
      name: projects.name,
      prefix: projects.prefix,
    })
    .from(projects)
    .where(and(eq(projects.org_id, params.orgId), eq(projects.is_archived, false), eq(projects.is_deleted, false)))
    .limit(50)
    .catch(() => []);
  const [orgClock] = await db
    .select({ timezone: orgs.timezone })
    .from(orgs)
    .where(eq(orgs.id, params.orgId))
    .limit(1)
    .catch(() => []);
  const result = await llm({
    task: 'extract',
    maxTokens: 1200,
    orgConfig: orgConfig as any,
    system: [
      'You convert a Defty chat request into one or more registered Deft write tool calls.',
      'Call the exact matching write tool. Never substitute a task for a wiki, note, message, canvas, decision, or other requested object.',
      'A reminder request must use create_reminder, never create_task.',
      'Resolve relative reminder times using current_time_iso and org_timezone from the request context.',
      'Reminder content is the reminder title/body; never ask for a separate reminder title.',
      'When org_timezone is provided, treat it as the user local timezone and do not ask for another timezone.',
      'If the user explicitly says not to create, queue, post, or change something, return no write tool calls.',
      'Read-only requests such as read, show, list, search, or explain must return no write tool calls.',
      'Do not execute anything. These actions will become approval cards.',
      'Use request_action_clarification only when a required target cannot be inferred safely.',
      'Required for create_task: title and project_name. Use an exact project name from known_projects whenever possible.',
      'The task title or concrete outcome must come from the user request. Never invent the work itself.',
      'If a project hint is supplied, use it. If the user gives an informal project phrase, choose the closest exact known project name.',
      'known_projects is a resolution vocabulary, not permission to choose an arbitrary project when the user supplied no project or hint.',
      'Optional for create_task: assignee_name, priority, due_date, description, subtasks.',
      'Missing priority should default to p2. Missing due date is allowed and means no due date.',
      'For create_task descriptions, write concise markdown: short summary plus bullets when useful. Do not create an unformatted text wall.',
      'If subtasks are requested, put them in subtasks and keep the parent task description brief.',
      'Preserve subtask ordering as dependencies: when a later subtask says "after that", "after the previous step", or "after the draft", set depends_on to the matching earlier subtask using 1-based indexes.',
      'If the user says "me" or "myself", use caller_name as assignee_name when caller_name is provided.',
      'If the request refers to "all three", "both", or "those tasks", use the supplied prior task references.',
      'For ambiguous channel names, ask a clarification instead of guessing.',
      'Return no actions for read-only questions.',
    ].join('\n'),
    tools: getActionCompilerToolsForPrompt(params.promptContent, params.allowedActionNames),
    messages: [{
      role: 'user',
      content: JSON.stringify({
        user_request: params.promptContent,
        prior_defty_reply: params.agentReplyText ?? '',
        project_name_hint: params.projectNameHint ?? null,
        source_message_id: params.sourceMessageId,
        prior_task_references: params.priorTaskReferences ?? [],
        known_projects: knownProjects,
        current_space_name: params.spaceName ?? null,
        caller_name: params.callerName ?? null,
        current_time_iso: new Date().toISOString(),
        org_timezone: orgClock?.timezone ?? 'UTC',
      }),
    }],
  });

  const initiallyNormalized = normalizeCompiledToolCalls(result.toolCalls ?? [], params);
  const alignment = validateCompiledIntentAlignment(params.promptContent, initiallyNormalized.actions, params);
  const normalized = alignment.blocked
    ? { actions: [] as ProposedAgentAction[], summary: undefined }
    : initiallyNormalized;
  const parsedText = parseFirstJsonObject(result.text);
  const clarificationCall = result.toolCalls?.find((call) => call.name === CLARIFICATION_TOOL.name)?.input;
  const clarificationInput = isRecord(clarificationCall) ? clarificationCall : isRecord(parsedText) ? parsedText : null;
  const clarification = alignment.clarification ?? (clarificationInput && typeof clarificationInput.question === 'string'
    ? truncatePlainText(clarificationInput.question.trim(), 400)
    : undefined);
  const summary = clarificationInput && typeof clarificationInput.summary === 'string'
    ? truncatePlainText(clarificationInput.summary.trim(), 300)
    : normalized.summary;

  const graph = buildActionGraph(normalized.actions, params.sourceMessageId, summary ?? '');
  const actions = normalized.actions.map((action, index) => {
    const node = graph.actions[index]!;
    return {
      ...action,
      node_id: node.id,
      depends_on: node.depends_on,
      idempotency_key: node.idempotency_key,
      params: {
        ...action.params,
        proposal_node_id: node.id,
        proposal_depends_on: node.depends_on,
        idempotency_key: node.idempotency_key,
      },
    };
  });
  const draft: CompiledActionDraft = {
    actions,
    graph,
    metrics: {
      duration_ms: Date.now() - startedAt,
      tokens_in: result.usage?.input ?? 0,
      tokens_out: result.usage?.output ?? 0,
      model: result.model,
    },
  };
  if (clarification) draft.clarification = clarification;
  if (summary) draft.summary = summary;
  return draft;
}

export function normalizeCompiledToolCalls(
  calls: Array<{ name?: string; input?: unknown }>,
  params: CompileDeftyActionDraftParams,
): { actions: ProposedAgentAction[]; summary?: string } {
  const actions = calls.flatMap((call) => normalizeRegisteredToolCall(call, params));
  if (actions.length === 0) return { actions };
  return {
    actions,
    summary: actions.length === 1
      ? `I drafted a ${humanizeAction(actions[0]!.action)} for approval.`
      : `I drafted ${actions.length} related changes for approval.`,
  };
}

function normalizeRegisteredToolCall(
  call: { name?: string; input?: unknown },
  params: CompileDeftyActionDraftParams,
): ProposedAgentAction[] {
  const action = typeof call.name === 'string' ? call.name : '';
  if (!ACTION_TOOLS.has(action) || !isRecord(call.input)) return [];

  if (action === 'create_task') {
    return normalizeCompiledAction({ action, ...call.input }, params);
  }
  if (action === 'update_task_status') {
    return normalizeCompiledAction({ action, ...call.input }, params);
  }
  if (action === 'post_message') {
    return normalizeCompiledAction({ action, ...call.input }, params);
  }

  const validation = validateRegisteredProposalAction({ action, params: call.input });
  if (!validation.ok) return [];
  const requestedWikiWriteMode = action === 'wiki_write'
    ? inferRequestedWikiWriteMode(params.promptContent)
    : undefined;
  const requestedWikiUpdateOperation = requestedWikiWriteMode === 'update'
    ? inferRequestedWikiUpdateOperation(params.promptContent)
    : undefined;
  const requestedWikiTypeChange = requestedWikiWriteMode === 'update'
    ? /\b(?:change|set|make)\b.{0,50}\btype\b/i.test(params.promptContent)
    : false;
  return [{
    action,
    params: {
      ...call.input,
      ...(requestedWikiWriteMode ? { requested_wiki_write_mode: requestedWikiWriteMode } : {}),
      ...(requestedWikiUpdateOperation ? { requested_wiki_update_operation: requestedWikiUpdateOperation } : {}),
      ...(requestedWikiTypeChange ? { requested_wiki_type_change: true } : {}),
      source_message_id: params.sourceMessageId,
    },
    approval_tier: getApprovalTier(action),
    tool_use_id: null,
    source: 'action_compiler',
  }];
}

function inferRequestedWikiUpdateOperation(promptContent: string): 'append' | 'replace' {
  return /\b(?:add|append|include|insert)\b/i.test(promptContent) ? 'append' : 'replace';
}

function inferRequestedWikiWriteMode(promptContent: string): 'create' | 'update' | undefined {
  const plain = promptContent.replace(/\s+/g, ' ').trim();
  if (/\b(?:update|edit|revise|correct|append|add\s+.+?\s+to)\b/i.test(plain)) return 'update';
  if (/\b(?:create|make|start|write|save|record|capture)\b.{0,100}\b(?:wiki|knowledge)(?:\s+page)?\b/i.test(plain)) {
    return 'create';
  }
  return undefined;
}

export function validateRegisteredProposalAction(action: {
  action?: unknown;
  params?: unknown;
}): { ok: true } | { ok: false; message: string } {
  const name = typeof action.action === 'string' ? action.action : '';
  if (!ACTION_TOOLS.has(name)) {
    return { ok: false, message: `The requested action "${name || 'unknown'}" is not a registered approval action.` };
  }
  if (!isRecord(action.params)) {
    return { ok: false, message: `The ${humanizeAction(name)} draft is missing its parameters.` };
  }

  const tool = AGENT_TOOLS.find((candidate) => candidate.name === name);
  if (!tool) {
    return { ok: false, message: `The ${humanizeAction(name)} action has no registered tool contract.` };
  }

  const schema: Record<string, any> = isRecord(tool.input_schema) ? tool.input_schema : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (typeof key !== 'string') continue;
    const value = action.params[key];
    if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) {
      return { ok: false, message: `The ${humanizeAction(name)} draft needs ${humanizeAction(key)}.` };
    }
  }

  const properties = isRecord(schema.properties) ? schema.properties : {};
  for (const [key, definition] of Object.entries(properties)) {
    const value = action.params[key];
    if (value === undefined || !isRecord(definition)) continue;
    if (Array.isArray(definition.enum) && !definition.enum.includes(value)) {
      return { ok: false, message: `The ${humanizeAction(name)} draft has an invalid ${humanizeAction(key)}.` };
    }
    if (definition.type === 'array' && !Array.isArray(value)) {
      return { ok: false, message: `The ${humanizeAction(name)} draft needs ${humanizeAction(key)} as a list.` };
    }
    if (definition.type === 'array' && typeof definition.minItems === 'number' && value.length < definition.minItems) {
      return { ok: false, message: `The ${humanizeAction(name)} draft needs at least ${definition.minItems} ${humanizeAction(key)} item.` };
    }
  }

  if (name === 'wiki_write' && !action.params.slug) {
    for (const key of ['title', 'type']) {
      if (!action.params[key]) {
        return { ok: false, message: `A new wiki page needs ${humanizeAction(key)}.` };
      }
    }
  }
  if (name === 'create_note' && action.params.visibility === 'space' && !action.params.visibility_space_id) {
    return { ok: false, message: 'A space-visible note needs the exact target space.' };
  }

  return { ok: true };
}

function humanizeAction(action: string) {
  return action.replace(/_/g, ' ');
}

function normalizeCompiledAction(raw: unknown, params: CompileDeftyActionDraftParams): ProposedAgentAction[] {
  if (!isRecord(raw) || typeof raw.action !== 'string') return [];

  if (raw.action === 'create_task') {
    const title = stringValue(raw.title);
    const projectName = stringValue(raw.project_name) || params.projectNameHint || '';
    if (!title || !projectName) return [];
    const subtasks = normalizeCompiledSubtasks(raw.subtasks, params);
    return [{
      action: 'create_task',
      params: removeUndefined({
        title: truncatePlainText(title, 120),
        project_name: truncatePlainText(projectName, 160),
        priority: normalizePriority(raw.priority) ?? 'p2',
        assignee_name: normalizeCompiledAssignee(raw.assignee_name, params) || undefined,
        due_date: normalizeDueDate(raw.due_date),
        description: normalizeCompiledTaskDescription(raw.description, params.promptContent, title, subtasks),
        subtasks,
        source_message_id: params.sourceMessageId,
      }),
      approval_tier: getApprovalTier('create_task'),
      tool_use_id: null,
      source: 'action_compiler',
    }];
  }

  if (raw.action === 'update_task_status') {
    const requestedStatus = normalizeStatus(raw.new_status);
    const directTarget = stringValue(raw.task_identifier);
    const taskTargets = looksLikeTaskIdentifier(directTarget)
      ? [directTarget]
      : selectPriorTaskReferences(params.priorTaskReferences ?? [], params.promptContent);
    if (!requestedStatus || taskTargets.length === 0 || taskTargets.length > 3) return [];
    return taskTargets.map((taskIdentifier) => ({
      action: 'update_task_status',
      params: {
        task_identifier: taskIdentifier.toUpperCase(),
        new_status: requestedStatus,
        source_message_id: params.sourceMessageId,
      },
      approval_tier: 'quick',
      tool_use_id: null,
      source: 'action_compiler',
    }));
  }

  if (raw.action === 'post_message') {
    const spaceName = stringValue(raw.space_name);
    const content = stringValue(raw.content);
    if (!spaceName || !content) return [];
    return [{
      action: 'post_message',
      params: {
        space_name: spaceName.replace(/^#/, ''),
        content: truncatePlainText(content, 4000),
        source_message_id: params.sourceMessageId,
      },
      approval_tier: getApprovalTier('post_message'),
      tool_use_id: null,
      source: 'action_compiler',
    }];
  }

  return [];
}

function normalizeCompiledTaskDescription(
  value: unknown,
  promptContent: string,
  title: string,
  subtasks: ReturnType<typeof normalizeCompiledSubtasks>,
) {
  const raw = stringValue(value);
  const prompt = promptContent.trim();
  const normalizedRaw = normalizeDescriptionFingerprint(raw);
  const normalizedPrompt = normalizeDescriptionFingerprint(prompt);
  const containsSubtaskDump = Boolean(subtasks?.length) && (
    /\*{0,2}subtasks?\*{0,2}\s*:/i.test(raw) ||
    subtasks!.filter((subtask) => raw.toLowerCase().includes(subtask.title.toLowerCase())).length >= 2
  );
  const looksLikePromptEcho =
    !raw ||
    raw.length > 700 ||
    containsSubtaskDump ||
    (normalizedPrompt.length > 60 && normalizedRaw.includes(normalizedPrompt.slice(0, 80))) ||
    /\bcreate\s+a\s+task\b/i.test(raw) ||
    /\bwith\s+(?:three|two|\d+)\s+subtasks\b/i.test(raw);

  if (!looksLikePromptEcho) return truncatePlainText(raw, 1200);

  const lead = raw
    .split(/(?:\r?\n|[-*]\s*)?\*{0,2}subtasks?\*{0,2}\s*:/i)[0]
    ?.replace(/[-*\s]+$/g, '')
    .trim();
  return truncatePlainText(lead && lead.length >= 20 ? lead : `Coordinate ${title}.`, 1200);
}

function normalizeDescriptionFingerprint(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function looksLikeTaskIdentifier(value: string) {
  return /\b(?:[A-Z]{2,12}-\d+|[0-9a-f]{8}-[0-9a-f-]{27})\b/i.test(value);
}

function normalizeCompiledSubtasks(value: unknown, params: CompileDeftyActionDraftParams) {
  if (!Array.isArray(value)) return undefined;
  const subtasks = value
    .map((raw) => {
      if (!isRecord(raw)) return null;
      const title = stringValue(raw.title);
      if (!title) return null;
      return removeUndefined({
        title: truncatePlainText(title, 120),
        description: stringValue(raw.description) || undefined,
        assignee_name: normalizeCompiledAssignee(raw.assignee_name, params) || undefined,
        priority: normalizePriority(raw.priority) ?? undefined,
        due_date: normalizeDueDate(raw.due_date),
        depends_on: Array.isArray(raw.depends_on)
          ? raw.depends_on.filter((value: unknown) => Number.isInteger(value))
          : undefined,
      });
    })
    .filter((subtask): subtask is NonNullable<typeof subtask> => Boolean(subtask));
  if (subtasks.length === 0) return undefined;

  return subtasks.map((subtask, index) => {
    if (subtask.depends_on?.length || index === 0) return subtask;
    const inferred = inferSubtaskDependencies(
      [subtask.title, subtask.description].filter(Boolean).join(' '),
      subtasks,
      index,
    );
    if (inferred.length === 0) return subtask;
    return { ...subtask, depends_on: inferred };
  });
}

function inferSubtaskDependencies(
  meaning: string,
  subtasks: Array<{ title: string; description?: string; depends_on?: number[] }>,
  index: number,
): number[] {
  const normalized = meaning.toLowerCase();
  if (/\bafter\s+(?:that|this|the previous (?:step|task)|the prior (?:step|task))\b/.test(normalized)) {
    return [index];
  }

  const namedDependency = normalized.match(/\bafter\s+(?:the\s+)?([a-z][a-z0-9-]*)\b/)?.[1];
  if (!namedDependency) return [];
  const candidates = subtasks
    .slice(0, index)
    .map((candidate, candidateIndex) => ({
      index: candidateIndex + 1,
      matches: [candidate.title, candidate.description]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(namedDependency),
    }))
    .filter((candidate) => candidate.matches);
  return candidates.length === 1 ? [candidates[0]!.index] : [];
}

function normalizeCompiledAssignee(value: unknown, params: CompileDeftyActionDraftParams) {
  const name = stringValue(value);
  if (!name) return '';
  const normalized = name.replace(/[?!.,;:]+$/g, '').trim();
  if (/^(?:me|myself)$/i.test(normalized)) return params.callerName ?? '';
  return name;
}

function selectPriorTaskReferences(references: string[], prompt: string): string[] {
  const unique = [...new Set(references.map((ref) => ref.toUpperCase()))];
  if (unique.length === 0) return [];
  const lower = prompt.toLowerCase();
  if (/\bfirst\s+(?:two|2)\b/.test(lower)) return unique.slice(0, 2);
  if (/\blast\s+(?:two|2)\b/.test(lower)) return unique.slice(-2);
  if (/\bboth\b/.test(lower)) return unique.slice(0, 2);
  const allCount = lower.match(/\ball\s+(\d+|one|two|three)\b/)?.[1];
  const count = allCount ? ({ one: 1, two: 2, three: 3 } as Record<string, number>)[allCount] ?? Number(allCount) : undefined;
  if (count) return unique.slice(0, count);
  if (/\b(?:all|these|those|them|above)\b/.test(lower)) return unique;
  return [];
}

function normalizeStatus(value: unknown) {
  const normalized = stringValue(value).toLowerCase().replace(/[\s-]+/g, '_');
  if (normalized === 'complete' || normalized === 'completed' || normalized === 'closed') return 'done';
  if (normalized === 'to_do') return 'todo';
  return ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled'].includes(normalized)
    ? normalized
    : null;
}

function normalizePriority(value: unknown) {
  const normalized = stringValue(value).toLowerCase();
  return ['p0', 'p1', 'p2', 'p3'].includes(normalized) ? normalized : null;
}

function normalizeDueDate(value: unknown) {
  const text = stringValue(value);
  if (!text || /^none|null|no due date$/i.test(text)) return undefined;
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : undefined;
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function removeUndefined<T extends Record<string, any>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function parseFirstJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Continue below.
  }
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}
