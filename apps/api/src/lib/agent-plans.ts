import { logId } from './log-metadata.js';
/**
 * Multi-step plan execution engine.
 *
 * Plans are sequences of tool calls with:
 *   - Step references: $step.{stepId}.result.{fieldPath}
 *   - Conditional execution: eq, neq, gt, lt, contains, empty, not_empty
 *   - Dependency tracking: steps can depend on prior steps
 *   - Approval gating: write actions pause the plan unless auto-approved
 *   - Failure recovery: agent reasons about alternatives on step failure
 */

import { createHash } from 'node:crypto';
import { canonicalCapabilityJson } from '@deft/shared';
import { db, withDbAdvisoryLock } from './db.js';
import { agentActions, agentEmployees, agentPlans, orgs, tasks, messages } from '@deft/db/schema';
import { eq, and, sql, type SQL } from 'drizzle-orm';
import { planCreatorKeepsRoomsSql } from './plan-room-access.js';
import { lockPlanRoomAccess } from './room-access-lock.js';

export { planCreatorKeepsRoomsSql };
import { executeToolCall } from './agent-context.js';
import { shouldAutoExecute, getApprovalTier, isDestructiveAction } from './agent-approval.js';
import {
  executeActionDirect,
  isModuleWriteAction,
  preflightPlanActionInput,
} from './agent-actions.js';
import { ACTION_TOOLS } from './agent-tools.js';
import { runAgentQuery } from './agent-runner.js';
import { DOCUMENT_EDIT_ACTION } from './document-suggestions.js';
import { documentToolCallForStorage, editDocumentInputForStorage, omittedText, storableRef, type OmittedText } from './document-audience.js';
import { isDraftTextAction, scrubDocumentDraftItems, settledDocumentDraftParamsSql } from './document-draft-params.js';
import { isCanonicalDeftyEmployee } from './defty-identity.js';
import type { TrustLevel } from './agent-approval.js';
import { getIO } from '../socket.js';
import { getMCPToolsForAgent } from './mcp-tools.js';
import { getActiveAgentToolPolicy } from './agent-tool-policy.js';
import {
  CONNECTED_TOOL_UNAVAILABLE_ERROR,
  isConnectedToolName,
  isWorkspaceGuest,
} from './connected-tool-access.js';

// ─── Types ───

export interface PlanStep {
  id: string;
  /** Stamped by approve/resume, separately from caller-controlled result keys. */
  approved_by_user_id?: string;
  description: string;
  tool: string;
  params: Record<string, any>;
  depends_on?: string[];
  condition?: StepCondition;
  status?:
    | 'pending'
    | 'running'
    | 'completed'
    | 'failed'
    | 'skipped'
    | 'waiting_approval'
    /**
     * Task 3.9 — marked on every later step when fail_fast=true and an
     * earlier step fails. Stored as a plain string in the steps jsonb
     * array (step status is not a DB enum, so no migration needed).
     */
    | 'skipped_due_to_failure';
  result?: any;
  error?: string;
  /** M7 (rule C4): set once a document tool's step keeps references only (documentStepForStorage). */
  content_omitted?: true;
}

export interface StepCondition {
  field: string;
  operator: 'eq' | 'neq' | 'gt' | 'lt' | 'contains' | 'empty' | 'not_empty';
  value?: any;
}

type PlanContext = Record<string, { result: any }>;

type PlanEventType =
  | 'step:start'
  | 'step:complete'
  | 'step:skip'
  | 'step:fail'
  | 'plan:pause'
  | 'plan:complete'
  | 'plan:fail';

export type PlanEvent = {
  type: PlanEventType;
  stepId?: string;
  data?: any;
};

type PlanWriteResult = {
  actionId: string;
  success: boolean;
  result: any;
  error?: string;
  requiresApproval?: boolean;
  approvalTier?: 'auto' | 'quick' | 'full';
};

class PlanApprovalBoundaryError extends Error {}

/** A plan request the caller may not make; the message is safe to show. */
export class PlanAccessError extends Error {}

export const PLAN_EMPLOYEE_UNAVAILABLE_ERROR = 'Agent employee is not available';

/** Recorded on a plan stopped because its creator lost its conversation. Names no room. */
export const PLAN_ROOM_LOST_ERROR = 'The person who asked no longer has access to the conversation this plan came from';


/** A plan can be bound only to an active employee of its own workspace. */
export async function assertPlanEmployeeBindable(orgId: string, agentEmployeeId: string): Promise<void> {
  if (!(await getActiveAgentToolPolicy(orgId, agentEmployeeId))) {
    throw new PlanAccessError(PLAN_EMPLOYEE_UNAVAILABLE_ERROR);
  }
}

/**
 * M7: a document edit is made from chat, where its asker's request and
 * setting decide where it lands, never as a plan step: a step would store
 * its operations (document text) in the plan, and an approved plan would
 * apply them with no suggestion to review.
 */
export const PLAN_DOCUMENT_EDIT_ERROR = 'Document edits are made from chat, not as plan steps';

/**
 * M7 fix round 5 (the controller's rule: a draft's text reaches only the
 * person who asked). A plan step that writes a document's text
 * (create_document, create_note, write_canvas) keeps that text on its
 * pending action, which an employee's queue (fetch_unread,
 * poll_pending_work) lists, and the employee's agent user would write it.
 * So a plan bound to an agent employee carries no such step unless its
 * creator is that employee's own user (or the employee is Defty's internal
 * one, which is Defty's path): refused when the plan is made, edited or
 * approved (code DRAFT_STEP_NOT_FOR_EMPLOYEE), and a plan stored before
 * stops at that step without queueing anything.
 */
export const PLAN_DRAFT_STEP_EMPLOYEE_ERROR = 'A step that writes a document\'s text runs for the person who asked, so it can\'t be handed to an agent employee. Ask Defty to make the document from chat.';

/** True when a draft step of `creatorId`'s plan would be handed to the bound employee (fix round 5). */
export async function draftStepsWouldReachEmployee(orgId: string, creatorId: string, agentEmployeeId: string | null | undefined): Promise<boolean> {
  if (!agentEmployeeId) return false;
  const [employee] = await db
    .select({ user_id: agentEmployees.user_id, slug: agentEmployees.slug, runtime_kind: agentEmployees.runtime_kind, is_byoa: agentEmployees.is_byoa })
    .from(agentEmployees)
    .where(and(eq(agentEmployees.id, agentEmployeeId), eq(agentEmployees.org_id, orgId)))
    .limit(1);
  if (!employee) return true;
  if (isCanonicalDeftyEmployee(employee)) return false;
  return employee.user_id !== creatorId;
}

// ─── Document content in plans (M7, rule C4) ───

/**
 * The document tools whose completed steps keep references only: the reads
 * (their results are Markdown, titles, snippets), and the writes (their
 * params are a document's text, their results name it).
 */
const DOCUMENT_STEP_TOOLS: ReadonlySet<string> = new Set([
  'read_document', 'search_documents', 'list_drive', 'read_note', 'search_notes', 'read_canvas',
  'create_document', 'create_note', 'write_canvas', 'note_to_wiki',
  // Never run as a step (PLAN_DOCUMENT_EDIT_ERROR), but a plan stored before shows no operations.
  DOCUMENT_EDIT_ACTION,
]);

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The string fields of `value` named in `keys`. */
function stringFields(value: unknown, keys: readonly string[]): Record<string, string> {
  if (!isPlainRecord(value)) return {};
  return Object.fromEntries(keys.flatMap((key) => (typeof value[key] === 'string' ? [[key, value[key] as string]] : [])));
}

