import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, desc } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { db } from '../lib/db.js';
import {
  agentEmployees,
  users,
  orgMembers,
  spaceMembers,
  spaces,
  agentActions,
  apiKeys,
} from '@deft/db/schema';

export const agentEmployeeRoutes = new Hono();

// ═══ TEMPLATES ═══

const ROLE_TEMPLATES = [
  {
    role: 'project_manager' as const,
    name: 'Project Manager',
    system_prompt:
      'You are a project manager agent. Your primary responsibilities are sprint tracking, blocker detection, and team coordination. You proactively monitor task progress, identify blockers before they escalate, coordinate cross-functional work, and keep the team aligned on priorities. You communicate status updates clearly and escalate risks early.',
    expertise_description:
      'Sprint tracking, blocker detection, team coordination, status reporting, risk escalation',
    native_tools: null,
    heartbeat_config:
      "### Every 30 minutes:\n- Check for tasks overdue by more than 24 hours. If found, post a summary in the task's project channel.\n- Check for tasks with status 'in_progress' that haven't been updated in 48+ hours. DM the assignee.\n\n### Every morning (if first heartbeat of the day):\n- Generate a brief standup summary from yesterday's task activity and post in #general.",
  },
  {
    role: 'engineering_lead' as const,
    name: 'Engineering Lead',
    system_prompt:
      'You are an engineering lead agent. Your primary responsibilities are code review management, PR workflow, and velocity monitoring. You track pull request lifecycles, flag stale PRs, monitor team velocity and throughput, identify bottlenecks in the development pipeline, and ensure engineering best practices are followed.',
    expertise_description:
      'Code review management, PR lifecycle tracking, velocity monitoring, pipeline bottleneck detection',
    native_tools: null,
    heartbeat_config:
      '### Every hour:\n- Check for open PRs with no review activity in 24+ hours. Post a reminder in #engineering.\n- Check for tasks blocked by code review. DM the reviewer.\n\n### Every morning:\n- Summarize merged PRs from yesterday and post in #engineering.',
  },
  {
    role: 'executive_assistant' as const,
    name: 'Executive Assistant',
    system_prompt:
      'You are an executive assistant agent. Your primary responsibilities are calendar management, meeting preparation, and daily briefings. You organize schedules, prepare meeting agendas with relevant context, generate daily briefings summarizing key updates and upcoming commitments, and proactively manage time conflicts.',
    expertise_description:
      'Calendar management, meeting preparation, daily briefings, schedule optimization',
    native_tools: null,
    heartbeat_config:
      '### Every 30 minutes:\n- Check calendar for meetings in the next 30 minutes. If found, generate a prep brief and DM the attendee.\n- Check for calendar conflicts in today\'s schedule. If found, alert the affected person.',
  },
];

// GET /templates — pre-built role templates
agentEmployeeRoutes.get('/templates', async (c) => {
  if (process.env.DEFT_SELF_HOSTED === 'true') {
    return c.json([]);
  }
  return c.json(ROLE_TEMPLATES);
});

