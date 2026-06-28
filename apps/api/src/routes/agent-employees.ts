import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, desc, sql, or, isNull, asc, gte } from 'drizzle-orm';
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
  agentChannelEvents,
  agentChannelTokens,
} from '@deft/db/schema';
import type { SkillAgentConfig } from '../lib/skill-config.js';
import {
  AGENT_CHANNEL_PROTOCOL_VERSION,
  issueAgentChannelToken,
  publishAgentChannelEvent,
} from '../lib/agent-channel.js';
import { markWorkIntentsExpiredForActions } from '../lib/work-intents.js';

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

const createSchema = z.object({
  name: z.string().min(1).max(100),
  role: z.enum(AGENT_EMPLOYEE_ROLES),
  runtime_kind: z.string().min(1).max(64).optional(),
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
  let candidate = base;
  let attempt = 1;

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

function agentChannelEndpointUrl(): string {
  const apiBase =
    process.env.PUBLIC_API_BASE_URL ??
    process.env.NEXT_PUBLIC_API_URL ??
    process.env.API_BASE_URL ??
    'http://localhost:3001';
  return `${apiBase.replace(/\/$/, '')}/api/agent-channel/v1`;
}

const CERTIFICATION_REQUIRED_TOOLS = [
  'platform_context',
  'task_query',
  'ping_alive',
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

function runtimeKindOf(employee: { runtime_kind?: string | null }): string {
  return employee.runtime_kind || 'custom_mcp';
}

function runtimeToolName(runtimeKind: string, tool: string): string {
  return runtimeKind === 'hermes' ? `mcp_deft_${tool}` : tool;
}

function hermesBridgeScript(): string {
  return `#!/usr/bin/env node
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
  const taskCreate = runtimeToolName(runtimeKind, 'task_create');
  const prefixNote = runtimeKind === 'hermes'
    ? 'Hermes exposes Deft MCP tools to the model as mcp_deft_<tool>, so use the exact names below.'
    : 'Use the Deft MCP tools below.';

  return [
    `You are ${employee.name}, a BYOA employee in Deft.`,
    prefixNote,
    `Use caller_employee_slug exactly as "${employee.slug}" on every Deft MCP tool call.`,
    `Call these tools now: ${toolNames.join(', ')}.`,
    `Include this exact certification nonce in record_conversation_turn and record_decision: ${nonce}.`,
    `If ${taskCreate} is available, create one small useful task for the organization after certification.`,
    'Finish with a short natural-language summary. Do not prefix every future message with your own name.',
  ].join('\n');
}

function buildRuntimeSetup(
  employee: { name: string; slug: string; runtime_kind?: string | null },
  nonce: string | null,
): RuntimeSetup {
  const runtimeKind = runtimeKindOf(employee);
  const endpoint = mcpEndpointUrl();
  const channelEndpoint = agentChannelEndpointUrl();
  const certificationPrompt = buildCertificationPrompt(employee, nonce ?? '<challenge-nonce>');

  if (runtimeKind === 'hermes') {
    return {
      runtime_kind: runtimeKind,
      tool_server_name: 'deft',
      channel_protocol_version: AGENT_CHANNEL_PROTOCOL_VERSION,
      mcp_endpoint_url: endpoint,
      channel_endpoint_url: channelEndpoint,
      tool_name_style: 'server_prefixed',
      tool_call_names: CERTIFICATION_REQUIRED_TOOLS.map((tool) => runtimeToolName(runtimeKind, tool)),
      setup_steps: [
        'Save the Deft stdio bridge as deft-mcp-stdio.mjs on the machine where Hermes runs.',
        'Add the mcp_servers.deft block to the active Hermes config.yaml.',
        'Restart or reload Hermes so the MCP server is discovered.',
        'Run hermes mcp test deft and verify Deft reports the Deft MCP tool list.',
        'Configure the Deft Agent Channel endpoint with DEFT_CHANNEL_URL and DEFT_CHANNEL_TOKEN so Deft messages wake Hermes.',
        'Run a Hermes chat prompt that uses the model-visible mcp_deft_<tool> names.',
        'Use mcp_deft_memory_recall for Deft wiki context; mcp_deft_wiki_search is accepted as a compatibility alias.',
      ],
      commands: [
        {
          label: 'List configured MCP servers',
          command: 'hermes mcp list',
          description: 'Confirms the deft server is configured and enabled.',
        },
        {
          label: 'Test Deft MCP discovery',
          command: 'hermes mcp test deft',
          description: 'Confirms Hermes can initialize the bridge and discover Deft tools.',
        },
        {
          label: 'Verify enabled tools',
          command: 'hermes tools list',
          description: 'Confirms the deft MCP tools are enabled for the CLI platform.',
        },
        {
          label: 'Run certification prompt',
          command: `hermes chat -q "${certificationPrompt.replace(/"/g, '\\"')}" --cli --max-turns 20`,
          description: 'Confirms the Hermes model loop can call Deft tools, not just discover them.',
        },
      ],
      config_snippet: [
        'mcp_servers:',
        '  deft:',
        '    command: node',
        '    args:',
        '      - /absolute/path/to/deft-mcp-stdio.mjs',
        '    env:',
        `      DEFT_MCP_URL: ${endpoint}`,
        '      DEFT_MCP_TOKEN: <bearer-token>',
        `      DEFT_CHANNEL_URL: ${channelEndpoint}`,
        '      DEFT_CHANNEL_TOKEN: <channel-token>',
        '    connect_timeout: 60',
        '    timeout: 120',
      ].join('\n'),
      bridge_script: hermesBridgeScript(),
      certification_prompt: certificationPrompt,
      troubleshooting: [
        'If hermes mcp test deft passes but certification is pending, the model loop has not called Deft tools yet.',
        'Hermes tools/list may describe tools as deft:<tool>, but the model-visible tools are named mcp_deft_<tool>.',
        'Use names such as mcp_deft_ping_alive in the prompt; bare names may be ignored by Hermes.',
        'Use mcp_deft_memory_recall for wiki context; mcp_deft_wiki_search exists only for compatibility with older/native wording.',
        'If Hermes exits before tool calls with a provider/auth error, fix Hermes model credentials first.',
        'Avoid passing a toolset override that disables MCP tools for the run.',
      ],
    };
  }

  return {
    runtime_kind: runtimeKind,
    tool_server_name: null,
    channel_protocol_version: AGENT_CHANNEL_PROTOCOL_VERSION,
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
    'For task_query, search for any active task or request a small list. Do not mutate task state during certification.',
    `For ping_alive, identify yourself naturally as ${employee.name}; do not prefix every future chat message with your name.`,
    ...setup.troubleshooting.map((line) => `Troubleshooting: ${line}`),
  ].join('\n');
}

