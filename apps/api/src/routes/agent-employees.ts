import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { eq, and, desc, sql, or, isNull, asc, gte, lt, inArray, notInArray } from 'drizzle-orm';
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
  agentEmployeeTemplates,
  agentCertificationChallenges,
  agentMcpCallAudit,
  agentCooperativeLog,
  agentChannelConnections,
  agentChannelDeliveryAttempts,
  agentChannelEvents,
  agentChannelTokens,
  projects,
  mcpConnections,
  moduleInstallations,
  wikiMemorySyncs,
  wikiPages,
} from '@deft/db/schema';
import type { SkillAgentConfig } from '../lib/skill-config.js';
import {
  AGENT_CHANNEL_PROTOCOL_VERSION,
  AGENT_CHANNEL_CAPABILITIES,
  AGENT_CHANNEL_AUTONOMOUS_REQUIRED_RUNTIME_CAPABILITIES,
  DEFT_RELEASE_VERSION,
  issueAgentChannelToken,
  publishAgentChannelEvent,
} from '../lib/agent-channel.js';
import { markWorkIntentsExpiredForActions } from '../lib/work-intents.js';
import { terminalizePendingModuleActions } from '../lib/module-action-terminalization.js';
import { MODULE_WRITE_ACTION_NAMES } from '../lib/module-action-visibility.js';
import { summarizeAgentChannelLifecycle, summarizeAgentChannelMetrics } from '../lib/agent-channel-lifecycle.js';
import { loadAgentActivity } from '../lib/agent-activity.js';
import { describeAgentRuntimeRecovery } from '../lib/agent-runtime-recovery.js';
import { ensureAgentConversationSpace } from '../lib/ensure-agent-conversation-space.js';
import { evaluateAgentOnboardingPreflight } from '../lib/agent-onboarding-preflight.js';
import { generateReceipt } from '../lib/receipts.js';
import { invalidatePlatformContextCacheFor } from '../lib/mcp-tools/context.js';
import {
  isReservedDeftyEmployeeSlug,
  isReservedDeftyRuntimeKind,
} from '../lib/defty-identity.js';

export const agentEmployeeRoutes = new Hono();

// ═══ TEMPLATES ═══

