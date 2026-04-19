import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, desc, sql } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { db } from '../lib/db.js';
import {
  agentEmployees,
  agentEmployeeSkills,
  agentHeartbeatTurns,
  agentSessionTurns,
  users,
  orgMembers,
  spaceMembers,
  spaces,
  skills,
  agentActions,
  apiKeys,
} from '@deft/db/schema';
import type { SkillAgentConfig } from '../lib/skill-config.js';

export const agentEmployeeRoutes = new Hono();

// ═══ BYOA / provider readiness ═══

/**
 * Returns true when the org is allowed to create non-BYOA agents, OR when
 * self-hosted mode is active AND the caller has already opted into BYOA.
 * Exposed as a standalone helper so both the GET pre-flight and the POST
 * defense-in-depth check share the same logic.
 *
 * "ready" means: the wizard can proceed. In cloud mode it is always true.
 * In self-hosted mode it is true only when the caller intends is_byoa=true,
 * but since the GET pre-flight doesn't know the caller's intent yet we
 * return ready=false in self-hosted mode so the UI can surface the gate.
 */
function isOrgProviderReady(): boolean {
  return process.env.DEFT_SELF_HOSTED !== 'true';
}

// GET /provider-readiness — wizard pre-flight. Returns { ready, reason? }.
agentEmployeeRoutes.get('/provider-readiness', async (c) => {
  try {
    const ready = isOrgProviderReady();
    if (ready) return c.json({ ready: true });
    return c.json({
      ready: false,
      reason:
        'Self-hosted mode requires a BYOA provider. Configure one in Settings → Integrations.',
    });
  } catch (err) {
    console.error('provider-readiness failed:', err);
    return c.json({ ready: false, reason: 'Failed to check provider readiness.' }, 500);
  }
});

// ═══ TEMPLATES ═══