function buildCertificationStages(params: {
  employee: { certification_status?: string | null; last_mcp_call_at?: Date | string | null; runtime_kind?: string | null };
  missingTools: string[];
  nonceSeen: boolean;
  auditCount: number;
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
          ? 'Run hermes mcp test deft after adding the Deft bridge.'
          : 'Connect the runtime to the Deft MCP endpoint.',
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
}): string | null {
  if (params.missingTools.length === 0 && params.nonceSeen) return null;
  const runtimeKind = runtimeKindOf(params.employee);
  const mcpReachable = params.auditCount > 0 || Boolean(params.employee.last_mcp_call_at);
  if (!mcpReachable) {
    return runtimeKind === 'hermes'
      ? 'Hermes has not reached Deft MCP yet. Run `hermes mcp test deft` and check the bridge config.'
      : 'The runtime has not reached Deft MCP yet.';
  }
  if (params.missingTools.length > 0) {
    return runtimeKind === 'hermes'
      ? `Hermes can reach Deft MCP, but its model loop has not called: ${params.missingTools.map((tool) => runtimeToolName('hermes', tool)).join(', ')}. Check model auth and use the mcp_deft_* tool names.`
      : `The runtime has not called: ${params.missingTools.join(', ')}.`;
  }
  return 'Required tools were called, but the challenge nonce was not recorded in the cooperative log.';
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

agentEmployeeRoutes.post('/', async (c) => {
  try {
    const currentUser = c.get('user');
    const body = await c.req.json();
    const parsed = createSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR', details: parsed.error.flatten() }, 400);
    }

    const data = parsed.data;

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
  runtime_kind: z.string().min(1).max(64).optional(),
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

    // Expire pending agent actions
    const expiredActions = await db
      .update(agentActions)
      .set({ approval_status: 'expired' })
      .where(
        and(
          eq(agentActions.org_id, user.org_id),
          eq(agentActions.agent_employee_id, id),
          eq(agentActions.approval_status, 'pending'),
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

// The legacy retry-provision endpoint and the agents.files.* RPC routes
// were removed in the v1 self-hosted reframe. All agents are BYOA —
// operators run them on their own infra and Deft does not control the
// agent's filesystem. A Defty-specific settings page (Defty's SOUL.md
// lives inside Deft) can come back as its own focused feature if needed.

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
        error: agentChannelEvents.error,
        created_at: agentChannelEvents.created_at,
        updated_at: agentChannelEvents.updated_at,
      })
      .from(agentChannelEvents)
      .where(and(eq(agentChannelEvents.agent_employee_id, id), eq(agentChannelEvents.org_id, user.org_id)))
      .orderBy(desc(agentChannelEvents.created_at))
      .limit(15);

    const challengeStartedAt = latestChallenge?.started_at ? new Date(latestChallenge.started_at) : null;
    const challengeCalls = challengeStartedAt
      ? recentMcpCalls.filter((call) => call.success && new Date(call.created_at) >= challengeStartedAt)
      : [];
    const seenTools = new Set(challengeCalls.map((call) => call.tool_name));
    const missingTools = latestChallenge
      ? latestChallenge.required_tools.filter((tool) => !seenTools.has(tool))
      : [];
    const nonceSeen = latestChallenge
      ? recentCooperativeLog.some((row) => {
          if (challengeStartedAt && new Date(row.created_at) < challengeStartedAt) return false;
          return row.summary.includes(latestChallenge.nonce)
            || JSON.stringify(row.metadata ?? {}).includes(latestChallenge.nonce);
        })
      : false;
    const completed = latestChallenge?.status === 'completed' || (latestChallenge ? missingTools.length === 0 && nonceSeen : false);

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
            status: latestChallenge.status,
            nonce: latestChallenge.nonce,
            required_tools: latestChallenge.required_tools,
            failure_reason: latestChallenge.failure_reason,
            started_at: latestChallenge.started_at,
            completed_at: latestChallenge.completed_at,
            instructions: certificationInstructions(employee, latestChallenge.nonce),
            stages: buildCertificationStages({
              employee,
              missingTools,
              nonceSeen,
              auditCount: challengeCalls.length,
              completed,
            }),
          }
        : null,
      runtime_setup: buildRuntimeSetup(employee, latestChallenge?.nonce ?? null),
      diagnostics: {
        recent_mcp_calls: recentMcpCalls,
        recent_cooperative_log: recentCooperativeLog,
        recent_channel_events: recentChannelEvents,
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
          completed: channelQueue.completed ?? 0,
          failed: channelQueue.failed ?? 0,
        },
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
    const user = c.get('user');
    const id = c.req.param('id');

    const [employee] = await db
      .select()
      .from(agentEmployees)
      .where(and(eq(agentEmployees.id, id), eq(agentEmployees.org_id, user.org_id)))
      .limit(1);
    if (!employee) return c.json({ error: 'Agent employee not found', code: 'NOT_FOUND' }, 404);

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

    await db
      .update(agentEmployees)
      .set({ certification_status: 'challenge_issued' })
      .where(and(eq(agentEmployees.id, employee.id), eq(agentEmployees.org_id, user.org_id)));

    return c.json({
      challenge,
      instructions: certificationInstructions(employee, nonce),
      runtime_setup: buildRuntimeSetup(employee, nonce),
      mcp_endpoint_url: mcpEndpointUrl(),
    }, 201);
  } catch (err) {
    console.error('Failed to start agent certification:', err);
    return c.json({ error: 'Failed to start certification', code: 'INTERNAL_ERROR' }, 500);
  }
});