/**
 * A document tool step's params and result as a plan keeps them once it has
 * run (rule C4): the reads keep their ids and `{ document_id, block_ids,
 * withheld }` (M3's documentToolCallForStorage, which also leaves out a
 * search's words); create_note and write_canvas keep their content as
 * `{ document_id, content_omitted, content_bytes }` (F15) and results that
 * name the document; create_document keeps where it went (M7); note_to_wiki
 * the page it made. Null for any other tool: its step is kept as it is.
 */
export function documentStepForStorage(tool: string, params: unknown, result: unknown): { params: unknown; result: unknown } | null {
  if (!DOCUMENT_STEP_TOOLS.has(tool)) return null;
  switch (tool) {
    case 'create_note':
    case 'write_canvas':
    case 'create_document':
      // Rebuilt (fix round 1): ids and references kept, every text field as its size.
      return {
        params: documentStepParamsForStorage(tool, params),
        result: stringFields(result, ['note_id', 'document_id', 'canvas_document_id', 'space', 'url', 'error']),
      };
    case 'note_to_wiki':
      return { params: documentStepParamsForStorage(tool, params), result: stringFields(result, ['wiki_page_id', 'slug', 'error']) };
    default: {
      const stored = documentToolCallForStorage(tool, params, result);
      return { params: stored.input, result: stored.result };
    }
  }
}

/**
 * A plan keeps no text read from a document in any step (fix round 1, I2). A
 * document tool step's params are its ids (an id or a
 * `$step.<id>.result.<field>` reference, nothing else) and, for the writes,
 * each text field (create_note's and write_canvas's title and content,
 * create_document's title and Markdown) is one of:
 * - a reference, resolved when the step runs from what an earlier step read
 *   as the creator. A read from an earlier run is read again then, as the
 *   creator, through the same access-checked read tool (fix round 2), so a
 *   resumed plan still runs;
 * - a literal written for the plan (fix round 2). It is kept like a pending
 *   draft: shown only to the plan's creator, who asked for it (fix round 3)
 *   (routes/agent-plans.ts), and left out once the step completes or the
 *   plan ends, when the step names what it made;
 * - `{ content_omitted, content_bytes }`, which can't run.
 * A step whose text is left out, or whose reference doesn't resolve, can't
 * run (PLAN_DOCUMENT_TEXT_ERROR). A search keeps its words until it runs:
 * they are the step's instruction, not a document's text.
 */
export const PLAN_DOCUMENT_TEXT_ERROR = 'This step\'s document text is no longer available, so it can\'t run. Ask Defty to make the document from chat.';

/** The document reads a step's references can name (their completed steps keep references only). */
const DOCUMENT_READ_STEP_TOOLS: ReadonlySet<string> = new Set([
  'read_document', 'search_documents', 'list_drive', 'read_note', 'search_notes', 'read_canvas',
]);

/** The reads a later run can make again from the ids their completed step keeps (a search keeps no words once run). */
const REREADABLE_STEP_TOOLS: ReadonlySet<string> = new Set(['read_document', 'read_note', 'read_canvas', 'list_drive']);

/** A plan that has ended: its steps keep no literal text either. */
const SETTLED_PLAN_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed']);

const STEP_REFERENCE_IN_TEXT = /\$step\.([^.\s]+)\.result\./g;

/** The step ids `value` names in `$step.<id>.result.…` references, at any depth. */
function referencedStepIds(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    for (const match of value.matchAll(STEP_REFERENCE_IN_TEXT)) found.add(match[1]!);
  } else if (Array.isArray(value)) {
    for (const item of value) referencedStepIds(item, found);
  } else if (isPlainRecord(value)) {
    for (const item of Object.values(value)) referencedStepIds(item, found);
  }
  return found;
}

/** The text fields of each document-writing step tool. */
const DOCUMENT_TEXT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  create_note: ['title', 'content'],
  create_document: ['title', 'markdown'],
  write_canvas: ['title', 'content'],
};

const STEP_REFERENCE = /^\$step\.[^.\s]+\.result\.[^\s]+$/;

const isStepReference = (value: unknown): value is string => typeof value === 'string' && value.length <= 200 && STEP_REFERENCE.test(value);

/** An id, or a reference to one, as a step keeps it; anything else is dropped. */
function stepRef(value: unknown): string | null {
  return storableRef(value) ?? (isStepReference(value) ? value : null);
}

/**
 * A document tool step's params as a plan keeps them: ids, references, and no
 * text. With `literals` (a step not yet completed, of a plan that hasn't
 * ended, as the plan stores it and as its creator alone sees it: fix
 * round 2), a write's text field written for the plan is kept as written.
 */
export function documentStepParamsForStorage(tool: string, params: unknown, options: { literals?: boolean } = {}): Record<string, unknown> {
  const record = isPlainRecord(params) ? params : {};
  const refs = (...keys: string[]): Record<string, string> => Object.fromEntries(keys.flatMap((key): Array<[string, string]> => {
    const ref = stepRef(record[key]);
    return ref === null ? [] : [[key, ref]];
  }));
  const shortText = (key: string, max: number) => (typeof record[key] === 'string' ? { [key]: (record[key] as string).slice(0, max) } : {});
  // A text field is a reference, a literal (with `literals`), or its size: never anything else.
  const textFields: Record<string, string | OmittedText> = Object.fromEntries((DOCUMENT_TEXT_FIELDS[tool] ?? [])
    .flatMap((key): Array<[string, string | OmittedText]> => {
      const value = record[key];
      if (value === undefined) return [];
      if (typeof value === 'string' && (isStepReference(value) || options.literals === true)) return [[key, value]];
      return [[key, omittedText(value, null)]];
    }));
  switch (tool) {
    case 'read_document': return refs('document_id');
    case 'read_note': return refs('note_id');
    case 'read_canvas': return shortText('space_name', 200);
    case 'list_drive': return refs('drive_id', 'folder_id');
    case 'search_documents':
    case 'search_notes':
      return {
        ...shortText('query', 200), ...refs('drive_id'),
        ...(['mine', 'org', 'all'].includes(record.scope as string) ? { scope: record.scope } : {}),
        ...(typeof record.limit === 'number' && Number.isFinite(record.limit) ? { limit: record.limit } : {}),
      };
    case 'create_note':
      return {
        ...textFields, ...refs('visibility_space_id', 'source_message_id'),
        ...(['private', 'org', 'space'].includes(record.visibility as string) ? { visibility: record.visibility } : {}),
      };
    case 'write_canvas': return { ...textFields, ...shortText('space_name', 200), ...refs('source_message_id') };
    case 'create_document': return { ...textFields, ...refs('drive_id', 'folder_id', 'parent_document_id', 'source_message_id') };
    case 'note_to_wiki': return { ...refs('note_id'), ...shortText('type', 40) };
    case DOCUMENT_EDIT_ACTION: return editDocumentInputForStorage(record) as Record<string, unknown>;
    default: return record;
  }
}

/**
 * Steps as a plan stores them (createPlanRow, PUT /api/agent-plans/:id): each
 * document tool step's params through documentStepParamsForStorage, keeping
 * the literals written for the plan (fix round 2), with no result and no
 * stored mark of its own (only the executor sets those).
 */
