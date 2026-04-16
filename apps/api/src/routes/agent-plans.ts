import { Hono } from 'hono';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { agentPlans } from '@deft/db/schema';
import { enqueue, QUEUE_NAMES } from '../lib/queues.js';
import { createPlanRow } from '../lib/agent-plans.js';

export const agentPlanRoutes = new Hono();

// GET / — list plans (filter by status, employee)
agentPlanRoutes.get('/', async (c) => {
  try {
    const user = c.get('user');
    const status = c.req.query('status');
    const employeeId = c.req.query('employee_id');

    const conditions = [eq(agentPlans.org_id, user.org_id)];
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

    return c.json(plans);
  } catch (err) {
    console.error('Failed to list plans:', err);
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
      .where(and(eq(agentPlans.id, planId), eq(agentPlans.org_id, user.org_id)))
      .limit(1);

    if (!plan) {
      return c.json({ error: 'Plan not found', code: 'NOT_FOUND' }, 404);
    }

    return c.json(plan);
  } catch (err) {
    console.error('Failed to get plan:', err);
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
    });

    // Return the full plan row so the external API contract stays identical.
    const [plan] = await db
      .select()
      .from(agentPlans)
      .where(eq(agentPlans.id, plan_id))
      .limit(1);

    return c.json(plan, 201);
  } catch (err) {
    console.error('Failed to create plan:', err);
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
      .where(and(eq(agentPlans.id, planId), eq(agentPlans.org_id, user.org_id)))
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
      updates.steps = body.steps.map((step: any) => ({
        ...step,
        status: step.status ?? 'pending',
      }));
    }

    const [updated] = await db
      .update(agentPlans)
      .set(updates)
      .where(eq(agentPlans.id, planId))
      .returning();

    return c.json(updated);
  } catch (err) {
    console.error('Failed to update plan:', err);
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
      .where(and(eq(agentPlans.id, planId), eq(agentPlans.org_id, user.org_id)))
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

    const [updated] = await db
      .update(agentPlans)
      .set({ status: 'approved', updated_at: new Date() })
      .where(eq(agentPlans.id, planId))
      .returning();

    return c.json(updated);
  } catch (err) {
    console.error('Failed to approve plan:', err);
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
      .where(and(eq(agentPlans.id, planId), eq(agentPlans.org_id, user.org_id)))
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
      orgId: user.org_id,
      userId: user.id,
    });

    return c.json({ message: 'Plan execution enqueued', planId });
  } catch (err) {
    console.error('Failed to enqueue plan execution:', err);
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
      .where(and(eq(agentPlans.id, planId), eq(agentPlans.org_id, user.org_id)))
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

    return c.json(updated);
  } catch (err) {
    console.error('Failed to pause plan:', err);
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
      .where(and(eq(agentPlans.id, planId), eq(agentPlans.org_id, user.org_id)))
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

    await db
      .update(agentPlans)
      .set({ status: 'approved', steps, updated_at: new Date() })
      .where(eq(agentPlans.id, planId));

    await enqueue(QUEUE_NAMES.AGENT_JOBS, 'plan-executor', {
      planId,
      orgId: user.org_id,
      userId: user.id,
    });

    return c.json({ message: 'Plan resumed and execution enqueued', planId });
  } catch (err) {
    console.error('Failed to resume plan:', err);
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
      .where(and(eq(agentPlans.id, planId), eq(agentPlans.org_id, user.org_id)))
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

    return c.json(updated);
  } catch (err) {
    console.error('Failed to abort plan:', err);
    return c.json({ error: 'Failed to abort plan', code: 'INTERNAL_ERROR' }, 500);
  }
});