agentEmployeeRoutes.get('/:id/certification', async (c) => {
  try {
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
            instructions: certificationInstructions(employee, challenge.nonce),
            stages: buildCertificationStages({
              employee,
              missingTools: challenge.required_tools,
              nonceSeen: false,
              auditCount: employee.last_mcp_call_at ? 1 : 0,
              completed: challenge.status === 'completed',
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

    const auditRows = await db
      .select({
        tool_name: agentMcpCallAudit.tool_name,
        created_at: agentMcpCallAudit.created_at,
      })
      .from(agentMcpCallAudit)
      .where(and(
        eq(agentMcpCallAudit.org_id, user.org_id),
        eq(agentMcpCallAudit.employee_id, id),
        eq(agentMcpCallAudit.success, true),
        gte(agentMcpCallAudit.created_at, challenge.started_at),
      ));
    const seenTools = new Set(auditRows.map((row) => row.tool_name));
    const missingTools = challenge.required_tools.filter((tool) => !seenTools.has(tool));

    const nonceRows = await db
      .select({ id: agentCooperativeLog.id })
      .from(agentCooperativeLog)
      .where(and(
        eq(agentCooperativeLog.org_id, user.org_id),
        eq(agentCooperativeLog.employee_id, id),
        gte(agentCooperativeLog.created_at, challenge.started_at),
        or(
          sql`${agentCooperativeLog.summary} ILIKE ${`%${challenge.nonce}%`}`,
          sql`COALESCE(${agentCooperativeLog.metadata}::text, '') ILIKE ${`%${challenge.nonce}%`}`,
        ),
      ))
      .limit(1);
    const nonce_seen = nonceRows.length > 0;
    const completed = missingTools.length === 0 && nonce_seen;
    const stages = buildCertificationStages({
      employee,
      missingTools,
      nonceSeen: nonce_seen,
      auditCount: auditRows.length,
      completed,
    });
    const failureReason = certificationFailureReason({
      employee,
      missingTools,
      nonceSeen: nonce_seen,
      auditCount: auditRows.length,
    });

    if (completed) {
      const now = new Date();
      await db
        .update(agentCertificationChallenges)
        .set({ status: 'completed', completed_at: now, failure_reason: null })
        .where(eq(agentCertificationChallenges.id, challenge.id));
      await db
        .update(agentEmployees)
        .set({ certification_status: 'verified', last_verified_at: now })
        .where(and(eq(agentEmployees.id, id), eq(agentEmployees.org_id, user.org_id)));
    } else {
      await db
        .update(agentCertificationChallenges)
        .set({ failure_reason: failureReason, updated_at: new Date() })
        .where(eq(agentCertificationChallenges.id, challenge.id));
    }

    return c.json({
      status: completed ? 'completed' : 'pending',
      completed,
      missing_tools: missingTools,
      nonce_seen,
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
    const user = c.get('user');
    const id = c.req.param('id');

    const [employee] = await db
      .select()
      .from(agentEmployees)
      .where(and(eq(agentEmployees.id, id), eq(agentEmployees.org_id, user.org_id)))
      .limit(1);
    if (!employee) return c.json({ error: 'Agent employee not found', code: 'NOT_FOUND' }, 404);

    await db.execute(sql`
      UPDATE agent_certification_challenges
      SET status = 'reset',
          failure_reason = 'Reset by operator',
          completed_at = now(),
          updated_at = now()
      WHERE org_id = ${user.org_id}
        AND employee_id = ${id}
        AND status = 'pending'
    `);
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
    const user = c.get('user');
    const id = c.req.param('id');

    const [employee] = await db
      .select()
      .from(agentEmployees)
      .where(and(eq(agentEmployees.id, id), eq(agentEmployees.org_id, user.org_id)))
      .limit(1);
    if (!employee) return c.json({ error: 'Agent employee not found', code: 'NOT_FOUND' }, 404);

    const role = await getOrgRole(user.id, user.org_id);
    const isCreator = employee.created_by === user.id;
    if (role !== 'owner' && role !== 'admin' && !isCreator) {
      return c.json(
        { error: 'Only owners, admins, or the employee creator can regenerate an employee token', code: 'FORBIDDEN' },
        403,
      );
    }

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
    const user = c.get('user');
    const id = c.req.param('id');

    const [employee] = await db
      .select()
      .from(agentEmployees)
      .where(and(eq(agentEmployees.id, id), eq(agentEmployees.org_id, user.org_id)))
      .limit(1);
    if (!employee) return c.json({ error: 'Agent employee not found', code: 'NOT_FOUND' }, 404);

    const role = await getOrgRole(user.id, user.org_id);
    const isCreator = employee.created_by === user.id;
    if (role !== 'owner' && role !== 'admin' && !isCreator) {
      return c.json(
        { error: 'Only owners, admins, or the employee creator can regenerate a channel token', code: 'FORBIDDEN' },
        403,
      );
    }

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
    const user = c.get('user');
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const cloneSchema = z.object({
      name: z.string().min(1).max(200).optional(),
      slug: z.string().min(2).max(64).regex(/^[a-z0-9-]+$/).optional(),
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
    if (!source) return c.json({ error: 'Agent employee not found', code: 'NOT_FOUND' }, 404);

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

