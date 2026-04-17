import { Hono } from 'hono';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { workflowRules, workflowRuns } from '@deft/db/schema';

export const workflowRoutes = new Hono();

// Task 5.7 — supported v1 trigger + action kinds. CRUD validates payloads
// against these so the executor never has to defend against unknown shapes.
const SUPPORTED_TRIGGER_TYPES = new Set(['task.status_changed']);
const SUPPORTED_ACTION_KINDS = new Set(['add_comment', 'assign_to', 'add_label', 'notify']);

function validateActionConfig(actionType: string, actionConfig: unknown): string | null {
  const cfg = (actionConfig ?? {}) as Record<string, unknown>;
  // Multi-action shape: action_type can be 'composite' with action_config.actions=[...]
  if (actionType === 'composite') {
    const actions = (cfg as any).actions;
    if (!Array.isArray(actions) || actions.length === 0) {
      return 'action_config.actions[] required for composite workflows';
    }
    for (const a of actions) {
      if (!a || !SUPPORTED_ACTION_KINDS.has(a.kind)) {
        return `unsupported action kind: ${a?.kind}`;
      }
    }
    return null;
  }
  if (!SUPPORTED_ACTION_KINDS.has(actionType)) {
    return `unsupported action_type: ${actionType}`;
  }
  return null;
}

// GET /api/workflows — list all rules for org
workflowRoutes.get('/', async (c) => {
  const user = c.get('user');

  const rules = await db.select()
    .from(workflowRules)
    .where(eq(workflowRules.org_id, user.org_id))
    .orderBy(desc(workflowRules.created_at));

  return c.json(rules);
});

// POST /api/workflows — create rule
workflowRoutes.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const { name, trigger_type, trigger_config, action_type, action_config, is_active } = body;

  if (!name || !trigger_type || !trigger_config || !action_type || !action_config) {
    return c.json({ error: 'name, trigger_type, trigger_config, action_type, and action_config are required', code: 'VALIDATION_ERROR' }, 400);
  }
  if (!SUPPORTED_TRIGGER_TYPES.has(trigger_type)) {
    return c.json({ error: `unsupported trigger_type: ${trigger_type}`, code: 'VALIDATION_ERROR' }, 400);
  }
  const actionErr = validateActionConfig(action_type, action_config);
  if (actionErr) {
    return c.json({ error: actionErr, code: 'VALIDATION_ERROR' }, 400);
  }

  const [rule] = await db.insert(workflowRules).values({
    org_id: user.org_id,
    name,
    trigger_type,
    trigger_config,
    action_type,
    action_config,
    is_active: is_active === undefined ? true : !!is_active,
    created_by: user.id,
  }).returning();

  return c.json(rule, 201);
});

// PATCH /api/workflows/:id — update rule
workflowRoutes.patch('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const body = await c.req.json();
  const { name, trigger_type, trigger_config, action_type, action_config, is_active } = body;

  if (trigger_type !== undefined && !SUPPORTED_TRIGGER_TYPES.has(trigger_type)) {
    return c.json({ error: `unsupported trigger_type: ${trigger_type}`, code: 'VALIDATION_ERROR' }, 400);
  }
  if (action_type !== undefined && action_config !== undefined) {
    const actionErr = validateActionConfig(action_type, action_config);
    if (actionErr) {
      return c.json({ error: actionErr, code: 'VALIDATION_ERROR' }, 400);
    }
  }

  const updates: Record<string, unknown> = { updated_at: new Date() };
  if (name !== undefined) updates.name = name;
  if (trigger_type !== undefined) updates.trigger_type = trigger_type;
  if (trigger_config !== undefined) updates.trigger_config = trigger_config;
  if (action_type !== undefined) updates.action_type = action_type;
  if (action_config !== undefined) updates.action_config = action_config;
  if (is_active !== undefined) updates.is_active = is_active;

  const [updated] = await db.update(workflowRules)
    .set(updates)
    .where(and(eq(workflowRules.id, id), eq(workflowRules.org_id, user.org_id)))
    .returning();

  if (!updated) {
    return c.json({ error: 'Workflow rule not found', code: 'NOT_FOUND' }, 404);
  }

  return c.json(updated);
});

// DELETE /api/workflows/:id — delete rule
workflowRoutes.delete('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');

  // Delete runs first
  await db.delete(workflowRuns).where(eq(workflowRuns.rule_id, id));

  const [deleted] = await db.delete(workflowRules)
    .where(and(eq(workflowRules.id, id), eq(workflowRules.org_id, user.org_id)))
    .returning();

  if (!deleted) {
    return c.json({ error: 'Workflow rule not found', code: 'NOT_FOUND' }, 404);
  }

  return c.json({ success: true });
});

// GET /api/workflows/:id/runs — list recent runs
workflowRoutes.get('/:id/runs', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');

  // Ensure the rule belongs to the caller's org before exposing runs.
  const [rule] = await db.select({ id: workflowRules.id })
    .from(workflowRules)
    .where(and(eq(workflowRules.id, id), eq(workflowRules.org_id, user.org_id)))
    .limit(1);
  if (!rule) {
    return c.json({ error: 'Workflow rule not found', code: 'NOT_FOUND' }, 404);
  }

  const runs = await db.select()
    .from(workflowRuns)
    .where(eq(workflowRuns.rule_id, id))
    .orderBy(desc(workflowRuns.executed_at))
    .limit(50);

  return c.json(runs);
});