export function planStepsForStorage<S>(steps: S[]): S[] {
  return steps.map((step) => {
    if (!isPlainRecord(step) || typeof step.tool !== 'string' || !DOCUMENT_STEP_TOOLS.has(step.tool)) return step;
    const { result: _result, content_omitted: _omitted, ...rest } = step;
    return { ...rest, params: documentStepParamsForStorage(step.tool, step.params, { literals: true }) } as S;
  });
}

/**
 * A create_plan call as a run keeps it (agent_blocks, the run's executed
 * actions: fix round 2): its document steps without their literal text,
 * which only the plan itself keeps, for its creator alone.
 */
export function createPlanInputForStorage(input: unknown): unknown {
  if (!isPlainRecord(input) || !Array.isArray(input.steps)) return input;
  return {
    ...input,
    steps: input.steps.map((step: unknown) => (isPlainRecord(step) && typeof step.tool === 'string' && DOCUMENT_STEP_TOOLS.has(step.tool)
      ? { ...step, params: documentStepParamsForStorage(step.tool, step.params) }
      : step)),
  };
}

/**
 * True when a document-writing step can't run from what the plan keeps: a
 * text field was left out (or isn't text), a reference didn't resolve to
 * text, or a literal still names a step of this plan it couldn't resolve.
 */
export function documentStepTextUnavailable(
  tool: string, stored: Record<string, unknown>, resolved: Record<string, unknown>, planStepIds: ReadonlySet<string> = new Set(),
): boolean {
  return (DOCUMENT_TEXT_FIELDS[tool] ?? []).some((key) => {
    const value = stored[key];
    if (value === undefined) return false;
    if (typeof value !== 'string' || typeof resolved[key] !== 'string') return true;
    return [...referencedStepIds(resolved[key])].some((stepId) => planStepIds.has(stepId));
  });
}

/** A completed read's result as a plan keeps it, rebuilt from the kept shape: ids, `withheld` and an error only. */
function keptReadResult(result: unknown): Record<string, unknown> | null {
  if (!isPlainRecord(result)) return null;
  const kept: Record<string, unknown> = {};
  for (const key of ['document_id', 'drive_id', 'folder_id']) {
    if (key in result) kept[key] = result[key] === null ? null : storableRef(result[key]);
  }
  if (typeof result.withheld === 'boolean') kept.withheld = result.withheld;
  if (Array.isArray(result.block_ids)) kept.block_ids = result.block_ids.flatMap((id) => storableRef(id) ?? []);
  const listed = (rows: unknown, key: 'document_id' | 'drive_id') => (Array.isArray(rows) ? rows : [])
    .filter(isPlainRecord).map((row) => ({ [key]: storableRef(row[key]), withheld: row.withheld === true }));
  if (Array.isArray(result.documents)) kept.documents = listed(result.documents, 'document_id');
  if (Array.isArray(result.drives)) kept.drives = listed(result.drives, 'drive_id');
  for (const key of ['error', 'code']) if (typeof result[key] === 'string') kept[key] = (result[key] as string).slice(0, 300);
  return kept;
}

/**
 * A document tool step's result (or its context entry) as a plan keeps it:
 * a read's references, rebuilt from the kept shape when the step says it was
 * kept so (`kept`, which no marker can turn into text: keptReadResult keeps
 * ids only), and from the tool's own result otherwise.
 */
function documentStepResultForStorage(tool: string, params: unknown, result: unknown, kept: boolean): unknown {
  if (result === undefined) return undefined;
  const stored = documentStepForStorage(tool, params, result)!.result;
  if (!DOCUMENT_READ_STEP_TOOLS.has(tool)) return isPlainRecord(stored) ? stored : null;
  const ids = keptReadResult(result);
  if (kept || ids === null || !isPlainRecord(stored)) return ids;
  // The tool's own result (a row stored before the rules): its references, and any id it kept as one.
  return { ...ids, ...Object.fromEntries(Object.entries(stored).filter(([, value]) => value !== undefined)) };
}

/**
 * A plan as its payloads show it (routes/agent-plans.ts) and as its executor
 * reads it back: every document tool step, and its entry in the plan's
 * context, rebuilt from the allowlist for every status, whatever marks it
 * carries (fix round 2, I2), so a plan stored before the rules shows no
 * document text either:
 * - a completed step: its params and result as references
 *   (documentStepForStorage);
 * - any other step: documentStepParamsForStorage's params, keeping the
 *   literals written for the plan only with `literals` (its creator, and
 *   the executor) and only while the plan hasn't ended;
 * - each context entry of a document tool step: its result as references.
 */
export function planWithDocumentReferences<T extends { steps: unknown; context?: unknown; status?: unknown }>(
  plan: T, options: { literals?: boolean } = {},
): T {
  if (!Array.isArray(plan.steps)) return plan;
  const literals = options.literals === true && !SETTLED_PLAN_STATUSES.has(String(plan.status));
  const context = isPlainRecord(plan.context) ? { ...plan.context } : plan.context;
  const steps = plan.steps.map((step: unknown) => {
    if (!isPlainRecord(step) || typeof step.tool !== 'string' || !DOCUMENT_STEP_TOOLS.has(step.tool)) return step;
    const tool = step.tool;
    const { content_omitted: marked, result, params, ...rest } = step;
    const completed = step.status === 'completed';
    const kept = completed && marked === true;
    if (isPlainRecord(context) && typeof step.id === 'string' && step.id in context) {
      const entry = context[step.id];
      context[step.id] = { result: documentStepResultForStorage(tool, params, isPlainRecord(entry) ? entry.result : null, kept) ?? null };
    }
    const storedResult = documentStepResultForStorage(tool, params, result, kept);
    return {
      ...rest,
      params: completed ? documentStepForStorage(tool, params, null)!.params : documentStepParamsForStorage(tool, params, { literals }),
      ...(storedResult === undefined ? {} : { result: storedResult }),
      ...(completed ? { content_omitted: true } : {}),
    };
  });
  return { ...plan, steps, context };
}

/** Plans with connected steps are created and approved for workspace members. */
export async function assertPlanStepsAllowedFor(orgId: string, userId: string, steps: unknown, agentEmployeeId?: string | null): Promise<void> {
  if (Array.isArray(steps) && steps.some((step) => (step as { tool?: unknown } | null)?.tool === DOCUMENT_EDIT_ACTION)) {
    throw new PlanAccessError(PLAN_DOCUMENT_EDIT_ERROR);
  }
  // M7 fix round 5: a draft step never goes to an employee that isn't the creator's own agent.
  if (Array.isArray(steps) && steps.some((step) => isDraftTextAction((step as { tool?: unknown } | null)?.tool))
    && await draftStepsWouldReachEmployee(orgId, userId, agentEmployeeId)) {
    throw new PlanAccessError(PLAN_DRAFT_STEP_EMPLOYEE_ERROR);
  }
  const hasConnectedStep = Array.isArray(steps)
    && steps.some((step) => isConnectedToolName((step as { tool?: unknown } | null)?.tool));
  if (hasConnectedStep && await isWorkspaceGuest(orgId, userId)) {
    throw new PlanAccessError(CONNECTED_TOOL_UNAVAILABLE_ERROR);
  }
}

