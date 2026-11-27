import { Hono } from 'hono';
import { eq, and, desc, inArray, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { agentPlans } from '@deft/db/schema';
import { readableSpaceSql } from '../lib/space-visibility.js';
import { enqueue, QUEUE_NAMES } from '../lib/queues.js';
import {
  assertPlanEmployeeBindable,
  assertPlanStepsAllowedFor,
  createPlanRow,
  PLAN_EMPLOYEE_UNAVAILABLE_ERROR,
  planCreatorKeepsRoomsSql,
  PlanAccessError,
  planStepsForStorage,
  planWithDocumentReferences,
  type PlanStep,
} from '../lib/agent-plans.js';
import { getActiveOrgMembership } from '../lib/org-membership.js';
import { lockPlanRoomAccess } from '../lib/room-access-lock.js';
import { isDestructiveAction } from '../lib/agent-approval.js';
import { getMCPToolsForAgent } from '../lib/mcp-tools.js';

export const agentPlanRoutes = new Hono();

/**
 * A plan is approved, started, resumed or cancelled by its creator or by an
 * owner/admin of its workspace. A run always executes for the creator.
 */
async function planManagerScope(orgId: string, userId: string): Promise<SQL> {
  const membership = await getActiveOrgMembership(orgId, userId);
  return membership?.role === 'owner' || membership?.role === 'admin'
    ? eq(agentPlans.org_id, orgId)
    : and(eq(agentPlans.org_id, orgId), eq(agentPlans.user_id, userId))!;
}

/**
 * Stamp step metadata without occupying a caller-controlled step-result key
 * in context. Approval replaces any approver supplied with the draft steps.
 */
function withPlanApprover(steps: PlanStep[], userId: string): PlanStep[] {
  return steps.map((step) => ({ ...step, approved_by_user_id: userId }));
}

/**
 * Pause and abort stay open whoever lost what (stopping is always safe), but
 * a plan whose creator lost one of its rooms is answered with its id and
 * status only (check 13: nothing of the room is shown).
 */
async function stopReply(plan: typeof agentPlans.$inferSelect | undefined) {
  if (!plan) return plan;
  const [kept] = await db.select({ id: agentPlans.id }).from(agentPlans)
    .where(and(eq(agentPlans.id, plan.id), eq(agentPlans.org_id, plan.org_id), planCreatorKeepsRoomsSql()))
    .limit(1);
  return kept ? withDestructiveMarks(plan) : { id: plan.id, status: plan.status };
}

function planAccessRefusal(err: unknown) {
  if (!(err instanceof PlanAccessError)) return null;
  return err.message === PLAN_EMPLOYEE_UNAVAILABLE_ERROR
    ? { body: { error: err.message, code: 'INVALID_AGENT_EMPLOYEE' }, status: 400 as const }
    : { body: { error: err.message, code: 'FORBIDDEN' }, status: 403 as const };
}

/**
 * Every plan payload a reviewer sees marks each step `destructive`, computed
 * with the classifier execution uses (lib/agent-plans.ts executePlan): tool
 * name, params, and, for a connected tool, its current annotations
 * (destructiveHint). When the live connected tool cannot be resolved, the
 * mark falls back to name and params. Any stored or client-sent value is
 * replaced. A destructive step waits for its own approval when the plan runs.
 */
async function withDestructiveMarks<T extends {
  steps: unknown; org_id?: string; agent_employee_id?: string | null;
} | undefined>(stored: T): Promise<T> {
  if (!stored || !Array.isArray(stored.steps)) return stored;
  // M7 (rule C4): a completed document step is shown as references only,
  // whenever it was stored (lib/agent-plans.ts planWithDocumentReferences).
  const plan = planWithDocumentReferences(stored as NonNullable<T> & { steps: unknown[] });
  const hasMcpStep = plan.steps.some((step: any) => String(step?.tool ?? '').startsWith('mcp__'));
  const liveTools = hasMcpStep && plan.org_id
    ? await getMCPToolsForAgent(plan.org_id, plan.agent_employee_id ?? undefined).catch(() => [])
    : [];
  return {
    ...plan,
    steps: plan.steps.map((step: any) => {
      const tool = String(step?.tool ?? '');
      const annotations = liveTools.find((candidate) => candidate.name === tool)?.annotations;
      return { ...step, destructive: isDestructiveAction(tool, step?.params, annotations) };
    }),
  };
}

// GET / — list plans (filter by status, employee)
agentPlanRoutes.get('/', async (c) => {
  try {
    const user = c.get('user');
    const status = c.req.query('status');
    const employeeId = c.req.query('employee_id');

    // Check 13: plans from a room the creator lost leave their list and views.
    const conditions = [eq(agentPlans.org_id, user.org_id), eq(agentPlans.user_id, user.id), planCreatorKeepsRoomsSql()];
    if (status) {
      conditions.push(eq(agentPlans.status, status as any));
    }
    if (employeeId) {
      conditions.push(eq(agentPlans.agent_employee_id, employeeId));
    }

    const plans = await db
      .select()
      .from(agentPlans)
      .where(and(...conditions))
      .orderBy(desc(agentPlans.created_at))
      .limit(50);

    return c.json(await Promise.all(plans.map((plan) => withDestructiveMarks(plan))));
  } catch (err) {
    console.error('Failed to list plans:');
    return c.json({ error: 'Failed to list plans', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /:id — get plan detail
agentPlanRoutes.get('/:id', async (c) => {
  try {
    const user = c.get('user');
    const planId = c.req.param('id');

    const [plan] = await db
      .select()
      .from(agentPlans)
      .where(and(eq(agentPlans.id, planId), eq(agentPlans.org_id, user.org_id), eq(agentPlans.user_id, user.id), planCreatorKeepsRoomsSql()))
      .limit(1);

    if (!plan) {
      return c.json({ error: 'Plan not found', code: 'NOT_FOUND' }, 404);
    }

    return c.json(await withDestructiveMarks(plan));
  } catch (err) {
    console.error('Failed to get plan:');
    return c.json({ error: 'Failed to get plan', code: 'INTERNAL_ERROR' }, 500);
  }
});

// POST / — create plan
agentPlanRoutes.post('/', async (c) => {
  try {
    const user = c.get('user');
    const body = await c.req.json();

    if (!body.title || !body.steps || !Array.isArray(body.steps)) {
      return c.json({ error: 'title and steps are required', code: 'VALIDATION_ERROR' }, 400);
    }

    if (body.agent_employee_id != null) {
      if (typeof body.agent_employee_id !== 'string') throw new PlanAccessError(PLAN_EMPLOYEE_UNAVAILABLE_ERROR);
      await assertPlanEmployeeBindable(user.org_id, body.agent_employee_id);
    }

    // A plan is bound only to a room its creator can read (DFX3): the read
    // and run gates would refuse it anyway.
    if (body.conversation_id != null) {
      if (typeof body.conversation_id !== 'string') {
        return c.json({ error: 'conversation_id must be a string', code: 'VALIDATION_ERROR' }, 400);
      }
      // readableSpaceSql reads the room itself (id and workspace given as values).
      const readable = await db.execute(sql`SELECT ${readableSpaceSql(user.id, sql`${body.conversation_id}`, sql`${user.org_id}`)} AS ok`);
      if ((readable.rows[0] as { ok?: boolean } | undefined)?.ok !== true) {
        return c.json({ error: 'Space not found', code: 'NOT_FOUND' }, 404);
      }
    }

    const { plan_id } = await createPlanRow({
      org_id: user.org_id,
      user_id: user.id,
      agent_employee_id: body.agent_employee_id ?? null,
      conversation_id: body.conversation_id ?? null,
      title: body.title,
      description: body.description ?? null,
      steps: body.steps,
      // Task 3.9 — plan fail-fast + rollback-on-fail modes
      fail_fast: body.fail_fast === true,
      rollback_on_fail: body.rollback_on_fail === true,
      // Task 3.10 — bind the plan to a task so progress events can stream
      task_id: body.task_id ?? null,
      created_via: 'api',
    });

    // Return the full plan row so the external API contract stays identical.
    const [plan] = await db
      .select()
      .from(agentPlans)
      .where(eq(agentPlans.id, plan_id))
      .limit(1);

    return c.json(await withDestructiveMarks(plan), 201);
  } catch (err) {
    const refusal = planAccessRefusal(err);
    if (refusal) return c.json(refusal.body, refusal.status);
    console.error('Failed to create plan:');
    return c.json({ error: 'Failed to create plan', code: 'INTERNAL_ERROR' }, 500);
  }
});

// PUT /:id — edit plan (only draft or paused)
agentPlanRoutes.put('/:id', async (c) => {
  try {
    const user = c.get('user');
    const planId = c.req.param('id');
    const body = await c.req.json();

    const [existing] = await db
      .select()
      .from(agentPlans)
      .where(and(eq(agentPlans.id, planId), eq(agentPlans.org_id, user.org_id), eq(agentPlans.user_id, user.id), planCreatorKeepsRoomsSql()))
      .limit(1);

    if (!existing) {
      return c.json({ error: 'Plan not found', code: 'NOT_FOUND' }, 404);
    }

    if (existing.status !== 'draft' && existing.status !== 'paused') {
      return c.json(
        { error: 'Can only edit plans in draft or paused status', code: 'INVALID_STATE' },
        400,
      );
    }

    const updates: Record<string, any> = { updated_at: new Date() };
    if (body.title) updates.title = body.title;
    if (body.description !== undefined) updates.description = body.description;
    if (body.steps) {
      await assertPlanStepsAllowedFor(user.org_id, user.id, body.steps);
      // M7 fix round 1 (I2): an edited plan stores no document text either.
      updates.steps = planStepsForStorage(body.steps as any[]).map((step: any) => ({
        ...step,
        approved_by_user_id: (existing.steps as PlanStep[]).find((prior) => prior.id === step.id)?.approved_by_user_id,
        status: step.status ?? 'pending',
      }));
    }

    // The room rule and the state are part of the update itself, read under
    // the creator's room-access lock and the plan's room-row locks (check 13).
    const [updated] = await db.transaction(async (tx) => {
      await lockPlanRoomAccess(tx, existing.org_id, existing.user_id, planId);
      return tx
        .update(agentPlans)
        .set(updates)
        .where(and(eq(agentPlans.id, planId), eq(agentPlans.org_id, user.org_id),
          inArray(agentPlans.status, ['draft', 'paused']), planCreatorKeepsRoomsSql()))
        .returning();
    });
    if (!updated) return c.json({ error: 'Plan not found', code: 'NOT_FOUND' }, 404);

    return c.json(await withDestructiveMarks(updated));
  } catch (err) {
    const refusal = planAccessRefusal(err);
    if (refusal) return c.json(refusal.body, refusal.status);
    console.error('Failed to update plan:');
    return c.json({ error: 'Failed to update plan', code: 'INTERNAL_ERROR' }, 500);
  }
});

// POST /:id/approve — set status to 'approved'
agentPlanRoutes.post('/:id/approve', async (c) => {
  try {
    const user = c.get('user');
    const planId = c.req.param('id');

    const [plan] = await db
      .select()
      .from(agentPlans)
      .where(and(eq(agentPlans.id, planId), await planManagerScope(user.org_id, user.id), planCreatorKeepsRoomsSql()))
      .limit(1);

    if (!plan) {
      return c.json({ error: 'Plan not found', code: 'NOT_FOUND' }, 404);
    }

    if (plan.status !== 'draft' && plan.status !== 'paused') {
      return c.json(
        { error: 'Can only approve plans in draft or paused status', code: 'INVALID_STATE' },
        400,
      );
    }

    await assertPlanStepsAllowedFor(plan.org_id, plan.user_id, plan.steps);

    const [updated] = await db.transaction(async (tx) => {
      await lockPlanRoomAccess(tx, plan.org_id, plan.user_id, planId);
      return tx
        .update(agentPlans)
        .set({ status: 'approved', steps: withPlanApprover(plan.steps as PlanStep[], user.id), updated_at: new Date() })
        .where(and(eq(agentPlans.id, planId), eq(agentPlans.org_id, plan.org_id),
          inArray(agentPlans.status, ['draft', 'paused']), planCreatorKeepsRoomsSql()))
        .returning();
    });
    if (!updated) return c.json({ error: 'Plan not found', code: 'NOT_FOUND' }, 404);

    return c.json(await withDestructiveMarks(updated));
  } catch (err) {
    const refusal = planAccessRefusal(err);
    if (refusal) return c.json(refusal.body, refusal.status);
    console.error('Failed to approve plan:');
    return c.json({ error: 'Failed to approve plan', code: 'INTERNAL_ERROR' }, 500);
  }
});

// POST /:id/execute — enqueue plan-executor job
agentPlanRoutes.post('/:id/execute', async (c) => {
  try {
    const user = c.get('user');
    const planId = c.req.param('id');

    const [plan] = await db
      .select()
      .from(agentPlans)
      .where(and(eq(agentPlans.id, planId), await planManagerScope(user.org_id, user.id), planCreatorKeepsRoomsSql()))
      .limit(1);

    if (!plan) {
      return c.json({ error: 'Plan not found', code: 'NOT_FOUND' }, 404);
    }

    if (plan.status !== 'approved') {
      return c.json(
        { error: 'Plan must be approved before execution', code: 'INVALID_STATE' },
        400,
      );
    }

    await enqueue(QUEUE_NAMES.AGENT_JOBS, 'plan-executor', {
      planId,
      orgId: plan.org_id,
      userId: plan.user_id,
    });

    return c.json({ message: 'Plan execution enqueued', planId });
  } catch (err) {
    console.error('Failed to enqueue plan execution:');
    return c.json({ error: 'Failed to enqueue plan execution', code: 'INTERNAL_ERROR' }, 500);
  }
});

// POST /:id/pause — set status to 'paused'
agentPlanRoutes.post('/:id/pause', async (c) => {
  try {
    const user = c.get('user');
    const planId = c.req.param('id');

    const [plan] = await db
      .select()
      .from(agentPlans)
      .where(and(eq(agentPlans.id, planId), eq(agentPlans.org_id, user.org_id), eq(agentPlans.user_id, user.id)))
      .limit(1);

    if (!plan) {
      return c.json({ error: 'Plan not found', code: 'NOT_FOUND' }, 404);
    }

    if (plan.status !== 'executing') {
      return c.json(
        { error: 'Can only pause executing plans', code: 'INVALID_STATE' },
        400,
      );
    }

    const [updated] = await db
      .update(agentPlans)
      .set({ status: 'paused', updated_at: new Date() })
      .where(eq(agentPlans.id, planId))
      .returning();

    return c.json(await stopReply(updated));
  } catch (err) {
    console.error('Failed to pause plan:');
    return c.json({ error: 'Failed to pause plan', code: 'INTERNAL_ERROR' }, 500);
  }
});

// POST /:id/resume — set status to 'executing', enqueue executor
agentPlanRoutes.post('/:id/resume', async (c) => {
  try {
    const user = c.get('user');
    const planId = c.req.param('id');

    const [plan] = await db
      .select()
      .from(agentPlans)
      .where(and(eq(agentPlans.id, planId), await planManagerScope(user.org_id, user.id), planCreatorKeepsRoomsSql()))
      .limit(1);

    if (!plan) {
      return c.json({ error: 'Plan not found', code: 'NOT_FOUND' }, 404);
    }

    if (plan.status !== 'paused') {
      return c.json(
        { error: 'Can only resume paused plans', code: 'INVALID_STATE' },
        400,
      );
    }

    // Mark any waiting_approval steps as pending so they can re-execute
    const steps = (plan.steps as any[]).map((step: any) => {
      if (step.status === 'waiting_approval') {
        return { ...step, status: 'pending' };
      }
      return step;
    });

    const [resumed] = await db.transaction(async (tx) => {
      await lockPlanRoomAccess(tx, plan.org_id, plan.user_id, planId);
      return tx
        .update(agentPlans)
        .set({ status: 'approved', steps: withPlanApprover(steps, user.id), updated_at: new Date() })
        .where(and(eq(agentPlans.id, planId), eq(agentPlans.org_id, plan.org_id),
          eq(agentPlans.status, 'paused'), planCreatorKeepsRoomsSql()))
        .returning({ id: agentPlans.id });
    });
    if (!resumed) return c.json({ error: 'Plan not found', code: 'NOT_FOUND' }, 404);

    await enqueue(QUEUE_NAMES.AGENT_JOBS, 'plan-executor', {
      planId,
      orgId: plan.org_id,
      userId: plan.user_id,
    });

    return c.json({ message: 'Plan resumed and execution enqueued', planId });
  } catch (err) {
    console.error('Failed to resume plan:');
    return c.json({ error: 'Failed to resume plan', code: 'INTERNAL_ERROR' }, 500);
  }
});

// POST /:id/abort — set status to 'failed'
agentPlanRoutes.post('/:id/abort', async (c) => {
  try {
    const user = c.get('user');
    const planId = c.req.param('id');

    const [plan] = await db
      .select()
      .from(agentPlans)
      .where(and(eq(agentPlans.id, planId), await planManagerScope(user.org_id, user.id)))
      .limit(1);

    if (!plan) {
      return c.json({ error: 'Plan not found', code: 'NOT_FOUND' }, 404);
    }

    if (plan.status === 'completed' || plan.status === 'failed') {
      return c.json(
        { error: 'Plan is already in a terminal state', code: 'INVALID_STATE' },
        400,
      );
    }

    const [updated] = await db
      .update(agentPlans)
      .set({ status: 'failed', error: 'Aborted by user', updated_at: new Date() })
      .where(eq(agentPlans.id, planId))
      .returning();

    return c.json(await stopReply(updated));
  } catch (err) {
    console.error('Failed to abort plan:');
    return c.json({ error: 'Failed to abort plan', code: 'INTERNAL_ERROR' }, 500);
  }
});