// GET / — list org's agent employees
agentEmployeeRoutes.get('/', async (c) => {
  try {
    const user = c.get('user');

    const employees = await db
      .select()
      .from(agentEmployees)
      .where(eq(agentEmployees.org_id, user.org_id))
      .orderBy(desc(agentEmployees.created_at));

    return c.json(employees);
  } catch (err) {
    console.error('Failed to list agent employees:', err);
    return c.json({ error: 'Failed to list agent employees', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /:id — single employee detail
agentEmployeeRoutes.get('/:id', async (c) => {
  try {
    const user = c.get('user');
    const id = c.req.param('id');

    const [employee] = await db
      .select()
      .from(agentEmployees)
      .where(and(eq(agentEmployees.id, id), eq(agentEmployees.org_id, user.org_id)))
      .limit(1);

    if (!employee) {
      return c.json({ error: 'Agent employee not found', code: 'NOT_FOUND' }, 404);
    }

    return c.json(employee);
  } catch (err) {
    console.error('Failed to get agent employee:', err);
    return c.json({ error: 'Failed to get agent employee', code: 'INTERNAL_ERROR' }, 500);
  }
});

// ═══ CREATE ═══

const createSchema = z.object({
  name: z.string().min(1).max(100),
  role: z.enum(['project_manager', 'engineering_lead', 'executive_assistant', 'custom']),
  system_prompt: z.string().min(1),
  expertise_description: z.string().optional(),
  avatar_url: z.string().url().optional(),
  native_tools: z.array(z.string()).nullable().optional(),
  mcp_connection_ids: z.array(z.string()).nullable().optional(),
  disabled_tools: z.array(z.string()).nullable().optional(),
  space_ids: z.array(z.string()).nullable().optional(),
  project_ids: z.array(z.string()).nullable().optional(),
  trust_level: z.enum(['conservative', 'standard', 'autonomous']).default('conservative'),
  max_daily_actions: z.number().int().positive().default(50),
  is_byoa: z.boolean().default(false),
  byoa_model_info: z.string().optional(),
  heartbeat_enabled: z.boolean().default(false),
  heartbeat_interval_min: z.number().int().min(5).max(1440).default(30),
  heartbeat_config: z.string().optional(),
});

function roleToTitle(role: string): string {
  return role
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

agentEmployeeRoutes.post('/', async (c) => {
  try {
    const currentUser = c.get('user');
    const body = await c.req.json();
    const parsed = createSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR', details: parsed.error.flatten() }, 400);
    }

    const data = parsed.data;

    // Block non-BYOA creation if self-hosted
    if (process.env.DEFT_SELF_HOSTED === 'true' && !data.is_byoa) {
      return c.json(
        { error: 'Self-hosted mode requires BYOA (Bring Your Own API) agents', code: 'SELF_HOSTED_BYOA_ONLY' },
        403,
      );
    }

    // 1. Create user record with is_agent: true
    const title = roleToTitle(data.role);
    const [agentUser] = await db
      .insert(users)
      .values({
        name: data.name,
        is_agent: true,
        title,
        email_verified: true,
      })
      .returning();

    // 2. Create org_members record
    await db.insert(orgMembers).values({
      org_id: currentUser.org_id,
      user_id: agentUser!.id,
      role: 'member',
    });

    // 3. Create space_members — use configured spaces or all public spaces
    let spaceIdsToJoin: string[] = [];
    if (data.space_ids && data.space_ids.length > 0) {
      spaceIdsToJoin = data.space_ids;
    } else {
      const publicSpaces = await db
        .select({ id: spaces.id })
        .from(spaces)
        .where(and(eq(spaces.org_id, currentUser.org_id), eq(spaces.type, 'public')));
      spaceIdsToJoin = publicSpaces.map((s) => s.id);
    }

    for (const spaceId of spaceIdsToJoin) {
      await db
        .insert(spaceMembers)
        .values({ space_id: spaceId, user_id: agentUser!.id })
        .onConflictDoNothing();
    }

    // 4. Create agent_employees record
    const slug = data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

    const [employee] = await db
      .insert(agentEmployees)
      .values({
        org_id: currentUser.org_id,
        user_id: agentUser!.id,
        name: data.name,
        slug,
        role: data.role,
        avatar_url: data.avatar_url || null,
        system_prompt: data.system_prompt,
        expertise_description: data.expertise_description || null,
        native_tools: data.native_tools ?? null,
        mcp_connection_ids: data.mcp_connection_ids ?? null,
        disabled_tools: data.disabled_tools ?? null,
        space_ids: spaceIdsToJoin.length > 0 ? spaceIdsToJoin : null,
        project_ids: data.project_ids ?? null,
        trust_level: data.trust_level,
        max_daily_actions: data.max_daily_actions,
        is_byoa: data.is_byoa,
        byoa_model_info: data.byoa_model_info || null,
        heartbeat_enabled: data.heartbeat_enabled,
        heartbeat_interval_min: data.heartbeat_interval_min,
        heartbeat_config: data.heartbeat_config || null,
        created_by: currentUser.id,
      })
      .returning();

    // Update the user record with the agent_employee_id back-reference
    await db
      .update(users)
      .set({ agent_employee_id: employee!.id })
      .where(eq(users.id, agentUser!.id));

    // 5. If BYOA, auto-generate API key
    let rawApiKey: string | null = null;
    if (data.is_byoa) {
      const keyId = crypto.randomUUID().replace(/-/g, '').slice(0, 24);
      rawApiKey = `deft_${keyId}`;
      const keyHash = await bcrypt.hash(rawApiKey, 12);
      const keyPrefix = rawApiKey.slice(0, 12);

      await db.insert(apiKeys).values({
        org_id: currentUser.org_id,
        agent_employee_id: employee!.id,
        name: `${data.name} API Key`,
        key_hash: keyHash,
        key_prefix: keyPrefix,
        permissions: ['read:spaces', 'read:tasks', 'read:messages', 'read:members'],
        created_by: currentUser.id,
      });
    }

    return c.json(
      {
        employee: employee!,
        user_id: agentUser!.id,
        ...(rawApiKey ? { api_key: rawApiKey } : {}),
      },
      201,
    );
  } catch (err) {
    console.error('Failed to create agent employee:', err);
    return c.json({ error: 'Failed to create agent employee', code: 'INTERNAL_ERROR' }, 500);
  }
});

// ═══ UPDATE ═══

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  system_prompt: z.string().min(1).optional(),
  expertise_description: z.string().optional(),
  avatar_url: z.string().url().nullable().optional(),
  native_tools: z.array(z.string()).nullable().optional(),
  mcp_connection_ids: z.array(z.string()).nullable().optional(),
  disabled_tools: z.array(z.string()).nullable().optional(),
  space_ids: z.array(z.string()).nullable().optional(),
  project_ids: z.array(z.string()).nullable().optional(),
  trust_level: z.enum(['conservative', 'standard', 'autonomous']).optional(),
  max_daily_actions: z.number().int().positive().optional(),
  byoa_model_info: z.string().nullable().optional(),
  heartbeat_enabled: z.boolean().optional(),
  heartbeat_interval_min: z.number().int().min(5).max(1440).optional(),
  heartbeat_config: z.string().nullable().optional(),
});

agentEmployeeRoutes.put('/:id', async (c) => {
  try {
    const user = c.get('user');
    const id = c.req.param('id');
    const body = await c.req.json();
    const parsed = updateSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR', details: parsed.error.flatten() }, 400);
    }

    const [existing] = await db
      .select()
      .from(agentEmployees)
      .where(and(eq(agentEmployees.id, id), eq(agentEmployees.org_id, user.org_id)))
      .limit(1);

    if (!existing) {
      return c.json({ error: 'Agent employee not found', code: 'NOT_FOUND' }, 404);
    }

    const data = parsed.data;
    const updates: Record<string, any> = {};

    if (data.name !== undefined) updates.name = data.name;
    if (data.system_prompt !== undefined) updates.system_prompt = data.system_prompt;
    if (data.expertise_description !== undefined) updates.expertise_description = data.expertise_description;
    if (data.avatar_url !== undefined) updates.avatar_url = data.avatar_url;
    if (data.native_tools !== undefined) updates.native_tools = data.native_tools;
    if (data.mcp_connection_ids !== undefined) updates.mcp_connection_ids = data.mcp_connection_ids;
    if (data.disabled_tools !== undefined) updates.disabled_tools = data.disabled_tools;
    if (data.space_ids !== undefined) updates.space_ids = data.space_ids;
    if (data.project_ids !== undefined) updates.project_ids = data.project_ids;
    if (data.trust_level !== undefined) updates.trust_level = data.trust_level;
    if (data.max_daily_actions !== undefined) updates.max_daily_actions = data.max_daily_actions;
    if (data.byoa_model_info !== undefined) updates.byoa_model_info = data.byoa_model_info;
    if (data.heartbeat_enabled !== undefined) updates.heartbeat_enabled = data.heartbeat_enabled;
    if (data.heartbeat_interval_min !== undefined) updates.heartbeat_interval_min = data.heartbeat_interval_min;
    if (data.heartbeat_config !== undefined) updates.heartbeat_config = data.heartbeat_config;

    if (Object.keys(updates).length === 0) {
      return c.json(existing);
    }

    const [updated] = await db
      .update(agentEmployees)
      .set(updates)
      .where(eq(agentEmployees.id, id))
      .returning();

    // Also update the user name if changed
    if (data.name) {
      await db.update(users).set({ name: data.name }).where(eq(users.id, existing.user_id));
    }

    return c.json(updated);
  } catch (err) {
    console.error('Failed to update agent employee:', err);
    return c.json({ error: 'Failed to update agent employee', code: 'INTERNAL_ERROR' }, 500);
  }
});

// ═══ DELETE (soft) ═══

agentEmployeeRoutes.delete('/:id', async (c) => {
  try {
    const user = c.get('user');
    const id = c.req.param('id');

    const [existing] = await db
      .select()
      .from(agentEmployees)
      .where(and(eq(agentEmployees.id, id), eq(agentEmployees.org_id, user.org_id)))
      .limit(1);

    if (!existing) {
      return c.json({ error: 'Agent employee not found', code: 'NOT_FOUND' }, 404);
    }

    // Soft delete: deactivate employee and user
    await db.update(agentEmployees).set({ is_active: false }).where(eq(agentEmployees.id, id));
    await db.update(users).set({ is_agent: false }).where(eq(users.id, existing.user_id));

    // Expire pending agent actions
    await db
      .update(agentActions)
      .set({ approval_status: 'expired' })
      .where(
        and(
          eq(agentActions.agent_employee_id, id),
          eq(agentActions.approval_status, 'pending'),
        ),
      );

    return c.json({ success: true });
  } catch (err) {
    console.error('Failed to delete agent employee:', err);
    return c.json({ error: 'Failed to delete agent employee', code: 'INTERNAL_ERROR' }, 500);
  }
});

// ═══ PAUSE ═══

agentEmployeeRoutes.post('/:id/pause', async (c) => {
  try {
    const user = c.get('user');
    const id = c.req.param('id');

    const [existing] = await db
      .select()
      .from(agentEmployees)
      .where(and(eq(agentEmployees.id, id), eq(agentEmployees.org_id, user.org_id)))
      .limit(1);

    if (!existing) {
      return c.json({ error: 'Agent employee not found', code: 'NOT_FOUND' }, 404);
    }

    await db.update(agentEmployees).set({ is_active: false }).where(eq(agentEmployees.id, id));

    return c.json({ success: true, is_active: false });
  } catch (err) {
    console.error('Failed to pause agent employee:', err);
    return c.json({ error: 'Failed to pause agent employee', code: 'INTERNAL_ERROR' }, 500);
  }
});

// ═══ RESUME ═══

agentEmployeeRoutes.post('/:id/resume', async (c) => {
  try {
    const user = c.get('user');
    const id = c.req.param('id');

    const [existing] = await db
      .select()
      .from(agentEmployees)
      .where(and(eq(agentEmployees.id, id), eq(agentEmployees.org_id, user.org_id)))
      .limit(1);

    if (!existing) {
      return c.json({ error: 'Agent employee not found', code: 'NOT_FOUND' }, 404);
    }

    await db.update(agentEmployees).set({ is_active: true }).where(eq(agentEmployees.id, id));

    return c.json({ success: true, is_active: true });
  } catch (err) {
    console.error('Failed to resume agent employee:', err);
    return c.json({ error: 'Failed to resume agent employee', code: 'INTERNAL_ERROR' }, 500);
  }
});

// ═══ ACTIVITY ═══

agentEmployeeRoutes.get('/:id/activity', async (c) => {
  try {
    const user = c.get('user');
    const id = c.req.param('id');

    // Verify employee belongs to org
    const [existing] = await db
      .select()
      .from(agentEmployees)
      .where(and(eq(agentEmployees.id, id), eq(agentEmployees.org_id, user.org_id)))
      .limit(1);

    if (!existing) {
      return c.json({ error: 'Agent employee not found', code: 'NOT_FOUND' }, 404);
    }

    const actions = await db
      .select()
      .from(agentActions)
      .where(eq(agentActions.agent_employee_id, id))
      .orderBy(desc(agentActions.created_at))
      .limit(50);

    return c.json(actions);
  } catch (err) {
    console.error('Failed to get agent employee activity:', err);
    return c.json({ error: 'Failed to get activity', code: 'INTERNAL_ERROR' }, 500);
  }
});