function planStepRequestKey(
  planId: string,
  stepId: string,
  action: string,
  params: Record<string, any>,
): string {
  const digest = createHash('sha256')
    .update(canonicalCapabilityJson({ action, params }))
    .digest('hex');
  return `plan-step:${planId}:${stepId}:${digest}`;
}

async function executeReviewedPlanDependency(params: {
  planId: string;
  step: PlanStep;
  resolvedParams: Record<string, any>;
  orgId: string;
  userId: string;
  conversationId: string | null;
  agentEmployeeId: string | null;
  approvalTier: 'auto' | 'quick' | 'full';
}): Promise<PlanWriteResult> {
  const employeeScope = params.agentEmployeeId
    ? eq(agentActions.agent_employee_id, params.agentEmployeeId)
    : sql`${agentActions.agent_employee_id} IS NULL`;
  const priorActions = await db
    .select()
    .from(agentActions)
    .where(and(
      eq(agentActions.org_id, params.orgId),
      eq(agentActions.user_id, params.userId),
      eq(agentActions.plan_id, params.planId),
      eq(agentActions.plan_step_id, params.step.id),
      eq(agentActions.source, 'plan'),
      employeeScope,
    ))
    .limit(2);

  if (priorActions.length > 1) {
    throw new PlanApprovalBoundaryError(`Plan step '${params.step.id}' has multiple approval actions`);
  }
  const [prior] = priorActions;
  let canonicalParams: Record<string, any>;
  try {
    canonicalParams = await preflightPlanActionInput(
      params.step.tool,
      params.resolvedParams,
      params.orgId,
      params.userId,
      params.agentEmployeeId ?? undefined,
      { replay: Boolean(prior) },
    );
  } catch (error) {
    throw new PlanApprovalBoundaryError((error as Error).message);
  }
  const requestKey = planStepRequestKey(
    params.planId,
    params.step.id,
    params.step.tool,
    canonicalParams,
  );
  if (prior) {
    if (prior.action !== params.step.tool || prior.runtime_request_key !== requestKey) {
      if (prior.approval_status === 'pending') {
        await db.transaction(async (tx) => {
          const expired = await tx
            .update(agentActions)
            .set({
              approval_status: 'expired',
              error: `Plan step '${params.step.id}' changed after review was requested`,
              updated_at: new Date(),
              params: settledDocumentDraftParamsSql(),
            })
            .where(and(
              eq(agentActions.id, prior.id),
              eq(agentActions.org_id, params.orgId),
              eq(agentActions.approval_status, 'pending'),
            ))
            .returning({ id: agentActions.id });
          // M7 fix round 3 (I3): an expired document draft's approval items name nothing, in this commit.
          if (expired.length > 0 && isDraftTextAction(prior.action)) await scrubDocumentDraftItems(tx, [prior.id]);
        });
      }
      throw new PlanApprovalBoundaryError(
        `Plan step '${params.step.id}' input changed after review was requested`,
      );
    }
    if (prior.approval_status === 'pending') {
      return {
        actionId: prior.id,
        success: false,
        result: null,
        error: prior.error ?? 'Action requires human approval',
        requiresApproval: true,
        approvalTier: prior.approval_tier,
      };
    }
    if (prior.approval_status === 'approved' && prior.executed_at) {
      return {
        actionId: prior.id,
        success: prior.error === null,
        result: prior.result,
        ...(prior.error ? { error: prior.error } : {}),
      };
    }
    if (prior.approval_status === 'approved') {
      throw new PlanApprovalBoundaryError(
        `Plan step '${params.step.id}' is approved but its execution outcome is unavailable`,
      );
    }
    throw new PlanApprovalBoundaryError(
      `Plan step '${params.step.id}' approval was ${prior.approval_status}`,
    );
  }

  try {
    return await executeActionDirect(
      params.step.tool,
      canonicalParams,
      params.orgId,
      params.userId,
      params.conversationId,
      params.approvalTier,
      {
        agentEmployeeId: params.agentEmployeeId ?? undefined,
        source: 'plan',
        planId: params.planId,
        planStepId: params.step.id,
        runtimeRequestKey: requestKey,
        forceApproval: true,
      },
    );
  } catch (error) {
    throw new PlanApprovalBoundaryError((error as Error).message);
  }
}

export async function executePlan(
  planId: string,
  orgId: string,
  userId: string,
  onEvent?: (event: PlanEvent) => void,
): Promise<void> {
  return withDbAdvisoryLock(
    `agent-plan:${orgId}:${planId}`,
    () => executePlanUnlocked(planId, orgId, userId, onEvent),
  );
}

// ─── Reference Resolution ───

/**
 * Replace $step.{stepId}.result.{fieldPath} references in params with actual
 * values from completed step results stored in context.
 */
export function resolveStepReferences(
  params: Record<string, any>,
  context: PlanContext,
): Record<string, any> {
  const resolved: Record<string, any> = {};
  for (const [key, value] of Object.entries(params)) {
    resolved[key] = resolveValue(value, context);
  }
  return resolved;
}

function resolveValue(value: any, context: PlanContext): any {
  if (typeof value === 'string') {
    // Full replacement: entire value is a reference
    const fullMatch = value.match(/^\$step\.([^.]+)\.result\.(.+)$/);
    if (fullMatch) {
      const [, stepId, fieldPath] = fullMatch;
      return getNestedValue(context[stepId!]?.result, fieldPath!);
    }
    // Inline replacement: references embedded in a larger string
    return value.replace(/\$step\.([^.]+)\.result\.([^\s}]+)/g, (_match, stepId, fieldPath) => {
      const val = getNestedValue(context[stepId]?.result, fieldPath);
      return val !== undefined ? String(val) : _match;
    });
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolveValue(v, context));
  }
  if (value && typeof value === 'object') {
    return resolveStepReferences(value, context);
  }
  return value;
}

function getNestedValue(obj: any, path: string): any {
  if (obj === undefined || obj === null) return undefined;
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current === undefined || current === null) return undefined;
    current = current[part];
  }
  return current;
}

// ─── Condition Evaluation ───

/**
 * Evaluate a step condition against the current plan context.
 * Returns true if the step should execute.
 */
export function evaluateCondition(
  condition: StepCondition,
  context: PlanContext,
): boolean {
  const fieldValue = resolveValue(condition.field, context);

  switch (condition.operator) {
    case 'eq':
      return fieldValue === condition.value;
    case 'neq':
      return fieldValue !== condition.value;
    case 'gt':
      return typeof fieldValue === 'number' && fieldValue > condition.value;
    case 'lt':
      return typeof fieldValue === 'number' && fieldValue < condition.value;
    case 'contains':
      if (typeof fieldValue === 'string') return fieldValue.includes(condition.value);
      if (Array.isArray(fieldValue)) return fieldValue.includes(condition.value);
      return false;
    case 'empty':
      return (
        fieldValue === undefined ||
        fieldValue === null ||
        fieldValue === '' ||
        (Array.isArray(fieldValue) && fieldValue.length === 0)
      );
    case 'not_empty':
      return (
        fieldValue !== undefined &&
        fieldValue !== null &&
        fieldValue !== '' &&
        !(Array.isArray(fieldValue) && fieldValue.length === 0)
      );
    default:
      return true;
  }
}

// ─── Plan Creation ───