const ROLE_TEMPLATES = [
  {
    role: 'project_manager' as const,
    name: 'Project Manager',
    system_prompt:
      'You are a project manager agent. Your primary responsibilities are sprint tracking, blocker detection, and team coordination. You proactively monitor task progress, identify blockers before they escalate, coordinate cross-functional work, and keep the team aligned on priorities. You communicate status updates clearly and escalate risks early.\n\n## Web Browsing\n- You may have web browsing tools available (Playwright). Use them when you need to:\n  - Research external information relevant to tasks or projects\n  - Verify links or resources shared by team members\n  - Check project documentation on external sites\n- Always summarize what you find — don\'t dump raw page content.',
    expertise_description:
      'Sprint tracking, blocker detection, team coordination, status reporting, risk escalation',
    heartbeat_config:
      "### Every 30 minutes:\n- Check for tasks overdue by more than 24 hours. If found, post a summary in the task's project channel.\n- Check for tasks with status 'in_progress' that haven't been updated in 48+ hours. DM the assignee.\n\n### Every morning (if first heartbeat of the day):\n- Generate a brief standup summary from yesterday's task activity and post in #general.",
  },
  {
    role: 'engineering_lead' as const,
    name: 'Engineering Lead',
    system_prompt:
      'You are an engineering lead agent. Your primary responsibilities are code review management, PR workflow, and velocity monitoring. You track pull request lifecycles, flag stale PRs, monitor team velocity and throughput, identify bottlenecks in the development pipeline, and ensure engineering best practices are followed.\n\n## Web Browsing\n- You may have web browsing tools available (Playwright). Use them when you need to:\n  - Check npm package versions, security advisories, or documentation\n  - Review PR descriptions or CI status on GitHub (if not connected natively)\n  - Research technical solutions or library comparisons\n- Always summarize findings concisely with links.',
    expertise_description:
      'Code review management, PR lifecycle tracking, velocity monitoring, pipeline bottleneck detection',
    heartbeat_config:
      '### Every hour:\n- Check for open PRs with no review activity in 24+ hours. Post a reminder in #engineering.\n- Check for tasks blocked by code review. DM the reviewer.\n\n### Every morning:\n- Summarize merged PRs from yesterday and post in #engineering.',
  },
  {
    role: 'executive_assistant' as const,
    name: 'Executive Assistant',
    system_prompt:
      'You are an executive assistant agent. Your primary responsibilities are calendar management, meeting preparation, and daily briefings. You organize schedules, prepare meeting agendas with relevant context, generate daily briefings summarizing key updates and upcoming commitments, and proactively manage time conflicts.\n\n## Web Browsing\n- You may have web browsing tools available (Playwright). Use them when you need to:\n  - Research meeting attendees or their companies\n  - Check travel or venue information for upcoming meetings\n  - Verify links shared in conversations\n- Always provide actionable summaries.',
    expertise_description:
      'Calendar management, meeting preparation, daily briefings, schedule optimization',
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
// Phase 6.5 — supports `?expand=stats` to enrich each row with pending
// action counts, 24h session turn counts, last turn timestamp, and 24h
// avg latency. Existing callers (UI + tests) that don't pass the query
// continue to get the bare row shape.
agentEmployeeRoutes.get('/', async (c) => {
  try {
    const user = c.get('user');
    const expand = c.req.query('expand') ?? '';
    const wantsStats = expand.split(',').map(s => s.trim()).includes('stats');

    const employees = await db
      .select()
      .from(agentEmployees)
      .where(eq(agentEmployees.org_id, user.org_id))
      .orderBy(desc(agentEmployees.created_at));

    if (!wantsStats || employees.length === 0) {
      return c.json(employees);
    }

    // Aggregate pending action counts per employee.
    const pendingRows = await db.execute(sql`
      SELECT agent_employee_id, COUNT(*)::int AS cnt
      FROM agent_actions
      WHERE org_id = ${user.org_id}
        AND agent_employee_id IS NOT NULL
        AND approval_status = 'pending'
      GROUP BY agent_employee_id
    `);
    const pendingMap = new Map<string, number>();
    for (const r of ((pendingRows as any).rows ?? pendingRows) as any[]) {
      if (r.agent_employee_id) pendingMap.set(r.agent_employee_id, Number(r.cnt));
    }

    // 24h session turn stats: count, last_turn_at, avg latency.
    const turnStats = await db.execute(sql`
      SELECT
        employee_id,
        COUNT(*)::int AS cnt_24h,
        MAX(created_at) AS last_turn_at,
        AVG(latency_ms)::int AS avg_latency
      FROM agent_session_turns
      WHERE org_id = ${user.org_id}
        AND created_at > now() - interval '24 hours'
      GROUP BY employee_id
    `);
    const turnMap = new Map<
      string,
      { cnt_24h: number; last_turn_at: string | null; avg_latency: number | null }
    >();
    for (const r of ((turnStats as any).rows ?? turnStats) as any[]) {
      if (r.employee_id) {
        turnMap.set(r.employee_id, {
          cnt_24h: Number(r.cnt_24h ?? 0),
          last_turn_at: r.last_turn_at ?? null,
          avg_latency: r.avg_latency != null ? Number(r.avg_latency) : null,
        });
      }
    }

    // Also fetch last_turn_at overall (not just 24h) so the UI can still
    // show a "last turn" chip even for dormant employees.
    const lastTurnOverall = await db.execute(sql`
      SELECT employee_id, MAX(created_at) AS last_turn_at
      FROM agent_session_turns
      WHERE org_id = ${user.org_id}
      GROUP BY employee_id
    `);
    const lastTurnMap = new Map<string, string | null>();
    for (const r of ((lastTurnOverall as any).rows ?? lastTurnOverall) as any[]) {
      if (r.employee_id) lastTurnMap.set(r.employee_id, r.last_turn_at ?? null);
    }

    const enriched = employees.map((emp) => {
      const turn = turnMap.get(emp.id);
      return {
        ...emp,
        pending_action_count: pendingMap.get(emp.id) ?? 0,
        recent_turn_count_24h: turn?.cnt_24h ?? 0,
        last_turn_at: turn?.last_turn_at ?? lastTurnMap.get(emp.id) ?? null,
        avg_latency_ms_24h: turn?.avg_latency ?? null,
      };
    });

    return c.json(enriched);
  } catch (err) {
    console.error('Failed to list agent employees:', err);
    return c.json({ error: 'Failed to list agent employees', code: 'INTERNAL_ERROR' }, 500);
  }
});

// Phase 6.5 / Phase 10 — session inspector feed for an employee.
//
// Phase 6.5 shipped the first cut (last 20 turns, compact fields).
// Phase 10 extends this to:
//   - accept `?limit=<1..100>` (default 20)
//   - accept `?trigger_kind=` and `?result=` filters
//   - include the full `input_messages_json` + `tool_calls_json` so the
//     drawer can render a proper session inspector
// The UI is responsible for paginating by incrementing `limit`.
agentEmployeeRoutes.get('/:id/turns', async (c) => {
  try {
    const user = c.get('user');
    const id = c.req.param('id');

    // Scope check — the caller must share the employee's org.
    const [existing] = await db
      .select({ id: agentEmployees.id, org_id: agentEmployees.org_id })
      .from(agentEmployees)
      .where(eq(agentEmployees.id, id))
      .limit(1);
    if (!existing) {
      return c.json({ error: 'Agent employee not found', code: 'NOT_FOUND' }, 404);
    }
    if (existing.org_id !== user.org_id) {
      return c.json({ error: 'forbidden', code: 'FORBIDDEN' }, 403);
    }

    // Parse ?limit (1..100, default 20).
    const limitRaw = c.req.query('limit');
    let limit = 20;
    if (limitRaw !== undefined) {
      const n = parseInt(limitRaw, 10);
      if (!Number.isFinite(n) || n <= 0) {
        return c.json({ error: 'Invalid limit', code: 'VALIDATION_ERROR' }, 400);
      }
      limit = Math.min(n, 100);
    }

    const triggerKind = c.req.query('trigger_kind');
    const result = c.req.query('result');

    const conds = [eq(agentSessionTurns.employee_id, id)];
    if (triggerKind) conds.push(eq(agentSessionTurns.trigger_kind, triggerKind));
    if (result) {
      conds.push(
        eq(
          agentSessionTurns.result,
          result as 'success' | 'timeout' | 'error' | 'rejected_approval',
        ),
      );
    }

    const turns = await db
      .select({
        id: agentSessionTurns.id,
        trigger_kind: agentSessionTurns.trigger_kind,
        triggering_message_id: agentSessionTurns.triggering_message_id,
        space_id: agentSessionTurns.space_id,
        input_messages_json: agentSessionTurns.input_messages_json,
        tool_calls_json: agentSessionTurns.tool_calls_json,
        raw_reply_text: agentSessionTurns.raw_reply_text,
        latency_ms: agentSessionTurns.latency_ms,
        model_name: agentSessionTurns.model_name,
        tokens_in: agentSessionTurns.tokens_in,
        tokens_out: agentSessionTurns.tokens_out,
        result: agentSessionTurns.result,
        error: agentSessionTurns.error,
        created_at: agentSessionTurns.created_at,
      })
      .from(agentSessionTurns)
      .where(and(...conds))
      .orderBy(desc(agentSessionTurns.created_at))
      .limit(limit);

    return c.json({ turns, limit });
  } catch (err) {
    console.error('Failed to list employee turns:', err);
    return c.json({ error: 'Failed to list employee turns', code: 'INTERNAL_ERROR' }, 500);
  }
});

// Task 8.4 — heartbeat turn feed for the agent-employee detail page.
// Distinct from /turns (which covers chat + trigger session turns) because
// heartbeat outcomes use their own vocabulary (no_op, skipped_*, error).
agentEmployeeRoutes.get('/:id/heartbeats', async (c) => {
  try {
    const user = c.get('user');
    const id = c.req.param('id');

    const [existing] = await db
      .select({ id: agentEmployees.id, org_id: agentEmployees.org_id })
      .from(agentEmployees)
      .where(eq(agentEmployees.id, id))
      .limit(1);
    if (!existing) {
      return c.json({ error: 'Agent employee not found', code: 'NOT_FOUND' }, 404);
    }
    if (existing.org_id !== user.org_id) {
      return c.json({ error: 'forbidden', code: 'FORBIDDEN' }, 403);
    }

    const limitRaw = c.req.query('limit');
    let limit = 50;
    if (limitRaw !== undefined) {
      const n = parseInt(limitRaw, 10);
      if (!Number.isFinite(n) || n <= 0) {
        return c.json({ error: 'Invalid limit', code: 'VALIDATION_ERROR' }, 400);
      }
      limit = Math.min(n, 200);
    }
    const outcome = c.req.query('outcome');

    const conds = [eq(agentHeartbeatTurns.agent_employee_id, id)];
    if (outcome) conds.push(eq(agentHeartbeatTurns.outcome, outcome));

    const turns = await db
      .select({
        id: agentHeartbeatTurns.id,
        fired_at: agentHeartbeatTurns.fired_at,
        cadence_minutes: agentHeartbeatTurns.cadence_minutes,
        prompt_sha: agentHeartbeatTurns.prompt_sha,
        action_count: agentHeartbeatTurns.action_count,
        tokens_in: agentHeartbeatTurns.tokens_in,
        tokens_out: agentHeartbeatTurns.tokens_out,
        cost_cents: agentHeartbeatTurns.cost_cents,
        outcome: agentHeartbeatTurns.outcome,
        outcome_reason: agentHeartbeatTurns.outcome_reason,
        summary: agentHeartbeatTurns.summary,
      })
      .from(agentHeartbeatTurns)
      .where(and(...conds))
      .orderBy(desc(agentHeartbeatTurns.fired_at))
      .limit(limit);

    // Cost summary — sum of cost_cents over the last 24h.
    const [costSummary] = await db
      .select({
        total_cents: sql<number>`COALESCE(SUM(${agentHeartbeatTurns.cost_cents}), 0)::int`,
        total_actions: sql<number>`COALESCE(SUM(${agentHeartbeatTurns.action_count}), 0)::int`,
        turn_count: sql<number>`COUNT(*)::int`,
      })
      .from(agentHeartbeatTurns)
      .where(
        and(
          eq(agentHeartbeatTurns.agent_employee_id, id),
          sql`${agentHeartbeatTurns.fired_at} > NOW() - INTERVAL '24 hours'`,
        ),
      );

    return c.json({
      turns,
      limit,
      cost_summary_24h: costSummary ?? { total_cents: 0, total_actions: 0, turn_count: 0 },
    });
  } catch (err) {
    console.error('Failed to list heartbeat turns:', err);
    return c.json({ error: 'Failed to list heartbeat turns', code: 'INTERNAL_ERROR' }, 500);
  }
});

// Phase 10 — receipt proxy for a specific session turn. If the turn is linked
// to an `agent_actions` row (via `triggering_message_id` or a separate join)
// and that action has an `action_receipts` row, return the receipt envelope
// plus the verified flag. This lets the drawer surface a "View receipt"
// affordance without the UI probing two endpoints.
//
// Matching strategy: `agent_session_turns` does not directly reference
// `agent_actions`, but both carry `agent_employee_id` + a common time window.
// We match the most recent receipt for that employee where the receipt's
// `created_at` is within the turn window (±5s). Narrow enough for production
// and only ever returns a receipt the caller is entitled to see.
agentEmployeeRoutes.get('/:id/turns/:turn_id/receipt', async (c) => {
  try {
    const user = c.get('user');
    const id = c.req.param('id');
    const turnId = c.req.param('turn_id');

    const [employee] = await db
      .select({ id: agentEmployees.id, org_id: agentEmployees.org_id })
      .from(agentEmployees)
      .where(eq(agentEmployees.id, id))
      .limit(1);
    if (!employee) {
      return c.json({ error: 'Agent employee not found', code: 'NOT_FOUND' }, 404);
    }
    if (employee.org_id !== user.org_id) {
      return c.json({ error: 'forbidden', code: 'FORBIDDEN' }, 403);
    }

    const [turn] = await db
      .select({
        id: agentSessionTurns.id,
        employee_id: agentSessionTurns.employee_id,
        created_at: agentSessionTurns.created_at,
      })
      .from(agentSessionTurns)
      .where(eq(agentSessionTurns.id, turnId))
      .limit(1);
    if (!turn || turn.employee_id !== id) {
      return c.json({ error: 'Turn not found', code: 'NOT_FOUND' }, 404);
    }

    // Find the most recent agent_actions row for this employee where the
    // receipt landed within a small window around the turn.
    const rows = await db.execute(sql`
      SELECT r.*
      FROM action_receipts r
      JOIN agent_actions a ON a.id = r.action_id
      WHERE a.agent_employee_id = ${id}
        AND a.org_id = ${user.org_id}
        AND r.created_at BETWEEN ${turn.created_at}::timestamp - interval '5 seconds'
                             AND ${turn.created_at}::timestamp + interval '30 seconds'
      ORDER BY r.created_at DESC
      LIMIT 1
    `);
    const row = ((rows as any).rows ?? rows)[0];
    if (!row) {
      return c.json({ error: 'No receipt for turn', code: 'NOT_FOUND' }, 404);
    }

    // Reuse the existing verify helper from Phase 7.
    const { verifyReceipt } = await import('../lib/receipts.js');
    const verified = await verifyReceipt(row as any);
    return c.json({ receipt: row, verified, action_id: row.action_id });
  } catch (err) {
    console.error('Failed to fetch turn receipt:', err);
    return c.json({ error: 'Failed to fetch turn receipt', code: 'INTERNAL_ERROR' }, 500);
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
  // native_tools dropped in Task 4.12 (skills primitive now owns per-employee
  // tool selection).
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

    // Block non-BYOA creation if self-hosted (defense in depth — wizard
    // also pre-flights this via GET /provider-readiness on step 1).
    if (!isOrgProviderReady() && !data.is_byoa) {
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
  // native_tools dropped in Task 4.12 (see createSchema note).
  mcp_connection_ids: z.array(z.string()).nullable().optional(),
  disabled_tools: z.array(z.string()).nullable().optional(),
  space_ids: z.array(z.string()).nullable().optional(),
  project_ids: z.array(z.string()).nullable().optional(),
  // trust_level is intentionally NOT part of the PUT schema — it must flow
  // through PATCH /:id which enforces owner/admin role gating. Allowing it
  // here would bypass the ConfirmDangerous gate in Settings → Agent.
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
    if (data.mcp_connection_ids !== undefined) updates.mcp_connection_ids = data.mcp_connection_ids;
    if (data.disabled_tools !== undefined) updates.disabled_tools = data.disabled_tools;
    if (data.space_ids !== undefined) updates.space_ids = data.space_ids;
    if (data.project_ids !== undefined) updates.project_ids = data.project_ids;
    // trust_level intentionally omitted here — see schema comment. Callers
    // must use PATCH /:id for trust changes (owner/admin only).
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

// ═══ PATCH (Phase 10 — targeted field updates, gated by role) ═══

const patchSchema = z.object({
  trust_level: z.enum(['conservative', 'standard', 'autonomous']).optional(),
  /**
   * Task 8.3 — per-employee heartbeat cadence override. Persisted into
   * `agent_employees.heartbeat_interval_min` so the existing SQL due-filter
   * picks it up, AND mirrored into `heartbeat_overrides.cadence_minutes`
   * so the prompt + scheduler read the same source of truth.
   * Range: 5min .. 360min. Admin-only.
   */
  heartbeat_cadence_minutes: z.number().int().min(5).max(360).optional(),
  /**
   * Task 8.5 — "mark healthy" action. When true, clears the `unhealthy`
   * flag + `unhealthy_reason`. Owner/admin only. Exposed on the same
   * endpoint because it is the same audit surface (targeted role-gated
   * flips) as trust_level.
   */
  mark_healthy: z.boolean().optional(),
  /**
   * Block 0.3 — editable identity / behavior fields for the "edit agent"
   * flow. Deft-side config only. OpenClaw-side markdown files (SOUL.md
   * etc.) edit over Gateway RPC in Block 1.
   */
  name: z.string().min(1).max(100).optional(),
  avatar_url: z.string().url().nullable().optional(),
  starter_prompts: z.array(z.string().min(1).max(500)).max(6).optional(),
  expertise_description: z.string().max(500).nullable().optional(),
  max_daily_actions: z.number().int().min(1).max(1000).optional(),
  heartbeat_enabled: z.boolean().optional(),
});

async function getOrgRole(userId: string, orgId: string): Promise<string | null> {
  const [m] = await db
    .select({ role: orgMembers.role })
    .from(orgMembers)
    .where(and(eq(orgMembers.user_id, userId), eq(orgMembers.org_id, orgId)))
    .limit(1);
  return m?.role ?? null;
}

agentEmployeeRoutes.patch('/:id', async (c) => {
  try {
    const user = c.get('user');
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: 'Invalid input', code: 'VALIDATION_ERROR', details: parsed.error.flatten() },
        400,
      );
    }

    const [existing] = await db
      .select()
      .from(agentEmployees)
      .where(and(eq(agentEmployees.id, id), eq(agentEmployees.org_id, user.org_id)))
      .limit(1);
    if (!existing) {
      return c.json({ error: 'Agent employee not found', code: 'NOT_FOUND' }, 404);
    }

    // Any destructive field flips (trust_level in Phase 10, cadence +
    // mark_healthy in Phase 8) require `owner` or `admin` on the caller's
    // org_members row.
    const needsAdmin =
      parsed.data.trust_level !== undefined ||
      parsed.data.heartbeat_cadence_minutes !== undefined ||
      parsed.data.mark_healthy === true;
    if (needsAdmin) {
      const role = await getOrgRole(user.id, user.org_id);
      if (role !== 'owner' && role !== 'admin') {
        return c.json(
          { error: 'Only owners or admins can change this field', code: 'FORBIDDEN' },
          403,
        );
      }
    }

    const updates: Record<string, any> = {};
    if (parsed.data.trust_level !== undefined) updates.trust_level = parsed.data.trust_level;

    // Task 8.3 — cadence override. Write both the top-level column (so the
    // heartbeat due-filter SQL picks it up) AND mirror into the overrides
    // blob (so the prompt builder + scheduler can find it there).
    if (parsed.data.heartbeat_cadence_minutes !== undefined) {
      updates.heartbeat_interval_min = parsed.data.heartbeat_cadence_minutes;
      const prev = (existing.heartbeat_overrides ?? {}) as Record<string, unknown>;
      updates.heartbeat_overrides = {
        ...prev,
        cadence_minutes: parsed.data.heartbeat_cadence_minutes,
      };
    }

    // Task 8.5 — "mark healthy" clears the circuit breaker. Column names
    // are optional (added in migration 0044) but drizzle's update set
    // will tolerate writing to them even when not typed, so we use sql
    // fragments to stay forward-compatible.
    if (parsed.data.mark_healthy === true) {
      // The actual column writes happen via raw SQL below so this branch
      // also lands pre-migration without a typecheck miss.
    }

    // Block 0.3 — identity + behavior fields. No role gating because
    // these are per-employee cosmetic / configuration rather than
    // destructive admin flips.
    if (parsed.data.name !== undefined) updates.name = parsed.data.name;
    if (parsed.data.avatar_url !== undefined) updates.avatar_url = parsed.data.avatar_url;
    if (parsed.data.starter_prompts !== undefined) updates.starter_prompts = parsed.data.starter_prompts;
    if (parsed.data.expertise_description !== undefined) updates.expertise_description = parsed.data.expertise_description;
    if (parsed.data.max_daily_actions !== undefined) updates.max_daily_actions = parsed.data.max_daily_actions;
    if (parsed.data.heartbeat_enabled !== undefined) updates.heartbeat_enabled = parsed.data.heartbeat_enabled;

    if (Object.keys(updates).length === 0 && !parsed.data.mark_healthy) {
      return c.json(existing);
    }

    let updated = existing;
    if (Object.keys(updates).length > 0) {
      const [row] = await db
        .update(agentEmployees)
        .set(updates)
        .where(eq(agentEmployees.id, id))
        .returning();
      if (row) updated = row;
    }

    if (parsed.data.mark_healthy === true) {
      // Idempotent — clears the unhealthy flag regardless of current state.
      await db.execute(
        sql`UPDATE agent_employees
              SET unhealthy = false,
                  unhealthy_reason = NULL
            WHERE id = ${id}`,
      );
      const [refreshed] = await db
        .select()
        .from(agentEmployees)
        .where(eq(agentEmployees.id, id))
        .limit(1);
      if (refreshed) updated = refreshed;
    }

    // Task 8.3 — kick the scheduler so the new cadence takes effect on
    // the next tick. Best-effort — if the cron is already pending this
    // is a no-op. We infer kind from the employee's `kind` column.
    if (parsed.data.heartbeat_cadence_minutes !== undefined) {
      try {
        const { rescheduleHeartbeat } = await import('../lib/job-scheduler.js');
        const kind =
          updated.kind === 'openclaw' || updated.kind === 'custom_mcp'
            ? 'openclaw'
            : 'native';
        await rescheduleHeartbeat(kind);
      } catch (err) {
        console.warn('[agent-employees] rescheduleHeartbeat failed:', err);
      }
    }

    return c.json(updated);
  } catch (err) {
    console.error('Failed to patch agent employee:', err);
    return c.json({ error: 'Failed to update', code: 'INTERNAL_ERROR' }, 500);
  }
});

// ═══ REASSIGN TRIGGER (Task 4.15) ═══
//
// When `ensureSkillInstalled` returns `requires_user_decision` because a
// skill's `agent_config.triggers` collides with a trigger already claimed by
// a different employee in the org, the frontend surfaces a prompt:
// "Alex PM currently owns cron:standup. Reassign to Riya?"
//
// On confirmation the UI calls this endpoint with `{trigger_kind, skill_id}`
// and `:id` set to the NEW employee. We:
//   1. Require the caller has owner/admin on the org.
//   2. Remove the trigger kind from every other active employee's
//      `trigger_subscriptions` array in the same org.
//   3. Install the skill on the target employee (bundled/org skills only —
//      marketplace requires the separate approval path and would have been
//      caught earlier).
//   4. Append the trigger kind to the target's `trigger_subscriptions` (via
//      the skill's agent_config.triggers — which unions at read time).
//
// The transaction keeps the array mutations + the junction insert consistent
// so we don't end up with a trigger orphaned mid-reassign.
const reassignTriggerSchema = z.object({
  trigger_kind: z.string().min(1),
  skill_id: z.string().min(1),
});

agentEmployeeRoutes.post('/:id/reassign-trigger', async (c) => {
  try {
    const user = c.get('user');
    const targetEmployeeId = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const parsed = reassignTriggerSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: 'Invalid input', code: 'VALIDATION_ERROR', details: parsed.error.flatten() },
        400,
      );
    }

    const { trigger_kind, skill_id } = parsed.data;

    // 1. Load + org-scope the target employee.
    const [target] = await db
      .select()
      .from(agentEmployees)
      .where(
        and(eq(agentEmployees.id, targetEmployeeId), eq(agentEmployees.org_id, user.org_id)),
      )
      .limit(1);
    if (!target) {
      return c.json({ error: 'Agent employee not found', code: 'NOT_FOUND' }, 404);
    }

    // 2. Admin/owner gate — reassignment rewrites another agent's claims.
    const role = await getOrgRole(user.id, user.org_id);
    if (role !== 'owner' && role !== 'admin') {
      return c.json(
        { error: 'Only owners or admins can reassign triggers', code: 'FORBIDDEN' },
        403,
      );
    }

    // 3. Load the skill being installed.
    const [skill] = await db
      .select()
      .from(skills)
      .where(eq(skills.id, skill_id))
      .limit(1);
    if (!skill) {
      return c.json({ error: 'Skill not found', code: 'NOT_FOUND' }, 404);
    }
    if (skill.source === 'marketplace') {
      return c.json(
        {
          error: 'Marketplace skills require a separate approval flow',
          code: 'MARKETPLACE_REQUIRES_APPROVAL',
        },
        400,
      );
    }

    const agentConfig = (skill.agent_config ?? {}) as SkillAgentConfig;
    const skillTriggers = agentConfig.triggers ?? [];
    if (!skillTriggers.includes(trigger_kind)) {
      return c.json(
        {
          error: `Skill does not declare trigger "${trigger_kind}"`,
          code: 'TRIGGER_NOT_IN_SKILL',
        },
        400,
      );
    }

    // 4. Reassign in a transaction: strip trigger_kind from every other
    //    active employee in this org, install skill on target, and union
    //    any remaining skill triggers into the target's inline column.
    const updatedTarget = await db.transaction(async (tx) => {
      // Strip the trigger from peers (inline column only — skill-owned
      // triggers would require uninstalling the skill, which is a separate
      // user flow).
      const peers = await tx
        .select({
          id: agentEmployees.id,
          trigger_subscriptions: agentEmployees.trigger_subscriptions,
        })
        .from(agentEmployees)
        .where(
          and(
            eq(agentEmployees.org_id, user.org_id),
            eq(agentEmployees.is_active, true),
          ),
        );

      for (const peer of peers) {
        if (peer.id === targetEmployeeId) continue;
        const claims = peer.trigger_subscriptions ?? [];
        if (!claims.includes(trigger_kind)) continue;
        const next = claims.filter((t) => t !== trigger_kind);
        await tx
          .update(agentEmployees)
          .set({ trigger_subscriptions: next.length > 0 ? next : null })
          .where(eq(agentEmployees.id, peer.id));
      }

      // Install skill on target (idempotent).
      await tx
        .insert(agentEmployeeSkills)
        .values({
          agent_employee_id: targetEmployeeId,
          skill_id: skill_id,
          installed_version: skill.version,
        })
        .onConflictDoNothing();

      // Merge skill.agent_config.triggers into the target's inline
      // `trigger_subscriptions` (set union). Read-time dedup already
      // collapses any overlap between the inline column and installed
      // skills, but writing through to the inline column keeps the
      // existing `= ANY(trigger_subscriptions)` cron dispatchers working
      // without needing them to consult skill config.
      const existingClaims = target.trigger_subscriptions ?? [];
      const mergedClaims = Array.from(
        new Set([...existingClaims, ...skillTriggers]),
      );

      // Merge capability packs too (same shape as ensureSkillInstalled).
      const existingPacks = target.capability_packs ?? [];
      const incomingPacks = agentConfig.capability_packs ?? [];
      const mergedPacks = Array.from(
        new Set([...existingPacks, ...incomingPacks]),
      );

      const [updated] = await tx
        .update(agentEmployees)
        .set({
          trigger_subscriptions: mergedClaims,
          capability_packs: mergedPacks.length > 0 ? mergedPacks : null,
        })
        .where(eq(agentEmployees.id, targetEmployeeId))
        .returning();

      return updated!;
    });

    return c.json({
      employee: updatedTarget,
      reassigned_trigger: trigger_kind,
      skill_id,
    });
  } catch (err) {
    console.error('Failed to reassign trigger:', err);
    return c.json({ error: 'Failed to reassign trigger', code: 'INTERNAL_ERROR' }, 500);
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

    // Phase 10 — Settings page gates this behind ConfirmDangerous (user
    // types the slug). owner/admin only on the destructive path.
    const role = await getOrgRole(user.id, user.org_id);
    if (role !== 'owner' && role !== 'admin') {
      return c.json(
        { error: 'Only owners or admins can delete an employee', code: 'FORBIDDEN' },
        403,
      );
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

    // Phase 10 — tear down any managed provider_instances rows via the
    // DeploymentProvider registry. Best-effort — a failing destroy should
    // not leave the employee undeletable from the UI.
    try {
      const instances = await db.execute(sql`
        SELECT id, org_id, provider, integration_id, external_instance_id,
               external_project_id, external_environment_id, provider_metadata
        FROM provider_instances
        WHERE employee_id = ${id} AND status <> 'destroyed'
      `);
      const rows = ((instances as any).rows ?? instances) as any[];
      if (rows.length > 0) {
        const { getProvider } = await import('../lib/deployment/index.js');
        for (const row of rows) {
          try {
            const provider = getProvider(row.provider);
            await provider.destroy({
              id: row.id,
              org_id: row.org_id,
              provider: row.provider,
              integration_id: row.integration_id,
              external_instance_id: row.external_instance_id,
              external_project_id: row.external_project_id,
              external_environment_id: row.external_environment_id,
              provider_metadata: row.provider_metadata,
            });
            await db.execute(sql`
              UPDATE provider_instances SET status = 'destroyed' WHERE id = ${row.id}
            `);
          } catch (destroyErr) {
            console.warn(
              '[delete-employee] provider.destroy failed for instance',
              row.id,
              destroyErr,
            );
          }
        }
      }
    } catch (provErr) {
      console.warn('[delete-employee] provider_instances cleanup skipped:', provErr);
    }

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

// ═══ RETRY PROVISIONING (Task 4.13) ═══
//
// JIT skill installs (Task 4.6) can leave an openclaw employee in
// `connection_status='pending'` if the deploy-provision worker fails to
// push the new capability packs through to the sidecar. This endpoint
// re-enqueues that provision job in `update` mode so the caller can
// retry without touching the employee row itself.
agentEmployeeRoutes.post('/:id/retry-provision', async (c) => {
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

    if (employee.connection_status !== 'pending') {
      return c.json(
        {
          error: 'Retry only allowed while connection_status=pending',
          code: 'INVALID_STATE',
          current_status: employee.connection_status,
        },
        409,
      );
    }

    const { enqueue } = await import('../lib/queues.js');
    await enqueue('agent-jobs', 'deploy-provision', {
      employee_id: id,
      mode: 'update',
    });

    return c.json({ success: true, enqueued: true });
  } catch (err) {
    console.error('Failed to retry provision:', err);
    return c.json({ error: 'Failed to retry provision', code: 'INTERNAL_ERROR' }, 500);
  }
});