// GET /templates — pre-built role templates read from DB.
// The old in-memory ROLE_TEMPLATES array and DEFT_SELF_HOSTED guard are
// removed; the DB is the single source of truth for both cloud and
// self-hosted deployments.
agentEmployeeRoutes.get('/templates', async (c) => {
  const user = c.get('user');

  const rows = await db
    .select()
    .from(agentEmployeeTemplates)
    .where(
      or(
        eq(agentEmployeeTemplates.org_id, user.org_id),
        isNull(agentEmployeeTemplates.org_id),
      ),
    )
    .orderBy(asc(agentEmployeeTemplates.source), asc(agentEmployeeTemplates.name));

  const mapped = rows.map((t) => ({
    role: t.role,
    name: t.name,
    system_prompt: t.soul_md,
    expertise_description: t.description,
    heartbeat_config: null as string | null,
  }));

  return c.json(mapped);
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
      .where(
        and(
          eq(agentEmployees.org_id, user.org_id),
          eq(agentEmployees.is_deleted, false),
        ),
      )
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

    const channelRows = await db
      .select({
        employee_id: agentChannelConnections.agent_employee_id,
        status: agentChannelConnections.status,
        last_seen_at: agentChannelConnections.last_seen_at,
        last_error: agentChannelConnections.last_error,
      })
      .from(agentChannelConnections)
      .where(eq(agentChannelConnections.org_id, user.org_id));
    const channelMap = new Map(channelRows.map((row) => [row.employee_id, row]));

    const skillStats = await db.execute(sql`
      SELECT
        aes.agent_employee_id AS employee_id,
        COUNT(*)::int AS installed_skill_count,
        BOOL_OR(s.slug = 'deft-workspace' AND s.is_deleted = false) AS has_workspace_skill
      FROM agent_employee_skills aes
      INNER JOIN skills s ON s.id = aes.skill_id
      INNER JOIN agent_employees ae ON ae.id = aes.agent_employee_id
      WHERE ae.org_id = ${user.org_id}
        AND ae.is_deleted = false
      GROUP BY aes.agent_employee_id
    `);
    const skillMap = new Map<string, { count: number; hasWorkspaceSkill: boolean }>();
    for (const row of ((skillStats as any).rows ?? skillStats) as any[]) {
      if (!row.employee_id) continue;
      skillMap.set(row.employee_id, {
        count: Number(row.installed_skill_count ?? 0),
        hasWorkspaceSkill: row.has_workspace_skill === true,
      });
    }

    const enriched = employees.map((emp) => {
      const turn = turnMap.get(emp.id);
      const channel = channelMap.get(emp.id);
      const skill = skillMap.get(emp.id);
      return {
        ...emp,
        pending_action_count: pendingMap.get(emp.id) ?? 0,
        recent_turn_count_24h: turn?.cnt_24h ?? 0,
        last_turn_at: turn?.last_turn_at ?? lastTurnMap.get(emp.id) ?? null,
        avg_latency_ms_24h: turn?.avg_latency ?? null,
        channel_status: channel?.status ?? null,
        channel_last_seen_at: channel?.last_seen_at ?? null,
        channel_last_error: channel?.last_error ?? null,
        installed_skill_count: skill?.count ?? 0,
        required_workspace_skill_installed: skill?.hasWorkspaceSkill ?? false,
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

const AGENT_EMPLOYEE_ROLES = [
  'project_manager',
  'engineering_lead',
  'executive_assistant',
  'product_designer',
  'qa_engineer',
  'customer_success',
  'community_manager',
  'cfo',
  'custom',
] as const;

const externalRuntimeKindSchema = z.string().trim().min(1).max(64).refine(
  (runtimeKind) => !isReservedDeftyRuntimeKind(runtimeKind),
  { message: 'defty_system is reserved for Deft internal use' },
);

const createSchema = z.object({
  name: z.string().min(1).max(100).refine(
    (name) => !isReservedDeftyEmployeeSlug(baseSlugForName(name)),
    { message: 'defty-system is reserved for Deft internal use' },
  ),
  role: z.enum(AGENT_EMPLOYEE_ROLES),
  runtime_kind: externalRuntimeKindSchema.optional(),
  job_title: z.string().min(1).max(120).optional(),
  wake_mode: z.enum(['manual', 'polling', 'webhook', 'external_chat']).default('manual'),
  system_prompt: z.string().min(1),
  expertise_description: z.string().optional(),
  connection_notes: z.string().max(2000).optional(),
  avatar_url: z.string().url().optional(),
  // native_tools dropped in Task 4.12 (skills primitive now owns per-employee
  // tool selection).
  mcp_connection_ids: z.array(z.string()).nullable().optional(),
  disabled_tools: z.array(z.string()).nullable().optional(),
  space_ids: z.array(z.string()).nullable().optional(),
  project_ids: z.array(z.string()).nullable().optional(),
  trust_level: z.enum(['conservative', 'standard', 'autonomous']).default('conservative'),
  max_daily_actions: z.number().int().positive().default(50),
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

function baseSlugForName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'agent';
}

async function uniqueEmployeeSlug(orgId: string, name: string): Promise<string> {
  const base = baseSlugForName(name);
  let candidate = isReservedDeftyEmployeeSlug(base) ? `${base}-2` : base;
  let attempt = candidate === base ? 1 : 2;

  while (attempt < 100) {
    const [exists] = await db
      .select({ id: agentEmployees.id })
      .from(agentEmployees)
      .where(and(eq(agentEmployees.org_id, orgId), eq(agentEmployees.slug, candidate)))
      .limit(1);
    if (!exists) return candidate;
    attempt += 1;
    candidate = `${base}-${attempt}`;
  }

  return `${base}-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

function mcpEndpointUrl(): string {
  const apiBase =
    process.env.PUBLIC_API_BASE_URL ??
    process.env.NEXT_PUBLIC_API_URL ??
    process.env.API_BASE_URL ??
    'http://localhost:3001';
  return `${apiBase.replace(/\/$/, '')}/api/mcp/v1`;
}

function hermesMcpEndpointUrl(): string {
  const apiBase =
    process.env.PUBLIC_API_BASE_URL ??
    process.env.NEXT_PUBLIC_API_URL ??
    process.env.API_BASE_URL ??
    'http://localhost:3001';
  return `${apiBase.replace(/\/$/, '')}/api/mcp/hermes/v1`;
}

function agentChannelEndpointUrl(): string {
  const apiBase =
    process.env.PUBLIC_API_BASE_URL ??
    process.env.NEXT_PUBLIC_API_URL ??
    process.env.API_BASE_URL ??
    'http://localhost:3001';
  return `${apiBase.replace(/\/$/, '')}/api/agent-channel/v1`;
}

function hermesIntegrationBundleUrl(): string {
  return process.env.DEFT_HERMES_BUNDLE_URL?.trim()
    || `https://github.com/Maneek21/Deft/releases/download/v${DEFT_RELEASE_VERSION}/deft-hermes-integration-${DEFT_RELEASE_VERSION}.tar.gz`;
}

export const HERMES_INTEGRATION_VERSION = '0.5.0';

const CERTIFICATION_REQUIRED_TOOLS = [
  'platform_context',
  'task_query',
  'module_list',
  'ping_alive',
  'memory_write',
  'memory_recall',
  'record_conversation_turn',
  'record_decision',
] as const;

type RuntimeSetupCommand = {
  label: string;
  command: string;
  description: string;
};

type RuntimeSetup = {
  runtime_kind: string;
  tool_server_name: string | null;
  channel_protocol_version: string;
  channel_capabilities: string[];
  integration_version: string | null;
  integration_bundle_url: string | null;
  mcp_endpoint_url: string;
  channel_endpoint_url: string;
  tool_name_style: 'bare' | 'server_prefixed';
  tool_call_names: string[];
  setup_steps: string[];
  commands: RuntimeSetupCommand[];
  config_snippet: string | null;
  bridge_script: string | null;
  certification_prompt: string;
  troubleshooting: string[];
};

type CertificationStage = {
  key: string;
  label: string;
  status: 'pass' | 'pending';
  detail: string;
};

type CertificationChallengeEvidence = {
  seenTools: Set<string>;
  missingTools: string[];
  nonceSeen: boolean;
  auditCount: number;
  privateMemoryVerified: boolean;
  channelEventSeen: boolean;
  channelCompleted: boolean;
  channelReplyNonceSeen: boolean;
  singleDelivery: boolean;
  singleReply: boolean;
  runtimeSessionSeen: boolean;
  runtimeExecutionSeen: boolean;
  runtimeExecutionProof: CertificationExecutionProof;
  baseCompleted: boolean;
  restartDetected: boolean;
  restartProofEventSeen: boolean;
  restartProofPingSeen: boolean;
  restartProofNonceSeen: boolean;
  restartProofReplyNonceSeen: boolean;
  restartProofSingleReply: boolean;
  restartExecutionProof: CertificationExecutionProof;
  restartProofCompleted: boolean;
  completed: boolean;
};

type CertificationExecutionProof = 'supervised_terminal' | 'autonomous_source_reply' | null;

type CertificationReplyAttempt = {
  request_json: unknown;
  response_json: unknown;
  created_at: Date;
  updated_at: Date;
};

function certificationReplyContainsNonce(attempt: CertificationReplyAttempt, nonce: string): boolean {
  const response = attempt.response_json && typeof attempt.response_json === 'object'
    ? attempt.response_json as Record<string, unknown>
    : {};
  return typeof response.content === 'string'
    && response.content.toLocaleLowerCase().includes(nonce.toLocaleLowerCase());
}

function certificationReplyCommittedAt(attempt: CertificationReplyAttempt): Date | null {
  const response = attempt.response_json && typeof attempt.response_json === 'object'
    ? attempt.response_json as Record<string, unknown>
    : {};
  if (typeof response.created_at !== 'string') return null;
  const committedAt = new Date(response.created_at);
  return Number.isNaN(committedAt.getTime()) ? null : committedAt;
}

function certificationExecutionProof(
  event: {
    status: string;
    delivery_count: number;
    delivered_at: Date | null;
    acked_at: Date | null;
    completed_at: Date | null;
    claim_token: string | null;
    claim_owner: string | null;
    lease_expires_at: Date | null;
    runtime_session_key: string | null;
    work_outcome: string | null;
  } | null | undefined,
  replyAttempts: CertificationReplyAttempt[],
): CertificationExecutionProof {
  if (!event || event.delivery_count !== 1 || replyAttempts.length !== 1) return null;
  const replyCommittedAt = certificationReplyCommittedAt(replyAttempts[0]!);
  if (!replyCommittedAt) return null;
  const request = replyAttempts[0]?.request_json && typeof replyAttempts[0].request_json === 'object'
    ? replyAttempts[0].request_json as Record<string, unknown>
    : {};
  if (
    request.adapter_mode === 'supervised_runtime'
    && Boolean(event.delivered_at)
    && replyCommittedAt.getTime() >= event.delivered_at!.getTime()
    && event.status === 'completed'
    && event.work_outcome === 'completed'
    && Boolean(event.completed_at)
    && Boolean(event.runtime_session_key?.trim())
  ) return 'supervised_terminal';
  if (
    request.adapter_mode === 'autonomous_platform'
    && (
      (event.status === 'acknowledged' && !event.completed_at)
      || (event.status === 'completed' && Boolean(event.completed_at))
    )
    && Boolean(event.acked_at)
    && replyCommittedAt.getTime() >= event.acked_at!.getTime()
    && !event.work_outcome
    && !event.claim_token
    && !event.claim_owner
    && !event.lease_expires_at
  ) return 'autonomous_source_reply';
  return null;
}

function runtimeKindOf(employee: { runtime_kind?: string | null }): string {
  return employee.runtime_kind || 'custom_mcp';
}

function runtimeToolName(runtimeKind: string, tool: string): string {
  return runtimeKind === 'hermes' ? `mcp_deft_${tool}` : tool;
}

async function loadCertificationChallengeEvidence(params: {
  orgId: string;
  employeeId: string;
  runtimeKind?: string | null;
  challenge: {
    id: string;
    nonce: string;
    required_tools: string[];
    status: string;
    started_at: Date;
  };
}): Promise<CertificationChallengeEvidence> {
  const { orgId, employeeId, challenge } = params;
  const requiresRestartProof = params.runtimeKind === 'hermes';
  const [channelEvent] = await db
    .select({
      id: agentChannelEvents.id,
      status: agentChannelEvents.status,
      delivery_count: agentChannelEvents.delivery_count,
      created_at: agentChannelEvents.created_at,
      delivered_at: agentChannelEvents.delivered_at,
      acked_at: agentChannelEvents.acked_at,
      completed_at: agentChannelEvents.completed_at,
      claim_token: agentChannelEvents.claim_token,
      claim_owner: agentChannelEvents.claim_owner,
      lease_expires_at: agentChannelEvents.lease_expires_at,
      runtime_session_key: agentChannelEvents.runtime_session_key,
      work_outcome: agentChannelEvents.work_outcome,
      payload: agentChannelEvents.payload,
    })
    .from(agentChannelEvents)
    .where(and(
      eq(agentChannelEvents.org_id, orgId),
      eq(agentChannelEvents.agent_employee_id, employeeId),
      eq(agentChannelEvents.kind, 'certification.challenge'),
      eq(agentChannelEvents.source_kind, 'certification'),
      eq(agentChannelEvents.source_id, challenge.id),
      gte(agentChannelEvents.created_at, challenge.started_at),
    ))
    .orderBy(desc(agentChannelEvents.created_at))
    .limit(1);
  const replyRows = channelEvent
    ? await db
        .select({
          id: agentChannelDeliveryAttempts.id,
          request_json: agentChannelDeliveryAttempts.request_json,
          response_json: agentChannelDeliveryAttempts.response_json,
          created_at: agentChannelDeliveryAttempts.created_at,
          updated_at: agentChannelDeliveryAttempts.updated_at,
        })
        .from(agentChannelDeliveryAttempts)
        .where(and(
          eq(agentChannelDeliveryAttempts.org_id, orgId),
          eq(agentChannelDeliveryAttempts.agent_employee_id, employeeId),
          eq(agentChannelDeliveryAttempts.event_id, channelEvent.id),
          eq(agentChannelDeliveryAttempts.direction, 'inbound_reply'),
          eq(agentChannelDeliveryAttempts.status, 'completed'),
        ))
        .orderBy(asc(agentChannelDeliveryAttempts.created_at))
        .limit(2)
    : [];
  const singleReply = replyRows.length === 1;
  const channelReplyCommittedAt = singleReply
    ? certificationReplyCommittedAt(replyRows[0]!)
    : null;
  const channelReplyNonceSeen = singleReply
    && Boolean(channelReplyCommittedAt)
    && certificationReplyContainsNonce(replyRows[0]!, challenge.nonce);
  const evidenceStartedAt = channelEvent?.status === 'acknowledged' && channelEvent.acked_at
    ? channelEvent.acked_at
    : channelEvent?.delivered_at ?? challenge.started_at;
  const evidenceCompletedAt = channelReplyNonceSeen ? channelReplyCommittedAt : null;

  // Evidence must occur after the assignment reaches the runtime and, once a
  // qualifying reply exists, before that reply. This prevents old or later
  // unrelated MCP traffic from retroactively satisfying a certification turn.
  const auditRows = await db
    .select({
      tool_name: agentMcpCallAudit.tool_name,
      call_count: sql<number>`COUNT(*)::int`,
    })
    .from(agentMcpCallAudit)
    .where(and(
      eq(agentMcpCallAudit.org_id, orgId),
      eq(agentMcpCallAudit.employee_id, employeeId),
      eq(agentMcpCallAudit.success, true),
      gte(agentMcpCallAudit.created_at, evidenceStartedAt),
      evidenceCompletedAt ? lt(agentMcpCallAudit.created_at, evidenceCompletedAt) : undefined,
    ))
    .groupBy(agentMcpCallAudit.tool_name);
  const seenTools = new Set(auditRows.map((row) => row.tool_name));
  const memoryWriteCallCount = Number(
    auditRows.find((row) => row.tool_name === 'memory_write')?.call_count ?? 0,
  );
  const nonceRows = await db
    .select({ id: agentCooperativeLog.id })
    .from(agentCooperativeLog)
    .where(and(
      eq(agentCooperativeLog.org_id, orgId),
      eq(agentCooperativeLog.employee_id, employeeId),
      gte(agentCooperativeLog.created_at, evidenceStartedAt),
      evidenceCompletedAt ? lt(agentCooperativeLog.created_at, evidenceCompletedAt) : undefined,
      or(
        sql`${agentCooperativeLog.summary} ILIKE ${`%${challenge.nonce}%`}`,
        sql`COALESCE(${agentCooperativeLog.metadata}::text, '') ILIKE ${`%${challenge.nonce}%`}`,
      ),
    ))
    .limit(1);
  const missingTools = challenge.required_tools.filter((tool) => !seenTools.has(tool));
  const nonceSeen = nonceRows.length > 0;
  const privateMemoryRows = await db
    .select({ page_id: wikiPages.id })
    .from(wikiMemorySyncs)
    .innerJoin(wikiPages, and(
      eq(wikiPages.id, wikiMemorySyncs.page_id),
      eq(wikiPages.org_id, wikiMemorySyncs.org_id),
    ))
    .where(and(
      eq(wikiMemorySyncs.org_id, orgId),
      eq(wikiMemorySyncs.agent_employee_id, employeeId),
      eq(wikiMemorySyncs.idempotency_key, `certification:${challenge.nonce}`),
      eq(wikiPages.scope, 'user'),
      eq(wikiPages.agent_employee_id, employeeId),
      eq(wikiPages.is_deleted, false),
      or(
        sql`${wikiPages.title} ILIKE ${`%${challenge.nonce}%`}`,
        sql`${wikiPages.content} ILIKE ${`%${challenge.nonce}%`}`,
      ),
    ))
    .limit(1);
  const replayAuditRows = privateMemoryRows.length === 0 ? [] : await db
    .select({ id: agentMcpCallAudit.id })
    .from(agentMcpCallAudit)
    .where(and(
      eq(agentMcpCallAudit.org_id, orgId),
      eq(agentMcpCallAudit.employee_id, employeeId),
      eq(agentMcpCallAudit.tool_name, 'memory_write'),
      eq(agentMcpCallAudit.success, true),
      gte(agentMcpCallAudit.created_at, evidenceStartedAt),
      evidenceCompletedAt ? lt(agentMcpCallAudit.created_at, evidenceCompletedAt) : undefined,
      sql`COALESCE(${agentMcpCallAudit.metadata}->>'memory_replayed', 'false') = 'true'`,
      sql`${agentMcpCallAudit.metadata}->>'memory_page_id' = ${privateMemoryRows[0]?.page_id ?? ''}`,
    ))
    .limit(1);
  const privateMemoryVerified = memoryWriteCallCount >= 2
    && seenTools.has('memory_recall')
    && privateMemoryRows.length > 0
    && replayAuditRows.length > 0;

  const channelEventSeen = Boolean(channelEvent);
  const channelCompleted = (
    channelEvent?.status === 'completed'
    && channelEvent.work_outcome === 'completed'
  );
  const singleDelivery = channelEvent?.delivery_count === 1;
  const runtimeSessionSeen = Boolean(channelEvent?.runtime_session_key?.trim());
  const runtimeExecutionProof = certificationExecutionProof(channelEvent, replyRows);
  const runtimeExecutionSeen = runtimeExecutionProof !== null;
  const baseCompleted = (
    missingTools.length === 0
    && nonceSeen
    && privateMemoryVerified
    && channelEventSeen
    && channelReplyNonceSeen
    && singleDelivery
    && singleReply
    && runtimeExecutionSeen
  );
  const eventPayload = channelEvent?.payload && typeof channelEvent.payload === 'object'
    ? channelEvent.payload as Record<string, unknown>
    : {};
  const baselineRestartCount = Number(eventPayload.baseline_restart_count ?? 0);
  const [connection] = await db.select({ metadata: agentChannelConnections.metadata })
    .from(agentChannelConnections)
    .where(and(
      eq(agentChannelConnections.org_id, orgId),
      eq(agentChannelConnections.agent_employee_id, employeeId),
    )).limit(1);
  const connectionMetadata = (connection?.metadata ?? {}) as Record<string, unknown>;
  const currentRestartCount = Number(connectionMetadata.restart_count ?? 0);
  const lastRestartAt = typeof connectionMetadata.last_restart_at === 'string'
    ? new Date(connectionMetadata.last_restart_at)
    : null;
  const restartDetected = !requiresRestartProof || Boolean(
    evidenceCompletedAt
      && currentRestartCount > baselineRestartCount
      && lastRestartAt
      && !Number.isNaN(lastRestartAt.getTime())
      && lastRestartAt.getTime() >= evidenceCompletedAt.getTime()
  );
  const [restartProofEvent] = await db.select({
    id: agentChannelEvents.id,
    status: agentChannelEvents.status,
    delivery_count: agentChannelEvents.delivery_count,
    created_at: agentChannelEvents.created_at,
    delivered_at: agentChannelEvents.delivered_at,
    acked_at: agentChannelEvents.acked_at,
    completed_at: agentChannelEvents.completed_at,
    claim_token: agentChannelEvents.claim_token,
    claim_owner: agentChannelEvents.claim_owner,
    lease_expires_at: agentChannelEvents.lease_expires_at,
    runtime_session_key: agentChannelEvents.runtime_session_key,
    work_outcome: agentChannelEvents.work_outcome,
  }).from(agentChannelEvents).where(and(
    eq(agentChannelEvents.org_id, orgId),
    eq(agentChannelEvents.agent_employee_id, employeeId),
    eq(agentChannelEvents.kind, 'certification.restart_proof'),
    eq(agentChannelEvents.source_kind, 'certification'),
    eq(agentChannelEvents.source_id, challenge.id),
    gte(agentChannelEvents.created_at, challenge.started_at),
  )).orderBy(desc(agentChannelEvents.created_at)).limit(1);
  const restartProofReplies = restartProofEvent ? await db.select({
    id: agentChannelDeliveryAttempts.id,
    request_json: agentChannelDeliveryAttempts.request_json,
    response_json: agentChannelDeliveryAttempts.response_json,
    created_at: agentChannelDeliveryAttempts.created_at,
    updated_at: agentChannelDeliveryAttempts.updated_at,
  })
    .from(agentChannelDeliveryAttempts).where(and(
      eq(agentChannelDeliveryAttempts.org_id, orgId),
      eq(agentChannelDeliveryAttempts.agent_employee_id, employeeId),
      eq(agentChannelDeliveryAttempts.event_id, restartProofEvent.id),
      eq(agentChannelDeliveryAttempts.direction, 'inbound_reply'),
      eq(agentChannelDeliveryAttempts.status, 'completed'),
    ))
    .orderBy(asc(agentChannelDeliveryAttempts.created_at))
    .limit(2) : [];
  const restartProofSingleReply = !requiresRestartProof || restartProofReplies.length === 1;
  const restartProofReplyCommittedAt = requiresRestartProof && restartProofSingleReply
    ? certificationReplyCommittedAt(restartProofReplies[0]!)
    : null;
  const restartProofReplyNonceSeen = !requiresRestartProof || (
    restartProofSingleReply
    && Boolean(restartProofReplyCommittedAt)
    && certificationReplyContainsNonce(restartProofReplies[0]!, challenge.nonce)
  );
  const restartProofReplyAt = requiresRestartProof && restartProofReplyNonceSeen
    ? restartProofReplyCommittedAt
    : null;
  const restartProofPingRows = !requiresRestartProof
    ? []
    : restartProofEvent?.acked_at && restartProofReplyAt
      ? await db.select({ id: agentMcpCallAudit.id })
        .from(agentMcpCallAudit)
        .where(and(
          eq(agentMcpCallAudit.org_id, orgId),
          eq(agentMcpCallAudit.employee_id, employeeId),
          eq(agentMcpCallAudit.tool_name, 'ping_alive'),
          eq(agentMcpCallAudit.success, true),
          gte(agentMcpCallAudit.created_at, restartProofEvent.acked_at),
          lt(agentMcpCallAudit.created_at, restartProofReplyAt),
        ))
        .limit(1)
      : [];
  const restartProofNonceRows = !requiresRestartProof
    ? []
    : restartProofEvent?.acked_at && restartProofReplyAt
      ? await db.select({ id: agentCooperativeLog.id })
        .from(agentCooperativeLog)
        .where(and(
          eq(agentCooperativeLog.org_id, orgId),
          eq(agentCooperativeLog.employee_id, employeeId),
          eq(agentCooperativeLog.kind, 'decision'),
          gte(agentCooperativeLog.created_at, restartProofEvent.acked_at),
          lt(agentCooperativeLog.created_at, restartProofReplyAt),
          or(
            sql`${agentCooperativeLog.summary} ILIKE ${`%${challenge.nonce}%`}`,
            sql`COALESCE(${agentCooperativeLog.metadata}::text, '') ILIKE ${`%${challenge.nonce}%`}`,
          ),
        ))
        .limit(1)
      : [];
  const restartProofEventSeen = !requiresRestartProof || Boolean(restartProofEvent);
  const restartProofPingSeen = !requiresRestartProof || restartProofPingRows.length > 0;
  const restartProofNonceSeen = !requiresRestartProof || restartProofNonceRows.length > 0;
  const restartExecutionProof = !requiresRestartProof
    ? null
    : certificationExecutionProof(restartProofEvent, restartProofReplies);
  const restartProofCompleted = !requiresRestartProof || (
    restartExecutionProof !== null
    && restartProofPingSeen
    && restartProofNonceSeen
    && restartProofReplyNonceSeen
    && restartProofSingleReply
  );
  const completed = baseCompleted && restartDetected && restartProofCompleted;

  return {
    seenTools,
    missingTools,
    nonceSeen,
    auditCount: auditRows.length,
    privateMemoryVerified,
    channelEventSeen,
    channelCompleted,
    channelReplyNonceSeen,
    singleDelivery,
    singleReply,
    runtimeSessionSeen,
    runtimeExecutionSeen,
    runtimeExecutionProof,
    baseCompleted,
    restartDetected,
    restartProofEventSeen,
    restartProofPingSeen,
    restartProofNonceSeen,
    restartProofReplyNonceSeen,
    restartProofSingleReply,
    restartExecutionProof,
    restartProofCompleted,
    completed,
  };
}

function hermesLegacyMcpBridgeScript(): string {
  return `#!/usr/bin/env node
// LEGACY ROLLBACK ONLY. Disable deft-platform before using this stdio shim;
// never run the native and legacy Deft adapters for one employee at the same time.
import { stdin, stdout } from 'node:process';

const endpoint = process.env.DEFT_MCP_URL;
const token = process.env.DEFT_MCP_TOKEN;

if (!endpoint || !token) {
  console.error('DEFT_MCP_URL and DEFT_MCP_TOKEN are required.');
  process.exit(1);
}

let buffer = Buffer.alloc(0);
let replyMode = 'content-length';

stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  drain();
});

function drain() {
  while (buffer.length > 0) {
    const text = buffer.toString('utf8');
    const headerEnd = text.indexOf('\\r\\n\\r\\n');
    if (headerEnd !== -1) {
      const header = text.slice(0, headerEnd);
      const match = header.match(/Content-Length:\\s*(\\d+)/i);
      if (!match) {
        buffer = buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const start = Buffer.byteLength(text.slice(0, headerEnd + 4));
      if (buffer.length < start + length) return;
      replyMode = 'content-length';
      handleEnvelope(buffer.subarray(start, start + length).toString('utf8'));
      buffer = buffer.subarray(start + length);
      continue;
    }

    const newline = text.indexOf('\\n');
    if (newline === -1) return;
    const line = text.slice(0, newline).trim();
    buffer = buffer.subarray(Buffer.byteLength(text.slice(0, newline + 1)));
    if (line) {
      replyMode = 'line';
      handleEnvelope(line);
    }
  }
}

async function handleEnvelope(raw) {
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return;
  }

  const isNotification = envelope.id === undefined || envelope.id === null;
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: \`Bearer \${token}\`,
      },
      body: JSON.stringify(envelope),
    });
    const text = await res.text();
    if (isNotification) {
      return;
    }
    if (!text.trim()) {
      writeEnvelope({
        jsonrpc: '2.0',
        id: envelope.id,
        error: { code: -32000, message: \`Deft MCP returned HTTP \${res.status} with an empty body\` },
      });
      return;
    }
    writeEnvelope(JSON.parse(text));
  } catch (err) {
    if (isNotification) {
      return;
    }
    writeEnvelope({
      jsonrpc: '2.0',
      id: envelope.id,
      error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
    });
  }
}

function writeEnvelope(payload) {
  const body = JSON.stringify(payload);
  if (replyMode === 'line') {
    stdout.write(\`\${body}\\n\`);
    return;
  }
  stdout.write(\`Content-Length: \${Buffer.byteLength(body, 'utf8')}\\r\\n\\r\\n\${body}\`);
}
`;
}

function buildCertificationPrompt(
  employee: { name: string; slug: string; runtime_kind?: string | null },
  nonce: string,
): string {
  const runtimeKind = runtimeKindOf(employee);
  const toolNames = CERTIFICATION_REQUIRED_TOOLS.map((tool) => runtimeToolName(runtimeKind, tool));
  const prefixNote = runtimeKind === 'hermes'
    ? 'Hermes exposes Deft MCP tools to the model as mcp_deft_<tool>, so use the exact names below.'
    : 'Use the Deft MCP tools below.';

  return [
    `You are ${employee.name}, a BYOA employee in Deft.`,
    prefixNote,
    `Use caller_employee_slug exactly as "${employee.slug}" on every Deft MCP tool call.`,
    `Call these tools now: ${toolNames.join(', ')}.`,
    `When ${runtimeToolName(runtimeKind, 'task_query')} returns a task, confirm it includes allowed_next_statuses; do not mutate the task.`,
    `When ${runtimeToolName(runtimeKind, 'module_list')} returns an enabled module, call ${runtimeToolName(runtimeKind, 'module_schema_get')} for it and inspect the exact create/update input schemas and collection examples; do not create or update a record. An empty module list is valid.`,
    `Use ${runtimeToolName(runtimeKind, 'memory_write')} to save a private certification memory whose title and body contain ${nonce}; use idempotency_key "certification:${nonce}".`,
    `Repeat the identical ${runtimeToolName(runtimeKind, 'memory_write')} call with the same idempotency key and confirm replayed is true.`,
    `Then call ${runtimeToolName(runtimeKind, 'memory_recall')} with query "${nonce}" and confirm the returned page has authority "deft_canonical".`,
    `Include this exact certification nonce in record_conversation_turn and record_decision: ${nonce}.`,
    `Your final reply must contain this exact nonce: ${nonce}.`,
    'Finish with a short natural-language summary. Do not prefix every future message with your own name.',
  ].join('\n');
}

export function buildRuntimeSetup(
  employee: { name: string; slug: string; runtime_kind?: string | null },
  nonce: string | null,
): RuntimeSetup {
  const runtimeKind = runtimeKindOf(employee);
  const endpoint = runtimeKind === 'hermes' ? hermesMcpEndpointUrl() : mcpEndpointUrl();
  const channelEndpoint = agentChannelEndpointUrl();
  const certificationPrompt = buildCertificationPrompt(employee, nonce ?? '<challenge-nonce>');

  if (runtimeKind === 'hermes') {
    return {
      runtime_kind: runtimeKind,
      tool_server_name: 'deft',
      channel_protocol_version: AGENT_CHANNEL_PROTOCOL_VERSION,
      channel_capabilities: [...AGENT_CHANNEL_CAPABILITIES],
      integration_version: HERMES_INTEGRATION_VERSION,
      integration_bundle_url: hermesIntegrationBundleUrl(),
      mcp_endpoint_url: endpoint,
      channel_endpoint_url: channelEndpoint,
      tool_name_style: 'server_prefixed',
      tool_call_names: CERTIFICATION_REQUIRED_TOOLS.map((tool) => runtimeToolName(runtimeKind, tool)),
      setup_steps: [
        `Download and extract the immutable Hermes integration bundle for Deft ${DEFT_RELEASE_VERSION}.`,
        'Install the bundled deft-platform, deft-employee, and deft-memory plugin directories into the active Hermes profile; do not copy them from another Deft checkout.',
        'Enable the three bundled plugins in the active Hermes config.yaml. deft-platform must be the only Agent Channel delivery adapter for this employee.',
        'The native adapter will auto-load the bundled deft-employee:runtime skill into each new Deft session; keep deft-employee enabled and restart old sessions after an integration upgrade.',
        'Replace the home_channel chat_id placeholders with an existing organization and space that this employee may access.',
        'Configure mcp_servers.deft as the direct HTTP Deft MCP endpoint with this employee\'s separate MCP bearer token; no stdio shim is required.',
        'Set the five employee-bound DEFT_CHANNEL_URL, DEFT_CHANNEL_TOKEN, DEFT_EMPLOYEE_SLUG, DEFT_MCP_URL, and DEFT_MCP_TOKEN variables, then run the bundled deft-platform readiness.py probe before starting Hermes.',
        'Enable the authenticated Hermes Responses API and start the Hermes gateway. The native plugin consumes Agent Channel work inside Hermes.',
        'Run hermes mcp test deft and verify the direct HTTP endpoint reports the Deft MCP tool list.',
        'Run a Hermes chat prompt that uses the model-visible mcp_deft_<tool> names.',
        'Use mcp_deft_memory_recall for Deft wiki context; mcp_deft_wiki_search is accepted as a compatibility alias.',
        'Rollback only: stop Hermes, disable deft-platform, rotate both employee credentials, and then use the matched legacy Node bridge. Never run native and legacy adapters together.',
      ],
      commands: [
        {
          label: 'Download matched Deft integration',
          command: `curl -fL -o deft-hermes-integration-${DEFT_RELEASE_VERSION}.tar.gz ${hermesIntegrationBundleUrl()}`,
          description: `Downloads the checksummed Hermes integration built for Deft ${DEFT_RELEASE_VERSION}.`,
        },
        {
          label: 'Probe native Deft readiness',
          command: 'python ./plugins/deft-platform/readiness.py',
          description: 'From the extracted bundle or Hermes profile root, verifies the employee-bound Agent Channel and direct HTTP MCP credentials before delivery starts.',
        },
        {
          label: 'List configured MCP servers',
          command: 'hermes mcp list',
          description: 'Confirms the deft server is configured and enabled.',
        },
        {
          label: 'Test Deft MCP discovery',
          command: 'hermes mcp test deft',
          description: 'Confirms Hermes can reach the direct HTTP Deft MCP endpoint and discover Deft tools.',
        },
        {
          label: 'Verify enabled tools',
          command: 'hermes tools list',
          description: 'Confirms the deft MCP tools are enabled for the CLI platform.',
        },
        {
          label: 'Start the Hermes API',
          command: 'hermes gateway run --force',
          description: 'Runs the authenticated Hermes Responses API and the enabled native deft-platform delivery adapter.',
        },
        {
          label: 'Open an interactive certification chat',
          command: 'hermes chat --cli --max-turns 20',
          description: 'Starts Hermes without embedding the prompt in an executable shell string. Paste the separate certification prompt into the chat.',
        },
      ],
      config_snippet: [
        'plugins:',
        '  enabled:',
        '    - deft-platform',
        '    - deft-employee',
        '    - deft-memory',
        '',
        'platforms:',
        '  deft:',
        '    enabled: true',
        '    home_channel:',
        '      platform: deft',
        '      chat_id: <organization-id>:<space-id>',
        '      name: Deft home',
        '    extra:',
        `      channel_url: ${channelEndpoint}`,
        '      token: <employee-agent-channel-token>',
        `      employee_slug: ${employee.slug}`,
        '',
        'mcp_servers:',
        '  deft:',
        `    url: ${endpoint}`,
        '    headers:',
        '      Authorization: Bearer <employee-mcp-token>',
        '    enabled: true',
        '',
        'memory:',
        '  provider: deft-memory',
        '',
        'display:',
        '  busy_input_mode: queue',
        '  busy_ack_enabled: false',
      ].join('\n'),
      bridge_script: hermesLegacyMcpBridgeScript(),
      certification_prompt: certificationPrompt,
      troubleshooting: [
        'If hermes mcp test deft passes but certification is pending, the model loop has not called Deft tools yet.',
        'Hermes tools/list may describe tools as deft:<tool>, but the model-visible tools are named mcp_deft_<tool>.',
        'Use names such as mcp_deft_ping_alive in the prompt; bare names may be ignored by Hermes.',
        'Use mcp_deft_memory_recall for wiki context; mcp_deft_wiki_search exists only for compatibility with older/native wording.',
        'If Hermes exits before tool calls with a provider/auth error, fix Hermes model credentials first.',
        'Avoid passing a toolset override that disables MCP tools for the run.',
        'DEFT_CHANNEL_URL and DEFT_CHANNEL_TOKEN alone do not wake Hermes; deft-platform must be enabled in the active profile and the Hermes gateway must be running.',
        `If deft-platform reports INCOMPATIBLE_CHANNEL, install the integration bundle for Deft ${DEFT_RELEASE_VERSION}; do not mix adapter versions.`,
        'If a channel reply appears twice, stop any legacy Agent Channel bridge or duplicate Hermes profile immediately. Only one adapter may consume work for an employee.',
        'The embedded Node stdio shim and bundled Node Agent Channel bridge are rollback-only. Stop Hermes and disable deft-platform before using them, and rotate both employee credentials during rollback.',
      ],
    };
  }

  return {
    runtime_kind: runtimeKind,
    tool_server_name: null,
    channel_protocol_version: AGENT_CHANNEL_PROTOCOL_VERSION,
    channel_capabilities: [...AGENT_CHANNEL_CAPABILITIES],
    integration_version: null,
    integration_bundle_url: null,
    mcp_endpoint_url: endpoint,
    channel_endpoint_url: channelEndpoint,
    tool_name_style: 'bare',
    tool_call_names: [...CERTIFICATION_REQUIRED_TOOLS],
    setup_steps: [
      'Connect the runtime to the Deft MCP endpoint with its bearer token.',
      'Connect the runtime to the Deft Agent Channel endpoint with its channel token for live message/task delivery.',
      'Pass caller_employee_slug on every Deft MCP tool call.',
      'Use memory_recall for Deft wiki context; wiki_search is accepted as a compatibility alias.',
      'Run certification before assigning real work.',
    ],
    commands: [],
    config_snippet: null,
    bridge_script: null,
    certification_prompt: certificationPrompt,
    troubleshooting: [
      'If the MCP endpoint is reachable but certification is pending, check whether the runtime actually called the required tools.',
      'If every call fails with caller slug errors, verify caller_employee_slug matches the employee slug exactly.',
      'Use memory_recall for wiki context; wiki_search exists only for compatibility with older/native wording.',
    ],
  };
}

function certificationInstructions(
  employee: { name: string; slug: string; runtime_kind?: string | null },
  nonce: string,
): string {
  const setup = buildRuntimeSetup(employee, nonce);
  const required = setup.tool_call_names.join(', ');
  return [
    `Connect the runtime to ${mcpEndpointUrl()} with its bearer token.`,
    `Use caller_employee_slug exactly as "${employee.slug}" on every tool call.`,
    `Run these Deft MCP tools: ${required}.`,
    `Include this exact challenge nonce in record_conversation_turn and record_decision: ${nonce}.`,
    'For task_query, search for any active task or request a small list, and confirm returned tasks expose allowed_next_statuses. Do not mutate task state during certification.',
    'For module_list, request enabled modules. If one exists, call module_schema_get and inspect its create/update input schemas and collection examples. An empty list is valid; do not mutate module records during certification.',
    `For ping_alive, identify yourself naturally as ${employee.name}; do not prefix every future chat message with your name.`,
    runtimeKindOf(employee) === 'hermes'
      ? 'After the first assignment passes, restart the Hermes gateway once. Deft will send a fresh assignment to prove native deft-platform reconnect persistence.'
      : 'After the first assignment passes, restart the channel runtime once. Deft will send a fresh assignment to prove reconnect persistence.',
    ...setup.troubleshooting.map((line) => `Troubleshooting: ${line}`),
  ].join('\n');
}

function buildCertificationStages(params: {
  employee: { certification_status?: string | null; last_mcp_call_at?: Date | string | null; runtime_kind?: string | null };
  missingTools: string[];
  nonceSeen: boolean;
  auditCount: number;
  privateMemoryVerified: boolean;
  channelEventSeen: boolean;
  channelCompleted: boolean;
  channelReplyNonceSeen: boolean;
  singleDelivery: boolean;
  singleReply: boolean;
  runtimeSessionSeen: boolean;
  runtimeExecutionSeen: boolean;
  runtimeExecutionProof: CertificationExecutionProof;
  restartDetected: boolean;
  restartProofCompleted: boolean;
  completed: boolean;
}): CertificationStage[] {
  const runtimeKind = runtimeKindOf(params.employee);
  const hasToken = Boolean(params.employee.certification_status);
  const mcpReachable = params.auditCount > 0 || Boolean(params.employee.last_mcp_call_at);
  const toolsCalled = params.missingTools.length === 0;
  return [
    {
      key: 'token_issued',
      label: 'Token issued',
      status: hasToken ? 'pass' : 'pending',
      detail: hasToken ? 'Deft has issued an employee bearer token.' : 'Generate a token for this employee.',
    },
    {
      key: 'mcp_reachable',
      label: 'MCP reachable',
      status: mcpReachable ? 'pass' : 'pending',
      detail: mcpReachable
        ? 'Deft has seen this employee reach the MCP server.'
        : runtimeKind === 'hermes'
          ? 'Run hermes mcp test deft after configuring the direct HTTP Deft MCP server.'
          : 'Connect the runtime to the Deft MCP endpoint.',
    },
    {
      key: 'channel_delivered',
      label: 'Assignment delivered',
      status: params.channelEventSeen && params.singleDelivery ? 'pass' : 'pending',
      detail: params.channelEventSeen && params.singleDelivery
        ? 'The certification assignment was claimed exactly once through Agent Channel.'
        : 'Waiting for a compatible runtime to claim the certification assignment exactly once.',
    },
    {
      key: 'runtime_inference',
      label: 'Runtime reply verified',
      status: params.runtimeExecutionSeen ? 'pass' : 'pending',
      detail: params.runtimeExecutionProof === 'autonomous_source_reply'
        ? 'Hermes returned one authenticated native reply while transport acceptance remained nonterminal.'
        : params.runtimeExecutionSeen
          ? 'Hermes completed the assignment and reported a terminal supervised outcome.'
          : 'Waiting for Hermes to return a verifiable source-bound runtime reply.',
    },
    {
      key: 'required_tools_called',
      label: 'Required tools called',
      status: toolsCalled ? 'pass' : 'pending',
      detail: toolsCalled
        ? 'All required Deft certification tools have been called.'
        : `Missing: ${params.missingTools.join(', ')}`,
    },
    {
      key: 'cooperative_nonce_seen',
      label: 'Nonce recorded',
      status: params.nonceSeen ? 'pass' : 'pending',
      detail: params.nonceSeen
        ? 'The challenge nonce was recorded in the cooperative log.'
        : 'Call record_conversation_turn or record_decision with the challenge nonce.',
    },
    {
      key: 'private_memory_round_trip',
      label: 'Private memory round-trip',
      status: params.privateMemoryVerified ? 'pass' : 'pending',
      detail: params.privateMemoryVerified
        ? 'A nonce-bound private page exists and the retry-safe write was replayed before recall.'
        : 'Write the nonce-bound private memory twice with the same idempotency key, then recall it.',
    },
    {
      key: 'channel_reply_verified',
      label: 'Reply verified',
      status: params.channelReplyNonceSeen && params.singleReply ? 'pass' : 'pending',
      detail: params.channelReplyNonceSeen && params.singleReply
        ? 'The Agent Channel reply contains the one-time certification nonce.'
        : !params.singleReply
          ? 'Waiting for exactly one successful Agent Channel reply.'
          : 'Waiting for a nonce-bearing reply through Agent Channel.',
    },
    {
      key: 'runtime_restart_detected',
      label: 'Runtime restart detected',
      status: params.restartDetected ? 'pass' : 'pending',
      detail: params.restartDetected
        ? runtimeKind === 'hermes'
          ? 'The native deft-platform adapter reconnected with a new worker identity.'
          : 'The remote channel runtime reconnected with a new worker identity.'
        : runtimeKind === 'hermes'
          ? 'Restart the Hermes gateway once to prove native adapter recovery.'
          : 'Restart the channel runtime once to prove durable recovery.',
    },
    {
      key: 'post_restart_assignment',
      label: 'Post-restart assignment completed',
      status: params.restartProofCompleted ? 'pass' : 'pending',
      detail: params.restartProofCompleted
        ? 'Hermes claimed and completed fresh work after reconnecting.'
        : 'Waiting for Hermes to process the restart-proof assignment.',
    },
    {
      key: 'verified',
      label: 'Verified employee',
      status: params.completed ? 'pass' : 'pending',
      detail: params.completed
        ? 'This employee passed certification.'
        : runtimeKind === 'hermes'
          ? 'Hermes must call mcp_deft_* tools from the model loop before this turns green.'
          : 'Complete the missing stages to verify this employee.',
    },
  ];
}

function certificationFailureReason(params: {
  employee: { runtime_kind?: string | null; last_mcp_call_at?: Date | string | null };
  missingTools: string[];
  nonceSeen: boolean;
  auditCount: number;
  privateMemoryVerified: boolean;
  channelEventSeen: boolean;
  channelCompleted: boolean;
  channelReplyNonceSeen: boolean;
  singleDelivery: boolean;
  singleReply: boolean;
  runtimeSessionSeen: boolean;
  runtimeExecutionSeen: boolean;
  restartDetected: boolean;
  restartProofCompleted: boolean;
}): string | null {
  if (
    params.missingTools.length === 0
    && params.nonceSeen
    && params.privateMemoryVerified
    && params.channelEventSeen
    && params.channelReplyNonceSeen
    && params.singleDelivery
    && params.singleReply
    && params.runtimeExecutionSeen
    && params.restartDetected
    && params.restartProofCompleted
  ) return null;
  const runtimeKind = runtimeKindOf(params.employee);
  const mcpReachable = params.auditCount > 0 || Boolean(params.employee.last_mcp_call_at);
  if (!mcpReachable) {
    return runtimeKind === 'hermes'
      ? 'Hermes has not reached Deft MCP yet. Run `hermes mcp test deft` and check the direct HTTP MCP config.'
      : 'The runtime has not reached Deft MCP yet.';
  }
  if (!params.channelEventSeen) return 'The Hermes runtime has not claimed the Agent Channel certification assignment.';
  if (!params.singleDelivery) return 'The certification assignment was delivered more than once. Reset certification after fixing runtime stability.';
  if (!params.singleReply) return 'The certification assignment does not have exactly one successful Agent Channel reply.';
  if (!params.runtimeExecutionSeen) return 'Hermes has not completed a verifiable runtime turn for the certification assignment.';
  if (params.missingTools.length > 0) {
    return runtimeKind === 'hermes'
      ? `Hermes can reach Deft MCP, but its model loop has not called: ${params.missingTools.map((tool) => runtimeToolName('hermes', tool)).join(', ')}. Check model auth and use the mcp_deft_* tool names.`
      : `The runtime has not called: ${params.missingTools.join(', ')}.`;
  }
  if (!params.privateMemoryVerified) {
    return 'Certification did not verify a replay-safe employee-private memory page and recall round-trip.';
  }
  if (!params.channelReplyNonceSeen) return 'Hermes completed tool calls but did not reply through Agent Channel with the certification nonce.';
  if (!params.restartDetected) {
    return runtimeKind === 'hermes'
      ? 'Restart the Hermes gateway once so Deft can prove native deft-platform reconnect persistence.'
      : 'Restart the channel runtime once so Deft can prove reconnect persistence.';
  }
  if (!params.restartProofCompleted) {
    return runtimeKind === 'hermes'
      ? 'The native deft-platform adapter reconnected, but Hermes has not completed the post-restart proof assignment yet.'
      : 'The channel runtime reconnected, but it has not completed the post-restart proof assignment yet.';
  }
  return 'Required tools were called, but the challenge nonce was not recorded in the cooperative log.';
}

async function cancelPendingCertification(orgId: string, employeeId: string, reason: string) {
  await db.execute(sql`
    UPDATE agent_certification_challenges
    SET status = 'reset',
        failure_reason = ${reason},
        completed_at = now(),
        updated_at = now()
    WHERE org_id = ${orgId}
      AND employee_id = ${employeeId}
      AND status = 'pending'
  `);
  await db.execute(sql`
    UPDATE agent_channel_events
    SET status = 'cancelled',
        completed_at = COALESCE(completed_at, now()),
        work_outcome = 'cancelled',
        outcome_detail = ${reason},
        outcome_at = now(),
        claim_owner = NULL,
        claim_token = NULL,
        claimed_at = NULL,
        lease_expires_at = NULL,
        updated_at = now()
    WHERE org_id = ${orgId}
      AND agent_employee_id = ${employeeId}
      AND source_kind = 'certification'
      AND status IN ('pending', 'delivered', 'acknowledged', 'running', 'approval_pending')
  `);
}

async function issueMcpToken({
  orgId,
  employeeId,
  employeeName,
  createdBy,
  deactivateExisting = false,
}: {
  orgId: string;
  employeeId: string;
  employeeName: string;
  createdBy: string;
  deactivateExisting?: boolean;
}): Promise<string> {
  const keyId = crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  const rawApiKey = `deft_${keyId}`;
  const keyHash = await bcrypt.hash(rawApiKey, 12);
  const keyPrefix = rawApiKey.slice(0, 12);

  if (deactivateExisting) {
    await db
      .update(apiKeys)
      .set({ is_active: false })
      .where(and(eq(apiKeys.org_id, orgId), eq(apiKeys.agent_employee_id, employeeId)));
  }

  await db.insert(apiKeys).values({
    org_id: orgId,
    agent_employee_id: employeeId,
    name: `${employeeName} API Key`,
    key_hash: keyHash,
    key_prefix: keyPrefix,
    permissions: ['read:spaces', 'read:tasks', 'read:messages', 'read:members'],
    created_by: createdBy,
  });

  await db
    .update(agentEmployees)
    .set({ mcp_token_hash: keyHash })
    .where(eq(agentEmployees.id, employeeId));

  return rawApiKey;
}

async function installRequiredWorkspaceSkill(employeeId: string) {
  const [workspaceSkill] = await db
    .select({ id: skills.id, version: skills.version })
    .from(skills)
    .where(and(eq(skills.slug, 'deft-workspace'), eq(skills.is_deleted, false)))
    .limit(1);
  if (!workspaceSkill) {
    console.warn('[agent-employees] bundled deft-workspace skill is not seeded');
    return false;
  }
  await db
    .insert(agentEmployeeSkills)
    .values({
      agent_employee_id: employeeId,
      skill_id: workspaceSkill.id,
      installed_version: workspaceSkill.version,
    })
    .onConflictDoNothing();
  return true;
}

agentEmployeeRoutes.post('/', async (c) => {
  try {
    const authorizationError = await requireOwnerOrAdmin(c);
    if (authorizationError) return authorizationError;

    const currentUser = c.get('user');
    const body = await c.req.json();
    const parsed = createSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR', details: parsed.error.flatten() }, 400);
    }

    const data = parsed.data;
    const invalidReference = await validateAgentTenantReferences({
      orgId: currentUser.org_id,
      spaceIds: data.space_ids,
      projectIds: data.project_ids,
      mcpConnectionIds: data.mcp_connection_ids,
    });
    if (invalidReference) {
      return c.json({ error: invalidReference, code: 'VALIDATION_ERROR' }, 400);
    }

    // 1. Create user record with is_agent: true
    const title = data.job_title?.trim() || roleToTitle(data.role);
    const [agentUser] = await db
      .insert(users)
      .values({
        name: data.name,
        is_agent: true,
        kind: 'agent',
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
        .where(and(
          eq(spaces.org_id, currentUser.org_id),
          eq(spaces.type, 'public'),
          eq(spaces.is_archived, false),
        ));
      spaceIdsToJoin = publicSpaces.map((s) => s.id);
    }

    for (const spaceId of spaceIdsToJoin) {
      await db
        .insert(spaceMembers)
        .values({ space_id: spaceId, user_id: agentUser!.id })
        .onConflictDoNothing();
    }

    // 4. Create agent_employees record
    const slug = await uniqueEmployeeSlug(currentUser.org_id, data.name);

    const [employee] = await db
      .insert(agentEmployees)
      .values({
        org_id: currentUser.org_id,
        user_id: agentUser!.id,
        name: data.name,
        slug,
        role: data.role,
        runtime_kind: data.runtime_kind || 'custom_mcp',
        job_title: data.job_title?.trim() || null,
        wake_mode: data.wake_mode,
        avatar_url: data.avatar_url || null,
        system_prompt: data.system_prompt,
        expertise_description: data.expertise_description || null,
        connection_notes: data.connection_notes?.trim() || null,
        mcp_connection_ids: data.mcp_connection_ids ?? null,
        disabled_tools: data.disabled_tools ?? null,
        space_ids: spaceIdsToJoin.length > 0 ? spaceIdsToJoin : null,
        project_ids: data.project_ids ?? null,
        trust_level: data.trust_level,
        max_daily_actions: data.max_daily_actions,
        is_byoa: true,
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

    await installRequiredWorkspaceSkill(employee!.id);

    // 5. Always auto-generate the API key. Every agent in v1 is BYOA —
    // the same token is persisted on BOTH sides so the agent works
    // against either the standard MCP endpoint (/api/mcp/v1, auth via
    // agent_employees.mcp_token_hash) or the deprecated /mcp REST
    // surface (auth via api_keys). /api/mcp/v1 is the modern path; /mcp
    // is kept during the deprecation window so existing integrations
    // don't break.
    const rawApiKey = await issueMcpToken({
      orgId: currentUser.org_id,
      employeeId: employee!.id,
      employeeName: data.name,
      createdBy: currentUser.id,
    });
    const channelToken = await issueAgentChannelToken({
      orgId: currentUser.org_id,
      employeeId: employee!.id,
      employeeName: data.name,
      createdBy: currentUser.id,
      deactivateExisting: false,
    });

    return c.json(
      {
        employee: employee!,
        user_id: agentUser!.id,
        api_key: rawApiKey,
        channel_key: channelToken.raw,
        channel_endpoint_url: agentChannelEndpointUrl(),
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
  runtime_kind: externalRuntimeKindSchema.optional(),
  job_title: z.string().min(1).max(120).nullable().optional(),
  wake_mode: z.enum(['manual', 'polling', 'webhook', 'external_chat']).optional(),
  system_prompt: z.string().min(1).optional(),
  expertise_description: z.string().optional(),
  connection_notes: z.string().max(2000).nullable().optional(),
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
    const authorizationError = await requireOwnerOrAdmin(c);
    if (authorizationError) return authorizationError;

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
    const invalidReference = await validateAgentTenantReferences({
      orgId: user.org_id,
      spaceIds: data.space_ids,
      projectIds: data.project_ids,
      mcpConnectionIds: data.mcp_connection_ids,
    });
    if (invalidReference) {
      return c.json({ error: invalidReference, code: 'VALIDATION_ERROR' }, 400);
    }
    const updates: Record<string, any> = {};

    if (data.name !== undefined) updates.name = data.name;
    if (data.runtime_kind !== undefined) updates.runtime_kind = data.runtime_kind;
    if (data.job_title !== undefined) updates.job_title = data.job_title;
    if (data.wake_mode !== undefined) updates.wake_mode = data.wake_mode;
    if (data.system_prompt !== undefined) updates.system_prompt = data.system_prompt;
    if (data.expertise_description !== undefined) updates.expertise_description = data.expertise_description;
    if (data.connection_notes !== undefined) updates.connection_notes = data.connection_notes;
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
    if (data.project_ids !== undefined) {
      invalidatePlatformContextCacheFor(id);
    }

    // Also update the user name if changed
    if (data.name) {
      await db.update(users).set({ name: data.name }).where(eq(users.id, existing.user_id));
    }
    if (data.job_title !== undefined) {
      await db.update(users).set({ title: data.job_title ?? roleToTitle(existing.role) }).where(eq(users.id, existing.user_id));
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
   * flow. Deft-side config only. The agent's own markdown files (SOUL.md
   * etc.) live in the operator's BYOA runtime and are edited there.
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
    .where(and(
      eq(orgMembers.user_id, userId),
      eq(orgMembers.org_id, orgId),
      eq(orgMembers.is_active, true),
    ))
    .limit(1);
  return m?.role ?? null;
}

async function requireOwnerOrAdmin(c: Context): Promise<Response | null> {
  const user = c.get('user') as { id: string; org_id: string };
  const role = await getOrgRole(user.id, user.org_id);
  if (role === 'owner' || role === 'admin') return null;
  return c.json(
    {
      error: 'Only owners or admins can manage agent employees and runtime diagnostics',
      code: 'FORBIDDEN',
    },
    403,
  );
}

async function validateAgentTenantReferences(params: {
  orgId: string;
  spaceIds?: string[] | null;
  projectIds?: string[] | null;
  mcpConnectionIds?: string[] | null;
}): Promise<string | null> {
  const spaceIds = [...new Set(params.spaceIds ?? [])];
  if (spaceIds.length > 0) {
    const rows = await db
      .select({ id: spaces.id })
      .from(spaces)
      .where(and(
        eq(spaces.org_id, params.orgId),
        eq(spaces.is_archived, false),
        inArray(spaces.id, spaceIds),
      ));
    if (rows.length !== spaceIds.length) return 'Every space_id must reference an active space in this organization';
  }

  const projectIds = [...new Set(params.projectIds ?? [])];
  if (projectIds.length > 0) {
    const rows = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(
        eq(projects.org_id, params.orgId),
        eq(projects.is_archived, false),
        eq(projects.is_deleted, false),
        inArray(projects.id, projectIds),
      ));
    if (rows.length !== projectIds.length) return 'Every project_id must reference an active project in this organization';
  }

  const mcpConnectionIds = [...new Set(params.mcpConnectionIds ?? [])];
  if (mcpConnectionIds.length > 0) {
    const rows = await db
      .select({ id: mcpConnections.id })
      .from(mcpConnections)
      .where(and(
        eq(mcpConnections.org_id, params.orgId),
        eq(mcpConnections.is_active, true),
        inArray(mcpConnections.id, mcpConnectionIds),
      ));
    if (rows.length !== mcpConnectionIds.length) return 'Every mcp_connection_id must reference an active connection in this organization';
  }

  return null;
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
      parsed.data.max_daily_actions !== undefined ||
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
    // is a no-op.
    if (parsed.data.heartbeat_cadence_minutes !== undefined) {
      try {
        const { rescheduleHeartbeat } = await import('../lib/job-scheduler.js');
        await rescheduleHeartbeat();
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

agentEmployeeRoutes.post('/:id/action-budget/reset', async (c) => {
  try {
    const authorizationError = await requireOwnerOrAdmin(c);
    if (authorizationError) return authorizationError;

    const user = c.get('user');
    const employeeId = c.req.param('id');
    const now = new Date();
    const reset = await db.transaction(async (tx) => {
      const [employee] = await tx.select({
        id: agentEmployees.id,
        daily_action_count: agentEmployees.daily_action_count,
        max_daily_actions: agentEmployees.max_daily_actions,
      }).from(agentEmployees).where(and(
        eq(agentEmployees.id, employeeId),
        eq(agentEmployees.org_id, user.org_id),
        eq(agentEmployees.is_deleted, false),
      )).limit(1).for('update');
      if (!employee) return null;
      if (employee.daily_action_count === 0) {
        return { employee, actionId: null, previousCount: 0 };
      }

      await tx.update(agentEmployees).set({
        daily_action_count: 0,
        updated_at: now,
      }).where(and(
        eq(agentEmployees.id, employeeId),
        eq(agentEmployees.org_id, user.org_id),
      ));
      const result = {
        previous_count: employee.daily_action_count,
        daily_action_count: 0,
        max_daily_actions: employee.max_daily_actions,
      };
      const [action] = await tx.insert(agentActions).values({
        org_id: user.org_id,
        user_id: user.id,
        agent_employee_id: employeeId,
        source: 'user',
        action: 'action_budget_reset',
        params: { previous_count: employee.daily_action_count },
        approval_tier: 'full',
        approval_status: 'approved',
        approved_at: now,
        executed_at: now,
        result,
      }).returning({ id: agentActions.id });
      return {
        employee: { ...employee, daily_action_count: 0 },
        actionId: action!.id,
        previousCount: employee.daily_action_count,
      };
    });

    if (!reset) {
      return c.json({ error: 'Agent employee not found', code: 'NOT_FOUND' }, 404);
    }
    if (reset.actionId) {
      await generateReceipt({
        actionId: reset.actionId,
        orgId: user.org_id,
        employeeId,
        proposer: 'user',
        proposerId: user.id,
        approverId: user.id,
        decision: 'approved',
        actionName: 'action_budget_reset',
        actionParams: { previous_count: reset.previousCount },
        resultJson: {
          daily_action_count: 0,
          max_daily_actions: reset.employee.max_daily_actions,
        },
      });
    }

    return c.json({
      ok: true,
      daily_action_count: 0,
      max_daily_actions: reset.employee.max_daily_actions,
      action_id: reset.actionId,
    });
  } catch (err) {
    console.error('Failed to reset agent action budget:', err);
    return c.json({ error: 'Failed to reset action budget', code: 'INTERNAL_ERROR' }, 500);
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

      // capability_packs column was dropped (PR 4 C); pack membership is now
      // derived at runtime from installed skills' agent_config.capability_packs.
      const [updated] = await tx
        .update(agentEmployees)
        .set({
          trigger_subscriptions: mergedClaims,
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

    // Soft-delete: is_deleted=true + deleted_at. List endpoints filter
    // is_deleted=false so the row disappears from the UI. The shadow user
    // is flipped out of is_agent so cross-references don't spuriously
    // render it as a real employee.
    await db
      .update(agentEmployees)
      .set({ is_active: false, is_deleted: true, deleted_at: new Date() })
      .where(eq(agentEmployees.id, id));
    await db.update(users).set({ is_agent: false }).where(eq(users.id, existing.user_id));
    await db
      .update(orgMembers)
      .set({ is_active: false, updated_at: new Date() })
      .where(and(eq(orgMembers.org_id, user.org_id), eq(orgMembers.user_id, existing.user_id)));

    // Module proposals temporarily contain record values for review. Close
    // those through the module-aware terminal path before the legacy generic
    // expiry so deletion cannot strand raw values or idempotency keys.
    await terminalizePendingModuleActions({
      orgId: user.org_id,
      employeeId: id,
      reason: 'Agent employee removed',
      attentionResolution: 'employee_removed',
    });

    // Preserve the existing status-only lifecycle for non-module actions.
    const expiredActions = await db
      .update(agentActions)
      .set({ approval_status: 'expired' })
      .where(
        and(
          eq(agentActions.org_id, user.org_id),
          eq(agentActions.agent_employee_id, id),
          eq(agentActions.approval_status, 'pending'),
          notInArray(agentActions.action, [...MODULE_WRITE_ACTION_NAMES]),
        ),
      )
      .returning({ id: agentActions.id, params: agentActions.params });
    await markWorkIntentsExpiredForActions({
      orgId: user.org_id,
      actions: expiredActions,
      reason: 'Agent employee removed',
    });

    // BYOA agents are long-running processes on the operator's own infra;
    // deleting the employee record releases the MCP token and stops Defty
    // from dispatching to it.

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

    const role = await getOrgRole(user.id, user.org_id);
    if (role !== 'owner' && role !== 'admin') {
      return c.json({ error: 'Only owners or admins can pause agent employees', code: 'FORBIDDEN' }, 403);
    }

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

    const role = await getOrgRole(user.id, user.org_id);
    if (role !== 'owner' && role !== 'admin') {
      return c.json({ error: 'Only owners or admins can resume agent employees', code: 'FORBIDDEN' }, 403);
    }

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

    const limit = Math.min(Math.max(Number.parseInt(c.req.query('limit') ?? '50', 10) || 50, 1), 100);
    return c.json(await loadAgentActivity({ orgId: user.org_id, employeeId: id, limit }));
  } catch (err) {
    console.error('Failed to get agent employee activity:', err);
    return c.json({ error: 'Failed to get activity', code: 'INTERNAL_ERROR' }, 500);
  }
});

agentEmployeeRoutes.post('/:id/channel-events/:eventId/retry', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const eventId = c.req.param('eventId');
  const role = await getOrgRole(user.id, user.org_id);
  if (role !== 'owner' && role !== 'admin') {
    return c.json({ error: 'Only owners or admins can retry deliveries', code: 'FORBIDDEN' }, 403);
  }

  const [event] = await db.select().from(agentChannelEvents).where(and(
    eq(agentChannelEvents.id, eventId),
    eq(agentChannelEvents.agent_employee_id, id),
    eq(agentChannelEvents.org_id, user.org_id),
  )).limit(1);
  if (!event) return c.json({ error: 'Channel event not found', code: 'NOT_FOUND' }, 404);
  if (event.status !== 'failed' && event.status !== 'cancelled') {
    return c.json({ error: 'Only failed or cancelled deliveries can be retried', code: 'INVALID_STATE' }, 409);
  }

  const [updated] = await db.update(agentChannelEvents).set({
    status: 'pending',
    delivered_at: null,
    acked_at: null,
    completed_at: null,
    failed_at: null,
    claim_owner: null,
    claim_token: null,
    claimed_at: null,
    lease_expires_at: null,
    work_outcome: null,
    outcome_detail: null,
    outcome_at: null,
    runtime_session_key: null,
    error: null,
    updated_at: new Date(),
  }).where(and(
    eq(agentChannelEvents.id, eventId),
    eq(agentChannelEvents.agent_employee_id, id),
    eq(agentChannelEvents.org_id, user.org_id),
    or(eq(agentChannelEvents.status, 'failed'), eq(agentChannelEvents.status, 'cancelled')),
  )).returning();
  if (!updated) {
    return c.json({ error: 'Delivery state changed before it could be retried', code: 'INVALID_STATE' }, 409);
  }
  return c.json({ event: updated });
});

agentEmployeeRoutes.post('/:id/channel-events/:eventId/cancel', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const eventId = c.req.param('eventId');
  const role = await getOrgRole(user.id, user.org_id);
  if (role !== 'owner' && role !== 'admin') {
    return c.json({ error: 'Only owners or admins can cancel deliveries', code: 'FORBIDDEN' }, 403);
  }

  const [event] = await db.select().from(agentChannelEvents).where(and(
    eq(agentChannelEvents.id, eventId),
    eq(agentChannelEvents.agent_employee_id, id),
    eq(agentChannelEvents.org_id, user.org_id),
  )).limit(1);
  if (!event) return c.json({ error: 'Channel event not found', code: 'NOT_FOUND' }, 404);
  if (['completed', 'failed', 'cancelled'].includes(event.status)) {
    return c.json({ error: 'Terminal deliveries cannot be cancelled', code: 'INVALID_STATE' }, 409);
  }

  const [updated] = await db.update(agentChannelEvents).set({
    status: 'cancelled',
    error: 'Cancelled by an operator',
    failed_at: new Date(),
    lease_expires_at: null,
    work_outcome: 'cancelled',
    outcome_detail: 'Cancelled by an operator',
    outcome_at: new Date(),
    updated_at: new Date(),
  }).where(and(
    eq(agentChannelEvents.id, eventId),
    eq(agentChannelEvents.agent_employee_id, id),
    eq(agentChannelEvents.org_id, user.org_id),
    or(
      eq(agentChannelEvents.status, 'pending'),
      eq(agentChannelEvents.status, 'delivered'),
      eq(agentChannelEvents.status, 'acknowledged'),
      eq(agentChannelEvents.status, 'running'),
      eq(agentChannelEvents.status, 'approval_pending'),
    ),
  )).returning();
  if (!updated) {
    return c.json({ error: 'Delivery state changed before it could be cancelled', code: 'INVALID_STATE' }, 409);
  }
  return c.json({ event: updated });
});

// The legacy retry-provision endpoint and the agents.files.* RPC routes
// were removed in the v1 self-hosted reframe. All agents are BYOA —
// operators run them on their own infra and Deft does not control the
// agent's filesystem. A Defty-specific settings page (Defty's SOUL.md
// lives inside Deft) can come back as its own focused feature if needed.

const onboardingPreflightSchema = z.object({
  modules: z.array(z.object({
    module_id: z.string().trim().min(1).max(200),
    access: z.enum(['read', 'write']),
  }).strict()).max(50).default([]),
  hermes_toolsets: z.array(z.string().trim().min(1).max(64)).max(50).default([]),
  min_action_headroom: z.number().int().nonnegative().max(100_000).default(10),
  require_skills_api: z.boolean().default(true),
  required_model: z.string().trim().min(1).max(200).optional(),
}).strict();
type OnboardingPreflightRequirements = z.infer<typeof onboardingPreflightSchema>;

async function loadAgentOnboardingPreflight(
  orgId: string,
  employee: typeof agentEmployees.$inferSelect,
  requirements: OnboardingPreflightRequirements,
) {
  const [[connection], [channelToken]] = await Promise.all([
    db.select().from(agentChannelConnections)
      .where(and(eq(agentChannelConnections.agent_employee_id, employee.id), eq(agentChannelConnections.org_id, orgId))).limit(1),
    db.select({ id: agentChannelTokens.id }).from(agentChannelTokens).where(and(
      eq(agentChannelTokens.agent_employee_id, employee.id),
      eq(agentChannelTokens.org_id, orgId),
      eq(agentChannelTokens.is_active, true),
      isNull(agentChannelTokens.revoked_at),
    )).limit(1),
  ]);
  const installedModules = await db.select({
    module_id: moduleInstallations.module_id,
    access: moduleInstallations.agent_access,
    enabled: moduleInstallations.is_enabled,
  }).from(moduleInstallations).where(and(
    eq(moduleInstallations.org_id, orgId),
    eq(moduleInstallations.is_deleted, false),
  ));
  const metadata = connection?.metadata && typeof connection.metadata === 'object'
    ? connection.metadata as Record<string, unknown>
    : {};
  const attestation = metadata.runtime_attestation && typeof metadata.runtime_attestation === 'object'
    ? metadata.runtime_attestation as any
    : null;
  const adapterMode = typeof metadata.adapter_mode === 'string' ? metadata.adapter_mode : null;
  const runtimeCapabilities = Array.isArray(metadata.runtime_capabilities)
    ? metadata.runtime_capabilities.filter((value): value is string => typeof value === 'string')
    : [];
  return evaluateAgentOnboardingPreflight({
    employee: {
      active: employee.is_active && !employee.is_deleted,
      unhealthy: employee.unhealthy,
      has_mcp_token: Boolean(employee.mcp_token_hash),
      has_channel_token: Boolean(channelToken),
      trust_level: employee.trust_level,
      max_daily_actions: employee.max_daily_actions,
      daily_action_count: employee.daily_action_count,
    },
    connection: connection ? {
      status: connection.status,
      adapter_mode: adapterMode,
      runtime_capabilities: runtimeCapabilities,
      attestation,
    } : null,
    nativeRequiredCapabilities: AGENT_CHANNEL_AUTONOMOUS_REQUIRED_RUNTIME_CAPABILITIES,
    requirements,
    modules: installedModules as Array<{
      module_id: string;
      access: 'none' | 'read' | 'write';
      enabled: boolean;
    }>,
  });
}

agentEmployeeRoutes.post('/:id/onboarding-preflight', async (c) => {
  const authorizationError = await requireOwnerOrAdmin(c);
  if (authorizationError) return authorizationError;
  const user = c.get('user');
  const id = c.req.param('id');
  const parsed = onboardingPreflightSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR', details: parsed.error.flatten() }, 400);
  }

  const [employee] = await db.select().from(agentEmployees)
    .where(and(eq(agentEmployees.id, id), eq(agentEmployees.org_id, user.org_id))).limit(1);
  if (!employee || employee.is_deleted) {
    return c.json({ error: 'Agent employee not found', code: 'NOT_FOUND' }, 404);
  }
  const result = await loadAgentOnboardingPreflight(user.org_id, employee, parsed.data);
  return c.json(result, result.ready ? 200 : 409);
});

// ─── GET /:id/developer  → BYOA connection credentials ───────────────
//
// Returns the MCP endpoint URL and a masked token placeholder so the
// operator can wire up Claude Desktop / Claude Code / a custom MCP
// client. The raw bearer token is *not* recoverable —
// `agent_employees.mcp_token_hash` is a bcrypt hash and the raw value
// is shown exactly once at issuance (POST / and POST
// /:id/regenerate-token). `mcp_token` is therefore always null; if a
// caller needs a fresh token, regenerate.
agentEmployeeRoutes.get('/:id/developer', async (c) => {
  try {
    const authorizationError = await requireOwnerOrAdmin(c);
    if (authorizationError) return authorizationError;

    const user = c.get('user');
    const id = c.req.param('id');

    const [employee] = await db
      .select()
      .from(agentEmployees)
      .where(and(eq(agentEmployees.id, id), eq(agentEmployees.org_id, user.org_id)))
      .limit(1);
    if (!employee) return c.json({ error: 'Agent employee not found', code: 'NOT_FOUND' }, 404);

    const [latestChallenge] = await db
      .select()
      .from(agentCertificationChallenges)
      .where(and(eq(agentCertificationChallenges.employee_id, id), eq(agentCertificationChallenges.org_id, user.org_id)))
      .orderBy(desc(agentCertificationChallenges.created_at))
      .limit(1);

    const recentMcpCalls = await db
      .select({
        id: agentMcpCallAudit.id,
        tool_name: agentMcpCallAudit.tool_name,
        success: agentMcpCallAudit.success,
        error: agentMcpCallAudit.error,
        metadata: agentMcpCallAudit.metadata,
        created_at: agentMcpCallAudit.created_at,
      })
      .from(agentMcpCallAudit)
      .where(and(eq(agentMcpCallAudit.employee_id, id), eq(agentMcpCallAudit.org_id, user.org_id)))
      .orderBy(desc(agentMcpCallAudit.created_at))
      .limit(25);

    const recentCooperativeLog = await db
      .select({
        id: agentCooperativeLog.id,
        kind: agentCooperativeLog.kind,
        summary: agentCooperativeLog.summary,
        metadata: agentCooperativeLog.metadata,
        created_at: agentCooperativeLog.created_at,
      })
      .from(agentCooperativeLog)
      .where(and(eq(agentCooperativeLog.employee_id, id), eq(agentCooperativeLog.org_id, user.org_id)))
      .orderBy(desc(agentCooperativeLog.created_at))
      .limit(10);

    const [channelConnection] = await db
      .select()
      .from(agentChannelConnections)
      .where(and(eq(agentChannelConnections.agent_employee_id, id), eq(agentChannelConnections.org_id, user.org_id)))
      .limit(1);
    const [activeChannelToken] = await db
      .select({
        id: agentChannelTokens.id,
        token_prefix: agentChannelTokens.token_prefix,
        last_used_at: agentChannelTokens.last_used_at,
        created_at: agentChannelTokens.created_at,
      })
      .from(agentChannelTokens)
      .where(and(
        eq(agentChannelTokens.agent_employee_id, id),
        eq(agentChannelTokens.org_id, user.org_id),
        eq(agentChannelTokens.is_active, true),
        isNull(agentChannelTokens.revoked_at),
      ))
      .orderBy(desc(agentChannelTokens.created_at))
      .limit(1);
    const channelQueueRows = await db.execute(sql`
      SELECT status, COUNT(*)::int AS count
      FROM agent_channel_events
      WHERE org_id = ${user.org_id}
        AND agent_employee_id = ${id}
      GROUP BY status
    `);
    const channelQueue = Object.fromEntries(
      ((channelQueueRows as any).rows ?? channelQueueRows).map((row: any) => [row.status, Number(row.count)]),
    ) as Record<string, number>;
    const recentChannelEvents = await db
      .select({
        id: agentChannelEvents.id,
        kind: agentChannelEvents.kind,
        status: agentChannelEvents.status,
        source_kind: agentChannelEvents.source_kind,
        source_id: agentChannelEvents.source_id,
        delivery_count: agentChannelEvents.delivery_count,
        claim_owner: agentChannelEvents.claim_owner,
        lease_expires_at: agentChannelEvents.lease_expires_at,
        work_outcome: agentChannelEvents.work_outcome,
        outcome_detail: agentChannelEvents.outcome_detail,
        outcome_at: agentChannelEvents.outcome_at,
        error: agentChannelEvents.error,
        delivered_at: agentChannelEvents.delivered_at,
        acked_at: agentChannelEvents.acked_at,
        completed_at: agentChannelEvents.completed_at,
        failed_at: agentChannelEvents.failed_at,
        created_at: agentChannelEvents.created_at,
        updated_at: agentChannelEvents.updated_at,
      })
      .from(agentChannelEvents)
      .where(and(eq(agentChannelEvents.agent_employee_id, id), eq(agentChannelEvents.org_id, user.org_id)))
      .orderBy(desc(agentChannelEvents.created_at))
      .limit(100);
    const activity = await loadAgentActivity({ orgId: user.org_id, employeeId: id, limit: 30 });

    const challengeEvidence = latestChallenge
      ? await loadCertificationChallengeEvidence({
          orgId: user.org_id,
          employeeId: id,
          runtimeKind: employee.runtime_kind,
          challenge: latestChallenge,
        })
      : null;
    const onboardingPreflight = runtimeKindOf(employee) === 'hermes'
      ? await loadAgentOnboardingPreflight(user.org_id, employee, {
          modules: [],
          hermes_toolsets: [],
          min_action_headroom: 10,
          require_skills_api: true,
        })
      : null;

    return c.json({
      employee: {
        id: employee.id,
        slug: employee.slug,
        name: employee.name,
        runtime_kind: employee.runtime_kind,
        job_title: employee.job_title,
        wake_mode: employee.wake_mode,
        certification_status: employee.certification_status,
        last_verified_at: employee.last_verified_at,
        last_mcp_call_at: employee.last_mcp_call_at,
        last_work_outcome_at: employee.last_work_outcome_at,
        connection_notes: employee.connection_notes,
        last_heartbeat_at: employee.last_heartbeat_at,
        is_byoa: employee.is_byoa,
        byoa_model_info: employee.byoa_model_info,
      },
      certification: latestChallenge
        ? {
            id: latestChallenge.id,
            status: challengeEvidence?.completed
              ? 'completed'
              : latestChallenge.status === 'completed' ? 'pending' : latestChallenge.status,
            nonce: latestChallenge.nonce,
            required_tools: latestChallenge.required_tools,
            failure_reason: latestChallenge.failure_reason,
            started_at: latestChallenge.started_at,
            completed_at: challengeEvidence?.completed ? latestChallenge.completed_at : null,
            instructions: certificationInstructions(employee, latestChallenge.nonce),
            stages: buildCertificationStages({
              employee,
              missingTools: challengeEvidence?.missingTools ?? [],
              nonceSeen: challengeEvidence?.nonceSeen ?? false,
              auditCount: challengeEvidence?.auditCount ?? 0,
              privateMemoryVerified: challengeEvidence?.privateMemoryVerified ?? false,
              channelEventSeen: challengeEvidence?.channelEventSeen ?? false,
              channelCompleted: challengeEvidence?.channelCompleted ?? false,
              channelReplyNonceSeen: challengeEvidence?.channelReplyNonceSeen ?? false,
              singleDelivery: challengeEvidence?.singleDelivery ?? false,
              singleReply: challengeEvidence?.singleReply ?? false,
              runtimeSessionSeen: challengeEvidence?.runtimeSessionSeen ?? false,
              runtimeExecutionSeen: challengeEvidence?.runtimeExecutionSeen ?? false,
              runtimeExecutionProof: challengeEvidence?.runtimeExecutionProof ?? null,
              restartDetected: challengeEvidence?.restartDetected ?? false,
              restartProofCompleted: challengeEvidence?.restartProofCompleted ?? false,
              completed: challengeEvidence?.completed ?? false,
            }),
          }
        : null,
      runtime_setup: buildRuntimeSetup(employee, latestChallenge?.nonce ?? null),
      onboarding_preflight: onboardingPreflight,
      diagnostics: {
        recent_mcp_calls: recentMcpCalls,
        recent_cooperative_log: recentCooperativeLog,
        recent_channel_events: recentChannelEvents.slice(0, 15).map((event) => ({
          ...event,
          lifecycle: summarizeAgentChannelLifecycle(event),
        })),
        activity,
      },
      mcp_endpoint_url: mcpEndpointUrl(),
      mcp_token_masked: employee.mcp_token_hash ? '********' : null,
      mcp_token: null,
      channel_endpoint_url: agentChannelEndpointUrl(),
      channel_token_masked: activeChannelToken ? `${activeChannelToken.token_prefix}********` : null,
      channel_token: null,
      channel: {
        protocol_version: AGENT_CHANNEL_PROTOCOL_VERSION,
        connection: channelConnection ?? null,
        token: activeChannelToken ?? null,
        queue: {
          pending: channelQueue.pending ?? 0,
          delivered: channelQueue.delivered ?? 0,
          acknowledged: channelQueue.acknowledged ?? 0,
          running: channelQueue.running ?? 0,
          approval_pending: channelQueue.approval_pending ?? 0,
          completed: channelQueue.completed ?? 0,
          failed: channelQueue.failed ?? 0,
          cancelled: channelQueue.cancelled ?? 0,
        },
        metrics: summarizeAgentChannelMetrics(recentChannelEvents),
        recovery: describeAgentRuntimeRecovery({
          hasChannelToken: Boolean(activeChannelToken),
          connectionStatus: channelConnection?.status,
          lastSeenAt: channelConnection?.last_seen_at,
          failedDeliveries: channelQueue.failed ?? 0,
          pendingDeliveries: channelQueue.pending ?? 0,
          certificationStatus: employee.certification_status,
        }),
      },
    });
  } catch (err) {
    console.error('Failed to fetch developer credentials:', err);
    return c.json({ error: 'Failed', code: 'INTERNAL_ERROR' }, 500);
  }
});

// ─── Block 3.1 — POST /:id/clone  → duplicates an employee ────────────
agentEmployeeRoutes.post('/:id/channel-test/start', async (c) => {
  try {
    const authorizationError = await requireOwnerOrAdmin(c);
    if (authorizationError) return authorizationError;

    const user = c.get('user');
    const id = c.req.param('id');

    const [employee] = await db
      .select()
      .from(agentEmployees)
      .where(and(eq(agentEmployees.id, id), eq(agentEmployees.org_id, user.org_id)))
      .limit(1);
    if (!employee) return c.json({ error: 'Agent employee not found', code: 'NOT_FOUND' }, 404);

    const nonce = `deft-channel-${employee.slug}-${crypto.randomBytes(4).toString('hex')}`;
    const { event, created } = await publishAgentChannelEvent({
      orgId: user.org_id,
      employeeId: employee.id,
      kind: 'certification.challenge',
      sourceKind: 'certification',
      sourceId: id,
      actorUserId: user.id,
      idempotencyKey: `channel-certification:${nonce}`,
      payload: {
        nonce,
        employee_slug: employee.slug,
        instruction: 'Acknowledge this event, then reply through /api/agent-channel/v1/reply with the nonce in the message.',
        expected_reply_contains: nonce,
      },
    });

    return c.json({
      ok: true,
      created,
      event,
      nonce,
      channel_endpoint_url: agentChannelEndpointUrl(),
      instructions: [
        `Connect with Authorization: Bearer <channel-token> at ${agentChannelEndpointUrl()}.`,
        'GET /events to receive this challenge.',
        `POST /ack with event_id ${event?.id ?? '<event-id>'}.`,
        `POST /reply with the same event_id and content containing ${nonce}.`,
      ],
    }, 201);
  } catch (err) {
    console.error('Failed to start channel test:', err);
    return c.json({ error: 'Failed to start channel test', code: 'INTERNAL_ERROR' }, 500);
  }
});

agentEmployeeRoutes.post('/:id/certification/start', async (c) => {
  try {
    const authorizationError = await requireOwnerOrAdmin(c);
    if (authorizationError) return authorizationError;

    const user = c.get('user');
    const id = c.req.param('id');

    const [employee] = await db
      .select()
      .from(agentEmployees)
      .where(and(eq(agentEmployees.id, id), eq(agentEmployees.org_id, user.org_id)))
      .limit(1);
    if (!employee) return c.json({ error: 'Agent employee not found', code: 'NOT_FOUND' }, 404);

    const preflightInput = onboardingPreflightSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!preflightInput.success) {
      return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR', details: preflightInput.error.flatten() }, 400);
    }
    const preflight = runtimeKindOf(employee) === 'hermes'
      ? await loadAgentOnboardingPreflight(user.org_id, employee, preflightInput.data)
      : null;
    if (preflight && !preflight.ready) {
      return c.json({
        error: 'Hermes onboarding preflight failed. Resolve the failed checks before certification.',
        code: 'ONBOARDING_PREFLIGHT_FAILED',
        preflight,
      }, 409);
    }
    const [currentConnection] = await db.select({ metadata: agentChannelConnections.metadata })
      .from(agentChannelConnections)
      .where(and(eq(agentChannelConnections.agent_employee_id, employee.id), eq(agentChannelConnections.org_id, user.org_id)))
      .limit(1);
    const connectionMetadata = currentConnection?.metadata && typeof currentConnection.metadata === 'object'
      ? currentConnection.metadata as Record<string, unknown>
      : {};
    const baselineRestartCount = Number.isInteger(connectionMetadata.restart_count)
      ? Number(connectionMetadata.restart_count)
      : 0;

    await cancelPendingCertification(user.org_id, employee.id, 'Superseded by a new certification challenge');
    const nonce = `deft-cert-${employee.slug}-${crypto.randomBytes(6).toString('hex')}`;
    const [challenge] = await db
      .insert(agentCertificationChallenges)
      .values({
        org_id: user.org_id,
        employee_id: employee.id,
        nonce,
        required_tools: [...CERTIFICATION_REQUIRED_TOOLS],
        status: 'pending',
      })
      .returning();
    if (!challenge) throw new Error('Certification challenge insert returned no row');

    await ensureAgentConversationSpace({
      orgId: user.org_id,
      userId: user.id,
      agentUserId: employee.user_id,
      conversationId: challenge.id,
      title: `${employee.name} onboarding check`,
    });
    const { event: channelEvent } = await publishAgentChannelEvent({
      orgId: user.org_id,
      employeeId: employee.id,
      kind: 'certification.challenge',
      sourceKind: 'certification',
      sourceId: challenge.id,
      spaceId: challenge.id,
      actorUserId: user.id,
      idempotencyKey: `employee-certification:${challenge.id}`,
      payload: {
        nonce,
        employee_slug: employee.slug,
        is_dm: true,
        parent_id: null,
        certification_prompt: buildCertificationPrompt(employee, nonce),
        expected_reply_contains: nonce,
        onboarding_requirements: preflightInput.data,
        baseline_restart_count: baselineRestartCount,
      },
    });

    await db
      .update(agentEmployees)
      .set({ certification_status: 'challenge_issued' })
      .where(and(eq(agentEmployees.id, employee.id), eq(agentEmployees.org_id, user.org_id)));

    return c.json({
      challenge,
      channel_event: channelEvent,
      conversation_id: challenge.id,
      instructions: certificationInstructions(employee, nonce),
      runtime_setup: buildRuntimeSetup(employee, nonce),
      preflight,
      mcp_endpoint_url: mcpEndpointUrl(),
    }, 201);
  } catch (err) {
    console.error('Failed to start agent certification:', err);
    return c.json({ error: 'Failed to start certification', code: 'INTERNAL_ERROR' }, 500);
  }
});

agentEmployeeRoutes.get('/:id/certification', async (c) => {
  try {
    const authorizationError = await requireOwnerOrAdmin(c);
    if (authorizationError) return authorizationError;

    const user = c.get('user');
    const id = c.req.param('id');

    const [employee] = await db
      .select()
      .from(agentEmployees)
      .where(and(eq(agentEmployees.id, id), eq(agentEmployees.org_id, user.org_id)))
      .limit(1);
    if (!employee) return c.json({ error: 'Agent employee not found', code: 'NOT_FOUND' }, 404);

    const [challenge] = await db
      .select()
      .from(agentCertificationChallenges)
      .where(and(eq(agentCertificationChallenges.employee_id, id), eq(agentCertificationChallenges.org_id, user.org_id)))
      .orderBy(desc(agentCertificationChallenges.created_at))
      .limit(1);

    const challengeEvidence = challenge
      ? await loadCertificationChallengeEvidence({
          orgId: user.org_id,
          employeeId: id,
          runtimeKind: employee.runtime_kind,
          challenge,
        })
      : null;

    return c.json({
      employee: {
        id: employee.id,
        slug: employee.slug,
        runtime_kind: employee.runtime_kind,
        certification_status: employee.certification_status,
        last_verified_at: employee.last_verified_at,
        last_mcp_call_at: employee.last_mcp_call_at,
      },
      challenge: challenge
        ? {
            ...challenge,
            status: challengeEvidence?.completed
              ? 'completed'
              : challenge.status === 'completed' ? 'pending' : challenge.status,
            completed_at: challengeEvidence?.completed ? challenge.completed_at : null,
            instructions: certificationInstructions(employee, challenge.nonce),
            stages: buildCertificationStages({
              employee,
              missingTools: challengeEvidence?.missingTools ?? challenge.required_tools,
              nonceSeen: challengeEvidence?.nonceSeen ?? false,
              auditCount: challengeEvidence?.auditCount ?? 0,
              privateMemoryVerified: challengeEvidence?.privateMemoryVerified ?? false,
              channelEventSeen: challengeEvidence?.channelEventSeen ?? false,
              channelCompleted: challengeEvidence?.channelCompleted ?? false,
              channelReplyNonceSeen: challengeEvidence?.channelReplyNonceSeen ?? false,
              singleDelivery: challengeEvidence?.singleDelivery ?? false,
              singleReply: challengeEvidence?.singleReply ?? false,
              runtimeSessionSeen: challengeEvidence?.runtimeSessionSeen ?? false,
              runtimeExecutionSeen: challengeEvidence?.runtimeExecutionSeen ?? false,
              runtimeExecutionProof: challengeEvidence?.runtimeExecutionProof ?? null,
              restartDetected: challengeEvidence?.restartDetected ?? false,
              restartProofCompleted: challengeEvidence?.restartProofCompleted ?? false,
              completed: challengeEvidence?.completed ?? false,
            }),
          }
        : null,
      runtime_setup: buildRuntimeSetup(employee, challenge?.nonce ?? null),
    });
  } catch (err) {
    console.error('Failed to fetch agent certification:', err);
    return c.json({ error: 'Failed to fetch certification', code: 'INTERNAL_ERROR' }, 500);
  }
});

agentEmployeeRoutes.post('/:id/certification/check', async (c) => {
  try {
    const authorizationError = await requireOwnerOrAdmin(c);
    if (authorizationError) return authorizationError;

    const user = c.get('user');
    const id = c.req.param('id');

    const [employee] = await db
      .select()
      .from(agentEmployees)
      .where(and(eq(agentEmployees.id, id), eq(agentEmployees.org_id, user.org_id)))
      .limit(1);
    if (!employee) return c.json({ error: 'Agent employee not found', code: 'NOT_FOUND' }, 404);

    const [challenge] = await db
      .select()
      .from(agentCertificationChallenges)
      .where(and(eq(agentCertificationChallenges.employee_id, id), eq(agentCertificationChallenges.org_id, user.org_id)))
      .orderBy(desc(agentCertificationChallenges.created_at))
      .limit(1);
    if (!challenge) {
      return c.json({ error: 'No certification challenge has been started', code: 'NO_CHALLENGE' }, 404);
    }

    const challengeEvidence = await loadCertificationChallengeEvidence({
      orgId: user.org_id,
      employeeId: id,
      runtimeKind: employee.runtime_kind,
      challenge,
    });
    const {
      seenTools,
      missingTools,
      nonceSeen: nonce_seen,
      auditCount,
      privateMemoryVerified,
      channelEventSeen,
      channelCompleted,
      channelReplyNonceSeen,
      singleDelivery,
      singleReply,
      runtimeSessionSeen,
      runtimeExecutionSeen,
      runtimeExecutionProof,
      baseCompleted,
      restartDetected,
      restartProofEventSeen,
      restartProofPingSeen,
      restartProofNonceSeen,
      restartProofReplyNonceSeen,
      restartProofSingleReply,
      restartExecutionProof,
      restartProofCompleted,
      completed,
    } = challengeEvidence;
    if (baseCompleted && restartDetected && !restartProofEventSeen) {
      await publishAgentChannelEvent({
        orgId: user.org_id,
        employeeId: employee.id,
        kind: 'certification.restart_proof',
        sourceKind: 'certification',
        sourceId: challenge.id,
        spaceId: challenge.id,
        actorUserId: user.id,
        idempotencyKey: `employee-certification-restart:${challenge.id}`,
        payload: {
          nonce: challenge.nonce,
          employee_slug: employee.slug,
          is_dm: true,
          parent_id: null,
          certification_prompt: `This is the post-restart persistence check. Process this fresh assignment, call mcp_deft_ping_alive, record a decision containing the exact nonce ${challenge.nonce}, and reply with that exact nonce.`,
          expected_reply_contains: challenge.nonce,
        },
      });
    }
    const stages = buildCertificationStages({
      employee,
      missingTools,
      nonceSeen: nonce_seen,
      auditCount,
      privateMemoryVerified,
      channelEventSeen,
      channelCompleted,
      channelReplyNonceSeen,
      singleDelivery,
      singleReply,
      runtimeSessionSeen,
      runtimeExecutionSeen,
      runtimeExecutionProof,
      restartDetected,
      restartProofCompleted,
      completed,
    });
    const failureReason = certificationFailureReason({
      employee,
      missingTools,
      nonceSeen: nonce_seen,
      auditCount,
      privateMemoryVerified,
      channelEventSeen,
      channelCompleted,
      channelReplyNonceSeen,
      singleDelivery,
      singleReply,
      runtimeSessionSeen,
      runtimeExecutionSeen,
      restartDetected,
      restartProofCompleted,
    });

    if (completed && challenge.status !== 'completed') {
      const now = new Date();
      const [completedChallenge] = await db
        .update(agentCertificationChallenges)
        .set({ status: 'completed', completed_at: now, failure_reason: null, updated_at: now })
        .where(and(
          eq(agentCertificationChallenges.id, challenge.id),
          eq(agentCertificationChallenges.org_id, user.org_id),
          eq(agentCertificationChallenges.status, 'pending'),
        ))
        .returning({ id: agentCertificationChallenges.id });
      if (completedChallenge) {
        await db
          .update(agentEmployees)
          .set({ certification_status: 'verified', last_verified_at: now })
          .where(and(eq(agentEmployees.id, id), eq(agentEmployees.org_id, user.org_id)));
      }
    } else if (!completed) {
      const now = new Date();
      await db
        .update(agentCertificationChallenges)
        .set({
          status: challenge.status === 'completed' ? 'pending' : challenge.status,
          completed_at: challenge.status === 'completed' ? null : challenge.completed_at,
          failure_reason: failureReason,
          updated_at: now,
        })
        .where(and(
          eq(agentCertificationChallenges.id, challenge.id),
          eq(agentCertificationChallenges.org_id, user.org_id),
        ));
      if (challenge.status === 'completed') {
        await db
          .update(agentEmployees)
          .set({ certification_status: 'challenge_issued', last_verified_at: null, updated_at: now })
          .where(and(eq(agentEmployees.id, id), eq(agentEmployees.org_id, user.org_id)));
      }
    }

    return c.json({
      status: completed ? 'completed' : 'pending',
      completed,
      missing_tools: missingTools,
      nonce_seen,
      channel_event_seen: channelEventSeen,
      channel_completed: channelCompleted,
      channel_reply_nonce_seen: channelReplyNonceSeen,
      single_delivery: singleDelivery,
      single_reply: singleReply,
      runtime_session_seen: runtimeSessionSeen,
      runtime_execution_seen: runtimeExecutionSeen,
      runtime_execution_proof: runtimeExecutionProof,
      private_memory_verified: privateMemoryVerified,
      restart_detected: restartDetected,
      restart_proof_event_seen: restartProofEventSeen,
      restart_proof_ping_seen: restartProofPingSeen,
      restart_proof_nonce_seen: restartProofNonceSeen,
      restart_proof_reply_nonce_seen: restartProofReplyNonceSeen,
      restart_proof_single_reply: restartProofSingleReply,
      restart_execution_proof: restartExecutionProof,
      restart_proof_completed: restartProofCompleted,
      seen_tools: Array.from(seenTools),
      required_tools: challenge.required_tools,
      instructions: certificationInstructions(employee, challenge.nonce),
      stages,
      failure_reason: failureReason,
      runtime_setup: buildRuntimeSetup(employee, challenge.nonce),
    });
  } catch (err) {
    console.error('Failed to check agent certification:', err);
    return c.json({ error: 'Failed to check certification', code: 'INTERNAL_ERROR' }, 500);
  }
});

agentEmployeeRoutes.post('/:id/certification/reset', async (c) => {
  try {
    const authorizationError = await requireOwnerOrAdmin(c);
    if (authorizationError) return authorizationError;

    const user = c.get('user');
    const id = c.req.param('id');

    const [employee] = await db
      .select()
      .from(agentEmployees)
      .where(and(eq(agentEmployees.id, id), eq(agentEmployees.org_id, user.org_id)))
      .limit(1);
    if (!employee) return c.json({ error: 'Agent employee not found', code: 'NOT_FOUND' }, 404);

    await cancelPendingCertification(user.org_id, id, 'Reset by operator');
    await db
      .update(agentEmployees)
      .set({ certification_status: employee.last_mcp_call_at ? 'mcp_reachable' : 'token_issued' })
      .where(and(eq(agentEmployees.id, id), eq(agentEmployees.org_id, user.org_id)));

    return c.json({ ok: true });
  } catch (err) {
    console.error('Failed to reset agent certification:', err);
    return c.json({ error: 'Failed to reset certification', code: 'INTERNAL_ERROR' }, 500);
  }
});

agentEmployeeRoutes.post('/:id/regenerate-token', async (c) => {
  try {
    const authorizationError = await requireOwnerOrAdmin(c);
    if (authorizationError) return authorizationError;

    const user = c.get('user');
    const id = c.req.param('id');

    const [employee] = await db
      .select()
      .from(agentEmployees)
      .where(and(eq(agentEmployees.id, id), eq(agentEmployees.org_id, user.org_id)))
      .limit(1);
    if (!employee) return c.json({ error: 'Agent employee not found', code: 'NOT_FOUND' }, 404);

    const rawApiKey = await issueMcpToken({
      orgId: user.org_id,
      employeeId: employee.id,
      employeeName: employee.name,
      createdBy: user.id,
      deactivateExisting: true,
    });

    return c.json({
      employee: {
        id: employee.id,
        slug: employee.slug,
        name: employee.name,
      },
      mcp_endpoint_url: mcpEndpointUrl(),
      api_key: rawApiKey,
    });
  } catch (err) {
    console.error('Failed to regenerate agent employee token:', err);
    return c.json({ error: 'Failed to regenerate token', code: 'INTERNAL_ERROR' }, 500);
  }
});

agentEmployeeRoutes.post('/:id/regenerate-channel-token', async (c) => {
  try {
    const authorizationError = await requireOwnerOrAdmin(c);
    if (authorizationError) return authorizationError;

    const user = c.get('user');
    const id = c.req.param('id');

    const [employee] = await db
      .select()
      .from(agentEmployees)
      .where(and(eq(agentEmployees.id, id), eq(agentEmployees.org_id, user.org_id)))
      .limit(1);
    if (!employee) return c.json({ error: 'Agent employee not found', code: 'NOT_FOUND' }, 404);

    const channelToken = await issueAgentChannelToken({
      orgId: user.org_id,
      employeeId: employee.id,
      employeeName: employee.name,
      createdBy: user.id,
      deactivateExisting: true,
    });

    return c.json({
      employee: {
        id: employee.id,
        slug: employee.slug,
        name: employee.name,
      },
      channel_endpoint_url: agentChannelEndpointUrl(),
      channel_key: channelToken.raw,
      channel_token_prefix: channelToken.prefix,
    });
  } catch (err) {
    console.error('Failed to regenerate agent employee channel token:', err);
    return c.json({ error: 'Failed to regenerate channel token', code: 'INTERNAL_ERROR' }, 500);
  }
});

agentEmployeeRoutes.post('/:id/clone', async (c) => {
  try {
    const authorizationError = await requireOwnerOrAdmin(c);
    if (authorizationError) return authorizationError;

    const user = c.get('user');
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const cloneSchema = z.object({
      name: z.string().min(1).max(200).optional(),
      slug: z.string().min(2).max(64).regex(/^[a-z0-9-]+$/).refine(
        (slug) => !isReservedDeftyEmployeeSlug(slug),
        { message: 'defty-system is reserved for Deft internal use' },
      ).optional(),
    });
    const parsed = cloneSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR', details: parsed.error.flatten() }, 400);
    }

    const [source] = await db
      .select()
      .from(agentEmployees)
      .where(and(eq(agentEmployees.id, id), eq(agentEmployees.org_id, user.org_id)))
      .limit(1);
    if (
      !source
      || isReservedDeftyEmployeeSlug(source.slug)
      || isReservedDeftyRuntimeKind(source.runtime_kind)
    ) {
      return c.json({ error: 'Agent employee not found', code: 'NOT_FOUND' }, 404);
    }

    // Build a fresh slug: caller override → sourceSlug-copy → -copy-2, etc.
    let candidate = parsed.data.slug ?? `${source.slug}-copy`;
    let attempt = 1;
    while (attempt < 50) {
      const [exists] = await db
        .select({ id: agentEmployees.id })
        .from(agentEmployees)
        .where(and(eq(agentEmployees.org_id, user.org_id), eq(agentEmployees.slug, candidate)))
        .limit(1);
      if (!exists) break;
      attempt += 1;
      candidate = `${source.slug}-copy-${attempt}`;
    }

    const newId = crypto.randomUUID();
    const newName = parsed.data.name ?? `${source.name} (copy)`;
    const [inserted] = await db
      .insert(agentEmployees)
      .values({
        id: newId,
        org_id: source.org_id,
        user_id: source.user_id,
        name: newName,
        slug: candidate,
        role: source.role,
        runtime_kind: source.runtime_kind,
        is_byoa: true,
        job_title: source.job_title,
        wake_mode: source.wake_mode,
        avatar_url: source.avatar_url,
        system_prompt: source.system_prompt,
        expertise_description: source.expertise_description,
        connection_notes: source.connection_notes,
        starter_prompts: source.starter_prompts,
        trust_level: source.trust_level,
        max_daily_actions: source.max_daily_actions,
        heartbeat_enabled: source.heartbeat_enabled,
        heartbeat_interval_min: source.heartbeat_interval_min,
        heartbeat_config: source.heartbeat_config,
        daily_budget_cents: source.daily_budget_cents,
        trigger_subscriptions: source.trigger_subscriptions,
        // capability_packs column dropped (PR 4 C); not carried into the clone.
        created_by: user.id,
        // Intentionally NOT cloned: mcp_token_hash, daily_action_count/cost,
        // last_heartbeat_at. The clone is a fresh employee — its MCP token
        // must be issued separately.
      })
      .returning();

    // Copy installed skills
    const sourceSkills = await db
      .select()
      .from(agentEmployeeSkills)
      .where(eq(agentEmployeeSkills.agent_employee_id, id));
    if (sourceSkills.length > 0) {
      await db.insert(agentEmployeeSkills).values(
        sourceSkills.map((s) => ({
          agent_employee_id: newId,
          skill_id: s.skill_id,
          installed_version: s.installed_version,
        })),
      );
    }

    return c.json({ employee: inserted, cloned_from: id }, 201);
  } catch (err) {
    console.error('Failed to clone agent employee:', err);
    return c.json({ error: 'Failed to clone', code: 'INTERNAL_ERROR' }, 500);
  }
});

// ─── Block 3.1 — POST /:id/save-as-template  ──────────────────────────
// Creates an agent_employee_templates row scoped to the caller's org.
// The wizard step 1 already queries templates; this just gives orgs a
// way to contribute their own entries.
agentEmployeeRoutes.post('/:id/save-as-template', async (c) => {
  try {
    const user = c.get('user');
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const saveSchema = z.object({
      slug: z.string().min(2).max(64).regex(/^[a-z0-9-]+$/),
      name: z.string().min(1).max(200),
      description: z.string().min(1).max(1000),
      version: z.string().regex(/^\d+\.\d+\.\d+$/).default('1.0.0'),
    });
    const parsed = saveSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR', details: parsed.error.flatten() }, 400);
    }

    const [source] = await db
      .select()
      .from(agentEmployees)
      .where(and(eq(agentEmployees.id, id), eq(agentEmployees.org_id, user.org_id)))
      .limit(1);
    if (!source) return c.json({ error: 'Agent employee not found', code: 'NOT_FOUND' }, 404);

    // Pull linked skills for defaults
    const joined = await db
      .select({ slug: skills.slug })
      .from(agentEmployeeSkills)
      .innerJoin(skills, eq(skills.id, agentEmployeeSkills.skill_id))
      .where(eq(agentEmployeeSkills.agent_employee_id, id));

    const templateId = crypto.randomUUID();
    try {
      const [inserted] = await db
        .insert(agentEmployeeTemplates)
        .values({
          id: templateId,
          org_id: user.org_id,
          slug: parsed.data.slug,
          name: parsed.data.name,
          description: parsed.data.description,
          version: parsed.data.version,
          role: source.role,
          // Bootstrap markdown: minimal stubs so the wizard can instantiate.
          soul_md: `# ${parsed.data.name}\n\n${source.system_prompt ?? ''}`,
          agents_md: '# AGENTS\nCall deft_platform_context first.',
          user_md_template: `# USER\nOrg: {{org_name}}`,
          tools_md: '# TOOLS',
          default_tools: [],
          // capability_packs column dropped (PR 4 C); templates start with no
          // pre-set packs — the wizard lets the user configure them post-save.
          default_capability_packs: [],
          default_trust_level: source.trust_level,
          default_trigger_subscriptions: source.trigger_subscriptions ?? [],
          model_recommendation: 'anthropic/claude-sonnet-4-6',
          source: 'user',
          source_attribution: `Saved by ${user.email ?? user.id} from employee ${source.slug}`,
          is_public: false,
          created_by: user.id,
        })
        .returning();

      return c.json({ template: inserted, source_employee_id: id, linked_skill_slugs: joined.map((j) => j.slug) }, 201);
    } catch (err) {
      const pgCode = (err as any)?.code ?? (err as any)?.cause?.code;
      if (pgCode === '23505') {
        return c.json({ error: 'A template with this slug already exists in your org', code: 'DUPLICATE_SLUG' }, 409);
      }
      throw err;
    }
  } catch (err) {
    console.error('Failed to save as template:', err);
    return c.json({ error: 'Failed to save as template', code: 'INTERNAL_ERROR' }, 500);
  }
});