export interface CreatePlanRowInput {
  org_id: string;
  user_id: string;
  conversation_id?: string | null;
  agent_employee_id?: string | null;
  /**
   * Task 3.2 — if the plan was created in response to a chat message,
   * this id threads through to every write-action step as
   * params.source_message_id so the created tasks/messages link back.
   */
  source_message_id?: string | null;
  /** 'api': made by a person through POST /api/agent-plans (DFX3 F2). */
  created_via?: 'api';
  title: string;
  description?: string | null;
  steps: PlanStep[];
  /**
   * Task 3.9 — stop on the first step failure and mark later steps
   * 'skipped_due_to_failure' instead of invoking the agent-recovery path.
   * Defaults to false.
   */
  fail_fast?: boolean;
  /**
   * Task 3.9 — when fail_fast is also true, reverse every successful
   * write-action step before stopping. Defaults to false.
   */
  rollback_on_fail?: boolean;
  /**
   * Task 3.10 — if the plan is bound to a task, every step-progress
   * event carries this id so the task-detail UI can render a live strip.
   */
  task_id?: string | null;
}

/**
 * Persist a new plan as a draft.
 *
 * This is the single source of truth for plan creation — used by both the
 * REST POST handler and the create_plan tool case in executeToolCall.
 *
 * It does NOT approve or execute the plan.  Execution is a separate concern
 * handled by executePlan() after the user approves the plan.
 */
export async function createPlanRow(
  input: CreatePlanRowInput,
): Promise<{ plan_id: string; status: 'draft' }> {
  await assertPlanStepsAllowedFor(input.org_id, input.user_id, input.steps, input.agent_employee_id);
  // Fix round 1 (I2): no document text is stored in any step, from creation on.
  const steps = planStepsForStorage(input.steps).map((step) => ({
    ...step,
    approved_by_user_id: undefined,
    status: 'pending' as const,
  }));

  const initialContext: Record<string, unknown> = {};
  if (input.source_message_id) initialContext.source_message_id = input.source_message_id;
  if (input.task_id) initialContext.task_id = input.task_id;
  // A person made it through the plan route (DFX3 F2: such a plan may name no room).
  if (input.created_via === 'api') initialContext.created_via = 'api';

  const [plan] = await db
    .insert(agentPlans)
    .values({
      org_id: input.org_id,
      user_id: input.user_id,
      agent_employee_id: input.agent_employee_id ?? null,
      conversation_id: input.conversation_id ?? null,
      title: input.title,
      description: input.description ?? null,
      steps,
      status: 'draft',
      current_step: 0,
      context: initialContext,
      fail_fast: input.fail_fast ?? false,
      rollback_on_fail: input.rollback_on_fail ?? false,
    })
    .returning({ id: agentPlans.id, status: agentPlans.status });

  return { plan_id: plan!.id, status: 'draft' };
}

// ─── Plan Execution ───

/**
 * Main plan execution loop.
 *
 * 1. Load plan from DB
 * 2. Load trust level
 * 3. For each step: check deps, evaluate conditions, execute or pause
 * 4. On failure: ask agent for alternative. If ESCALATE → pause.
 * 5. Store results in context for downstream step references.
 */
