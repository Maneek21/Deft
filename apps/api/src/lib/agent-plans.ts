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

import { db } from './db.js';
import { agentPlans, agentEmployees, orgs, tasks, messages } from '@deft/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { executeToolCall } from './agent-context.js';
import { shouldAutoExecute, getApprovalTier, isDestructiveAction } from './agent-approval.js';
import { executeActionDirect, isModuleWriteAction } from './agent-actions.js';
import { ACTION_TOOLS } from './agent-tools.js';
import { runAgentQuery } from './agent-runner.js';
import type { TrustLevel } from './agent-approval.js';
import { getIO } from '../socket.js';
import { getMCPToolsForAgent } from './mcp-tools.js';

// ─── Types ───

export interface PlanStep {
  id: string;
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
  const steps = input.steps.map((step) => ({
    ...step,
    status: 'pending' as const,
  }));

  const initialContext: Record<string, unknown> = {};
  if (input.source_message_id) initialContext.source_message_id = input.source_message_id;
  if (input.task_id) initialContext.task_id = input.task_id;

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
export async function executePlan(
  planId: string,
  orgId: string,
  userId: string,
  onEvent?: (event: PlanEvent) => void,
): Promise<void> {
  // 1. Load plan
  const [plan] = await db
    .select()
    .from(agentPlans)
    .where(and(eq(agentPlans.id, planId), eq(agentPlans.org_id, orgId)))
    .limit(1);

  if (!plan) throw new Error(`Plan ${planId} not found`);
  if (plan.status !== 'approved' && plan.status !== 'executing') {
    throw new Error(`Plan ${planId} cannot be executed in status '${plan.status}'`);
  }

  // 2. Load trust level
  let trustLevel: TrustLevel = 'standard';
  if (plan.agent_employee_id) {
    const [employee] = await db
      .select({ trust_level: agentEmployees.trust_level })
      .from(agentEmployees)
      .where(and(
        eq(agentEmployees.id, plan.agent_employee_id),
        eq(agentEmployees.org_id, orgId),
        eq(agentEmployees.is_active, true),
        eq(agentEmployees.is_deleted, false),
      ))
      .limit(1);
    if (!employee) throw new Error('Plan agent employee is inactive, deleted, or outside this organization');
    trustLevel = employee.trust_level as TrustLevel;
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

  const steps = plan.steps as PlanStep[];
  const context: PlanContext = (plan.context as PlanContext) ?? {};
  const startIdx = plan.current_step ?? 0;
  const failFast = plan.fail_fast === true;
  const rollbackOnFail = plan.rollback_on_fail === true;
  // Task 3.10 — if the plan is bound to a task, progress events carry the
  // task_id so the task-detail UI can render a live status strip.
  const planTaskId =
    typeof (context as any)?.task_id === 'string' ? ((context as any).task_id as string) : null;
  const totalSteps = steps.length;
  const emitTaskProgress = (
    stepIndex: number,
    stepDescription: string,
    status: 'started' | 'completed' | 'failed',
    error?: string,
  ) => {
    if (!planTaskId) return;
    const io = getIO();
    if (!io) return;
    io.to(`org:${orgId}`).emit('task:agent_progress', {
      task_id: planTaskId,
      agent_employee_id: plan.agent_employee_id ?? null,
      step_index: stepIndex,
      step_description: stepDescription,
      status,
      total_steps: totalSteps,
      ...(error ? { error } : {}),
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
      const shouldRun = evaluateCondition(step.condition, context);
      if (!shouldRun) {
        step.status = 'skipped';
        await updatePlanProgress(planId, steps, context, i);
        onEvent?.({ type: 'step:skip', stepId: step.id });
        continue;
      }
    }

    // Mark step running
    step.status = 'running';
    await updatePlanProgress(planId, steps, context, i);
    onEvent?.({ type: 'step:start', stepId: step.id });
    emitTaskProgress(i, step.description, 'started');

    try {
      const resolvedParams = resolveStepReferences(step.params, context);
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
          || isDestructiveAction(mcpToolPolicy.name)
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

      if (!isWriteAction) {
        // Read-only tool — execute directly
        const { result } = await executeToolCall(
          step.tool,
          resolvedParams,
          orgId,
          userId,
          plan.conversation_id ?? undefined,
          plan.agent_employee_id ?? undefined,
        );
        step.status = 'completed';
        step.result = result;
        context[step.id] = { result };
      } else {
        // Write action — check if it's a dependency and if it should auto-execute
        const isDependency = steps.some(
          (s, idx) => idx > i && s.depends_on?.includes(step.id),
        );
        const autoExec = shouldAutoExecute(step.tool, trustLevel, resolvedParams, approvalTierOverride);

        if (autoExec || !isDependency) {
          // Auto-execute or non-blocking write
          const tier = getApprovalTier(step.tool, approvalTierOverride);
          const execResult = await executeActionDirect(
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
          );

          if (execResult.success) {
            step.status = 'completed';
            step.result = execResult.result;
            context[step.id] = { result: execResult.result };
          } else if (execResult.requiresApproval) {
            step.status = 'waiting_approval';
            step.error = execResult.error;
            await updatePlanProgress(planId, steps, context, i, 'paused');
            onEvent?.({
              type: 'plan:pause',
              stepId: step.id,
              data: {
                reason: 'approval_policy_changed',
                action_id: execResult.actionId,
                approval_tier: execResult.approvalTier,
              },
            });
            return;
          } else {
            throw new Error(execResult.error || 'Action execution failed');
          }
        } else {
          // Needs approval — pause the plan
          step.status = 'waiting_approval';
          await updatePlanProgress(planId, steps, context, i, 'paused');
          onEvent?.({
            type: 'plan:pause',
            stepId: step.id,
            data: { reason: 'approval_required', tool: step.tool },
          });
          return;
        }
      }

      await updatePlanProgress(planId, steps, context, i + 1);
      onEvent?.({ type: 'step:complete', stepId: step.id, data: step.result });
      emitTaskProgress(i, step.description, 'completed');

    } catch (err) {
      const errorMsg = (err as Error).message;
      emitTaskProgress(i, step.description, 'failed', errorMsg);

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
            steps,
            context,
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

  // All steps processed
  await db
    .update(agentPlans)
    .set({ status: 'completed', context, updated_at: new Date() })
    .where(eq(agentPlans.id, planId));
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
            console.warn(
              `[plan-rollback] create_task step ${step.id} has no task_id in result; skipping`,
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
            console.warn(
              `[plan-rollback] post_message step ${step.id} has no message_id in result; skipping`,
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
          console.warn(
            `[plan-rollback] tool "${step.tool}" has no safe reversal; leaving step ${step.id} as-is`,
          );
      }
    } catch (err) {
      console.warn(
        `[plan-rollback] step ${step.id} (${step.tool}) rollback failed:`,
        (err as Error).message,
      );
    }
  }
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