async function executePlanUnlocked(
  planId: string,
  orgId: string,
  userId: string,
  onEvent?: (event: PlanEvent) => void,
): Promise<void> {
  // 1. Load plan
  const [plan] = await db
    .select()
    .from(agentPlans)
    .where(and(eq(agentPlans.id, planId), eq(agentPlans.org_id, orgId), eq(agentPlans.user_id, userId)))
    .limit(1);

  if (!plan) throw new Error(`Plan ${planId} not found`);
  if (plan.status !== 'approved' && plan.status !== 'executing') {
    // Duplicate queued workers are serialized by the plan lock. Once the
    // first has paused or finished, a follower has no remaining work.
    if (plan.status === 'paused' || plan.status === 'completed' || plan.status === 'failed') return;
    throw new Error(`Plan ${planId} cannot be executed in status '${plan.status}'`);
  }

  // 2. Load trust level
  let trustLevel: TrustLevel = 'standard';
  if (plan.agent_employee_id) {
    const employeePolicy = await getActiveAgentToolPolicy(orgId, plan.agent_employee_id);
    if (!employeePolicy) throw new Error('Plan agent employee is inactive, deleted, or outside this organization');
    trustLevel = employeePolicy.trustLevel;
  } else {
    const [org] = await db
      .select({ trust_level: orgs.trust_level })
      .from(orgs)
      .where(eq(orgs.id, orgId))
      .limit(1);
    if (org?.trust_level) {
      trustLevel = org.trust_level as TrustLevel;
    }
  }

  // 3. Set status to executing
  await db
    .update(agentPlans)
    .set({ status: 'executing', updated_at: new Date() })
    .where(eq(agentPlans.id, planId));

  // Every document step and its context entry rebuilt from the allowlist,
  // whenever the plan was stored (I2); a step not yet run keeps the literals
  // written for it (fix round 2). The first progress write below stores it so.
  const rebuilt = planWithDocumentReferences({ steps: plan.steps, context: plan.context, status: plan.status }, { literals: true });
  const steps = rebuilt.steps as PlanStep[];
  const context: PlanContext = (rebuilt.context as PlanContext) ?? {};
  const planStepIds: ReadonlySet<string> = new Set(steps.map((candidate) => candidate.id));
  // M7 (rule C4): a document tool's full result, for this run's later steps
  // only. The plan row keeps its references (completeStep).
  const liveResults: PlanContext = {};
  const readableContext = (): PlanContext => ({ ...context, ...liveResults });
  // Fix round 2: a step naming a document read that completed in an earlier
  // run reads it again now, as the creator, through the same access-checked
  // read tool (the plan kept its ids only). A read that can't be made again
  // (a search keeps no words once run) leaves the reference unresolved.
  const readAgainFor = async (value: unknown): Promise<void> => {
    for (const stepId of referencedStepIds(value)) {
      if (liveResults[stepId]) continue;
      const source = steps.find((candidate) => candidate.id === stepId);
      if (!source || source.status !== 'completed' || !REREADABLE_STEP_TOOLS.has(source.tool)) continue;
      try {
        const { result } = await executeToolCall(
          source.tool, { ...source.params }, orgId, userId, plan.conversation_id ?? undefined, plan.agent_employee_id ?? undefined,
        );
        liveResults[stepId] = { result };
      } catch {
        // Unresolved: a document write that needs it can't run (PLAN_DOCUMENT_TEXT_ERROR).
      }
    }
  };
  // A plan that ends keeps no literal either (fix round 2).
  const settledPlan = () => planWithDocumentReferences({ steps, context });
  const completeStep = (step: PlanStep, ranWith: Record<string, any>, result: unknown) => {
    step.status = 'completed';
    liveResults[step.id] = { result };
    const kept = documentStepForStorage(step.tool, ranWith, result);
    if (kept) {
      step.params = kept.params as Record<string, any>;
      step.result = kept.result;
      step.content_omitted = true;
      context[step.id] = { result: kept.result };
    } else {
      step.result = result;
      context[step.id] = { result };
    }
  };
  const connectedStepsRefused = steps.some((candidate) => isConnectedToolName(candidate.tool))
    && await isWorkspaceGuest(orgId, userId);
  // M7 fix round 5: a plan stored before the rule still never hands a draft step to an employee.
  const draftStepsRefused = steps.some((candidate) => isDraftTextAction(candidate.tool))
    && await draftStepsWouldReachEmployee(orgId, plan.user_id, plan.agent_employee_id);
  const startIdx = plan.current_step ?? 0;
  const failFast = plan.fail_fast === true;
  const rollbackOnFail = plan.rollback_on_fail === true;
  // Task 3.10 — if the plan is bound to a task, progress events carry the
  // task_id so the task-detail UI can render a live status strip.
  const planTaskId =
    typeof (context as any)?.task_id === 'string' ? ((context as any).task_id as string) : null;
  const totalSteps = steps.length;
  // Every org socket receives the step position and status only; step text
  // and errors stay with the plan (its requester reads them from the plan).
  const emitTaskProgress = (
    stepIndex: number,
    _stepDescription: string,
    status: 'started' | 'completed' | 'failed',
    _error?: string,
  ) => {
    if (!planTaskId) return;
    const io = getIO();
    if (!io) return;
    io.to(`org:${orgId}`).emit('task:agent_progress', {
      task_id: planTaskId,
      agent_employee_id: plan.agent_employee_id ?? null,
      step_index: stepIndex,
      step_description: `Step ${stepIndex + 1} of ${totalSteps}`,
      status,
      total_steps: totalSteps,
    });
  };

  for (let i = startIdx; i < steps.length; i++) {
    // Check if plan was paused externally
    const [currentPlan] = await db
      .select({ status: agentPlans.status })
      .from(agentPlans)
      .where(eq(agentPlans.id, planId))
      .limit(1);

    if (currentPlan?.status === 'paused' || currentPlan?.status === 'failed') {
      onEvent?.({ type: 'plan:pause', data: { reason: 'externally paused' } });
      return;
    }

    const step = steps[i]!;
    // A step's result is stored under its id; a reserved context key would
    // overwrite what binds the plan to its rooms. Checked before anything
    // else about the step can fail or store a result (DFX3).
    if (RESERVED_PLAN_CONTEXT_KEYS.has(step.id)) {
      const reserved = `Plan step id '${step.id}' is reserved`;
      await db.update(agentPlans)
        .set({ status: 'paused', error: reserved, updated_at: new Date() })
        .where(and(eq(agentPlans.id, planId), eq(agentPlans.org_id, orgId)));
      onEvent?.({ type: 'plan:pause', stepId: step.id, data: { reason: 'approval_boundary_failed', error: reserved } });
      return;
    }

    // Check dependencies
    if (step.depends_on?.length) {
      const allDepsCompleted = step.depends_on.every((depId) => {
        const depStep = steps.find((s) => s.id === depId);
        return depStep?.status === 'completed' || depStep?.status === 'skipped';
      });
      if (!allDepsCompleted) {
        step.status = 'failed';
        step.error = 'Dependencies not met';
        await updatePlanProgress(planId, steps, context, i);
        onEvent?.({ type: 'step:fail', stepId: step.id, data: { error: step.error } });
        continue;
      }
    }

    // Evaluate condition
    if (step.condition) {
      await readAgainFor(step.condition.field);
      const shouldRun = evaluateCondition(step.condition, readableContext());
      if (!shouldRun) {
        step.status = 'skipped';
        await updatePlanProgress(planId, steps, context, i);
        onEvent?.({ type: 'step:skip', stepId: step.id });
        continue;
      }
    }

    // Mark step running (announced only after the step's claim, below)
    step.status = 'running';
    await updatePlanProgress(planId, steps, context, i);

    try {
      if (draftStepsRefused && isDraftTextAction(step.tool)) throw new PlanApprovalBoundaryError(PLAN_DRAFT_STEP_EMPLOYEE_ERROR);
      await readAgainFor(step.params);
      const resolvedParams = resolveStepReferences(step.params, readableContext());
      if (plan.agent_employee_id && (step.tool === 'document_send' || step.tool === 'workspace_plan_import')) {
        // These proposals are reviewed against their source message, which an
        // employee records through its own document_send / workspace_plan_import tools.
        throw new PlanApprovalBoundaryError(`'${step.tool}' is proposed by the employee's own tool with its source message, not as a plan step`);
      }
      if (connectedStepsRefused && isConnectedToolName(step.tool)) {
        throw new PlanApprovalBoundaryError(CONNECTED_TOOL_UNAVAILABLE_ERROR);
      }
      // M7: a plan made before the rule, or written around it, still never edits a document.
      if (step.tool === DOCUMENT_EDIT_ACTION) throw new PlanApprovalBoundaryError(PLAN_DOCUMENT_EDIT_ERROR);
      const mcpToolPolicy = step.tool.startsWith('mcp__')
        ? (await getMCPToolsForAgent(orgId, plan.agent_employee_id ?? undefined))
          .find((tool) => tool.name === step.tool)
        : undefined;
      if (step.tool.startsWith('mcp__') && !mcpToolPolicy) {
        throw new Error(`MCP tool '${step.tool}' is unavailable or disabled`);
      }
      const isWriteAction = ACTION_TOOLS.has(step.tool)
        || Boolean(mcpToolPolicy && (
          mcpToolPolicy.isWrite
          || mcpToolPolicy.approvalTierMapped !== 'auto'
          || isDestructiveAction(mcpToolPolicy.name, resolvedParams, mcpToolPolicy.annotations)
        ));
      const approvalTierOverride = mcpToolPolicy?.approvalTierMapped;

    // Task 3.2 — if the plan was created in response to a chat message,
    // the triggering message id was stashed in context at createPlanRow
    // time. Thread it into every write-action step so created tasks etc
    // link back to the source message without the planner having to echo
    // it in every step's params.
    const planSourceMessageId =
      typeof (context as any)?.source_message_id === 'string'
        ? ((context as any).source_message_id as string)
        : null;
    if (isWriteAction && !isModuleWriteAction(step.tool) && planSourceMessageId && !resolvedParams.source_message_id) {
      resolvedParams.source_message_id = planSourceMessageId;
    }

      // A step that already has an approval row that was not approved
      // (pending, rejected, or expired, e.g. cancelled when its requester lost
      // the room: DFX2) is never run directly, whatever the tool's current
      // classification or the trust level: it keeps waiting or stops the plan.
      const [priorDecision] = await db.select({
        id: agentActions.id, status: agentActions.approval_status, key: agentActions.runtime_request_key,
        tier: agentActions.approval_tier, error: agentActions.error,
      }).from(agentActions).where(and(
        eq(agentActions.org_id, orgId),
        eq(agentActions.user_id, userId),
        eq(agentActions.plan_id, planId),
        eq(agentActions.plan_step_id, step.id),
        eq(agentActions.source, 'plan'),
        sql`${agentActions.approval_status} <> 'approved'`,
      )).limit(1);
      // A row queued by the direct path carries no request key; the reviewed
      // path would read that as changed input, so its state is honoured here.
      if (priorDecision && priorDecision.key === null && priorDecision.status !== 'pending') {
        throw new PlanApprovalBoundaryError(`Plan step '${step.id}' approval was ${priorDecision.status}`);
      }
      // Check 13: the step starts only while the plan is executing and its
      // creator still reads its rooms, checked under the creator's room-access
      // lock, so a loss cannot commit between this check and the start.
      const claim = await claimPlanStep(planId, orgId);
      if (claim === 'stopped') {
        onEvent?.({ type: 'plan:pause', data: { reason: 'externally paused' } });
        return;
      }
      if (claim === 'room_lost') {
        onEvent?.({ type: 'plan:pause', data: { reason: 'source_room_access_lost' } });
        return;
      }
      onEvent?.({ type: 'step:start', stepId: step.id });
      emitTaskProgress(i, step.description, 'started');

      if (!isWriteAction && !priorDecision) {
        // Read-only tool — execute directly
        const { result } = await executeToolCall(
          step.tool,
          resolvedParams,
          orgId,
          userId,
          plan.conversation_id ?? undefined,
          plan.agent_employee_id ?? undefined,
          // A plan made by this step keeps the parent's source message and
          // provenance, and only those (DFX3): never a source from its params.
          step.tool === 'create_plan'
            ? {
              sourceMessageId: planSourceMessageId ?? undefined,
              createdVia: (plan.context as Record<string, unknown> | null)?.created_via === 'api' ? 'api' : undefined,
            }
            : undefined,
        );
        if ((result as { error?: unknown } | null)?.error === CONNECTED_TOOL_UNAVAILABLE_ERROR) {
          throw new PlanApprovalBoundaryError(CONNECTED_TOOL_UNAVAILABLE_ERROR);
        }
        completeStep(step, resolvedParams, result);
      } else {
        // Write action — check if it's a dependency and if it should auto-execute
        const isDependency = steps.some(
          (s, idx) => idx > i && s.depends_on?.includes(step.id),
        );
        const autoExec = shouldAutoExecute(step.tool, trustLevel, resolvedParams, approvalTierOverride, mcpToolPolicy?.annotations);
        // A destructive step always needs its own approval, even as a leaf
        // step of an approved plan; it goes through the reviewed path.
        const destructiveStep = isDestructiveAction(step.tool, resolvedParams, mcpToolPolicy?.annotations);

        const tier = getApprovalTier(step.tool, approvalTierOverride);
        // A document's text is a literal written for the plan or a reference
        // resolved as the creator now (I2, fix round 2), else the step can't run.
        if (!priorDecision && documentStepTextUnavailable(step.tool, step.params, resolvedParams, planStepIds)) {
          throw new PlanApprovalBoundaryError(PLAN_DOCUMENT_TEXT_ERROR);
        }
        const execResult = priorDecision && priorDecision.key === null
          // Still pending (checked above): keep waiting on that row.
          ? { actionId: priorDecision.id, success: false, result: null, requiresApproval: true,
            error: priorDecision.error ?? 'Action requires human approval', approvalTier: priorDecision.tier }
          : !priorDecision && (autoExec || (!isDependency && !destructiveStep))
          ? await executeActionDirect(
            step.tool,
            resolvedParams,
            orgId,
            userId,
            plan.conversation_id,
            tier,
            {
              agentEmployeeId: plan.agent_employee_id ?? undefined,
              source: 'plan',
              planId,
              planStepId: step.id,
            },
          )
          : await executeReviewedPlanDependency({
            planId,
            step,
            resolvedParams,
            orgId,
            userId,
            conversationId: plan.conversation_id,
            agentEmployeeId: plan.agent_employee_id,
            approvalTier: tier,
          });

        if (execResult.success) {
          completeStep(step, resolvedParams, execResult.result);
          delete step.error;
        } else if (execResult.requiresApproval) {
          step.status = 'waiting_approval';
          step.error = execResult.error;
          await updatePlanProgress(planId, steps, context, i, 'paused');
          onEvent?.({
            type: 'plan:pause',
            stepId: step.id,
            data: {
              reason: 'approval_required',
              tool: step.tool,
              action_id: execResult.actionId,
              approval_tier: execResult.approvalTier,
            },
          });
          return;
        } else if (execResult.error === CONNECTED_TOOL_UNAVAILABLE_ERROR) {
          throw new PlanApprovalBoundaryError(CONNECTED_TOOL_UNAVAILABLE_ERROR);
        } else {
          throw new Error(execResult.error || 'Action execution failed');
        }
      }

      await updatePlanProgress(planId, steps, context, i + 1);
      onEvent?.({ type: 'step:complete', stepId: step.id, data: step.result });
      emitTaskProgress(i, step.description, 'completed');

    } catch (err) {
      const errorMsg = (err as Error).message;
      // DFX3: nothing more happens for a plan whose creator lost a room (no
      // progress, no recovery, no fail-fast rollback), even when the step
      // failed before its claim.
      const stillCurrent = await claimPlanStep(planId, orgId).catch(() => 'stopped' as const);
      if (stillCurrent !== 'ok') {
        onEvent?.({ type: 'plan:pause', stepId: step.id, data: { reason: stillCurrent === 'room_lost' ? 'source_room_access_lost' : 'externally paused' } });
        return;
      }
      emitTaskProgress(i, step.description, 'failed', errorMsg);

      if (err instanceof PlanApprovalBoundaryError) {
        step.status = 'failed';
        step.error = errorMsg;
        await db
          .update(agentPlans)
          .set({
            steps,
            context,
            current_step: i,
            status: 'paused',
            error: errorMsg,
            updated_at: new Date(),
          })
          .where(and(eq(agentPlans.id, planId), eq(agentPlans.org_id, orgId)));
        onEvent?.({
          type: 'plan:pause',
          stepId: step.id,
          data: { reason: 'approval_boundary_failed', error: errorMsg },
        });
        return;
      }

      // Task 3.9 — fail-fast mode short-circuits the recovery path, marks
      // every later step 'skipped_due_to_failure', and optionally rolls
      // back successful writes before stopping.
      if (failFast) {
        step.status = 'failed';
        step.error = errorMsg;
        for (let j = i + 1; j < steps.length; j++) {
          steps[j]!.status = 'skipped_due_to_failure';
        }
        if (rollbackOnFail) {
          await rollbackCompletedSteps(steps.slice(0, i), orgId);
        }
        await db
          .update(agentPlans)
          .set({
            ...settledPlan(),
            current_step: i,
            status: 'failed',
            error: errorMsg,
            updated_at: new Date(),
          })
          .where(eq(agentPlans.id, planId));
        onEvent?.({
          type: 'plan:fail',
          stepId: step.id,
          data: {
            reason: 'fail_fast',
            error: errorMsg,
            rolled_back: rollbackOnFail,
          },
        });
        return;
      }

      // Ask agent for alternative
      try {
        const orgRow = await db
          .select({ name: orgs.name })
          .from(orgs)
          .where(eq(orgs.id, orgId))
          .limit(1);

        const recovery = await runAgentQuery({
          content: `Step "${step.description}" using tool "${step.tool}" failed with error: ${errorMsg}. The plan is "${plan.title}". Should I try an alternative approach, skip this step, or escalate? If you have an alternative, explain what tool and params to use. If not, respond with ESCALATE.`,
          orgId,
          userId,
          orgName: orgRow[0]?.name ?? 'Unknown',
          mode: 'background',
          agentEmployeeId: plan.agent_employee_id ?? undefined,
          trustLevelOverride: trustLevel,
          // Only the text recommendation is used: no tool runs from here
          // (check 13: nothing runs for a creator who lost the plan's room).
          toolPolicy: 'none',
          // Nor is the answer, which can quote the step, kept as a note.
          durableNotes: false,
        });

        if (recovery.text.includes('ESCALATE')) {
          step.status = 'failed';
          step.error = errorMsg;
          await updatePlanProgress(planId, steps, context, i, 'paused');
          onEvent?.({
            type: 'plan:pause',
            stepId: step.id,
            data: { reason: 'step_failed_escalated', error: errorMsg },
          });
          return;
        }

        // Agent provided an alternative — mark step as failed but continue
        step.status = 'failed';
        step.error = errorMsg;
        context[step.id] = { result: { error: errorMsg, recovery: recovery.text } };
        await updatePlanProgress(planId, steps, context, i + 1);
        onEvent?.({
          type: 'step:fail',
          stepId: step.id,
          data: { error: errorMsg, recovery: recovery.text },
        });
      } catch {
        // Recovery itself failed — pause the plan
        step.status = 'failed';
        step.error = errorMsg;
        await updatePlanProgress(planId, steps, context, i, 'paused');
        onEvent?.({
          type: 'plan:pause',
          stepId: step.id,
          data: { reason: 'step_failed', error: errorMsg },
        });
        return;
      }
    }
  }

  // A recovery response may let the loop inspect later steps, but it cannot
  // convert a failed or dependency-blocked step into a successful plan.
  const failedSteps = steps.filter(
    (step) => step.status === 'failed' || step.status === 'skipped_due_to_failure',
  );
  if (failedSteps.length > 0) {
    const error = `${failedSteps.length} plan step${failedSteps.length === 1 ? '' : 's'} failed`;
    await db
      .update(agentPlans)
      .set({ status: 'failed', ...settledPlan(), error, updated_at: new Date() })
      .where(and(eq(agentPlans.id, planId), eq(agentPlans.org_id, orgId)));
    onEvent?.({ type: 'plan:fail', data: { reason: 'step_failures', error } });
    return;
  }

  const incompleteSteps = steps.filter(
    (step) => step.status !== 'completed' && step.status !== 'skipped',
  );
  if (incompleteSteps.length > 0) {
    const error = `${incompleteSteps.length} plan step${incompleteSteps.length === 1 ? '' : 's'} remained incomplete`;
    await db
      .update(agentPlans)
      .set({ status: 'paused', context, error, updated_at: new Date() })
      .where(and(eq(agentPlans.id, planId), eq(agentPlans.org_id, orgId)));
    onEvent?.({ type: 'plan:pause', data: { reason: 'incomplete_steps', error } });
    return;
  }

  // All applicable steps completed or were conditionally skipped.
  await db
    .update(agentPlans)
    .set({ status: 'completed', ...settledPlan(), error: null, updated_at: new Date() })
    .where(and(eq(agentPlans.id, planId), eq(agentPlans.org_id, orgId)));
  onEvent?.({ type: 'plan:complete' });
}

// ─── Helpers ───

/**
 * Task 3.9 — reverse successful write-action steps on fail-fast + rollback.
 *
 * Strategies per tool:
 *   - create_task       → soft-delete the created task (is_deleted = true)
 *   - post_message      → mark the created message deleted
 *   - update_task_*     → no safe reversal without a pre-state snapshot; log
 *                         a warning and skip
 *
 * Read-only steps are skipped. Non-completed steps are skipped. Errors during
 * rollback are logged but never thrown — the plan is already failing and
 * rollback is best-effort.
 */
async function rollbackCompletedSteps(
  completedSteps: PlanStep[],
  orgId: string,
): Promise<void> {
  // Walk backwards so later writes are undone before earlier ones — matches
  // the normal "last-in, first-out" rollback ordering.
  for (let i = completedSteps.length - 1; i >= 0; i--) {
    const step = completedSteps[i]!;
    if (step.status !== 'completed') continue;
    if (!ACTION_TOOLS.has(step.tool)) continue;

    try {
      switch (step.tool) {
        case 'create_task': {
          const createdId = step.result?.task_id ?? step.result?.id;
          if (!createdId) {
            console.warn(`[plan-rollback] create_task step ${logId(step.id)} has no task_id in result; skipping`
            );
            break;
          }
          await db
            .update(tasks)
            .set({ is_deleted: true, updated_at: new Date() })
            .where(and(eq(tasks.id, createdId), eq(tasks.org_id, orgId)));
          break;
        }
        case 'post_message': {
          const msgId = step.result?.message_id ?? step.result?.id;
          if (!msgId) {
            console.warn(`[plan-rollback] post_message step ${logId(step.id)} has no message_id in result; skipping`
            );
            break;
          }
          await db
            .update(messages)
            .set({ is_deleted: true, updated_at: new Date() })
            .where(and(eq(messages.id, msgId), eq(messages.org_id, orgId)));
          break;
        }
        default:
          // update_task_status, assign_task, add_knowledge, wiki_write,
          // set_due_date, set_priority, add_label, close_task, reopen_task,
          // add_dependency, remove_dependency — none of these can be safely
          // reversed without a pre-state snapshot we don't currently capture.
          console.warn(`[plan-rollback] tool "<redacted>" has no safe reversal; leaving step ${logId(step.id)} as-is`
          );
      }
    } catch (err) {
      console.warn(`[plan-rollback] step ${logId(step.id)} (<redacted>) rollback failed:`
      );
    }
  }
}

/** Context keys that are not step results. */
const RESERVED_PLAN_CONTEXT_KEYS = new Set(['source_message_id', 'task_id', 'created_via']);

/**
 * Check 13: whether the next step may start. Under the creator's room-access
 * lock (shared; lib/room-access-lock.ts) the plan is read afresh: it must
 * still be executing, and its creator must still read its rooms. A plan
 * whose creator lost a room is paused with the reason (only while still
 * executing, so an abort is never undone). A loss that commits after this
 * returns lets this step finish, as an approval made before a loss does.
 */
async function claimPlanStep(planId: string, orgId: string): Promise<'ok' | 'stopped' | 'room_lost'> {
  return db.transaction(async (tx) => {
    const [owner] = await tx.select({ userId: agentPlans.user_id }).from(agentPlans)
      .where(and(eq(agentPlans.id, planId), eq(agentPlans.org_id, orgId))).limit(1);
    if (!owner) return 'stopped';
    await lockPlanRoomAccess(tx, orgId, owner.userId, planId);
    const [current] = await tx
      .select({ status: agentPlans.status, keepsRooms: sql<boolean>`${planCreatorKeepsRoomsSql()}` })
      .from(agentPlans)
      .where(and(eq(agentPlans.id, planId), eq(agentPlans.org_id, orgId)))
      .limit(1);
    if (!current || current.status !== 'executing') return 'stopped';
    if (current.keepsRooms) return 'ok';
    await tx.update(agentPlans)
      .set({ status: 'paused', error: PLAN_ROOM_LOST_ERROR, updated_at: new Date() })
      .where(and(eq(agentPlans.id, planId), eq(agentPlans.org_id, orgId), eq(agentPlans.status, 'executing')));
    return 'room_lost';
  });
}

async function updatePlanProgress(
  planId: string,
  steps: PlanStep[],
  context: PlanContext,
  currentStep: number,
  status?: string,
): Promise<void> {
  const updates: Record<string, any> = {
    steps,
    context,
    current_step: currentStep,
    updated_at: new Date(),
  };
  if (status) updates.status = status;

  await db
    .update(agentPlans)
    .set(updates)
    .where(eq(agentPlans.id, planId));
}
